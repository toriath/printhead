import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Connect, Plugin, ViteDevServer } from 'vite';
import type { ZodTypeAny } from 'zod';

/**
 * Editor write-back (spec §14): "in dev, a small Vite middleware endpoint
 * writes edited defs back to `content/*.json` (formatted, schema-validated) —
 * manual tweaks land in the same files the auto-tuner writes".
 *
 * Three deliberate limits:
 *
 * - **`apply: 'serve'`.** The endpoint exists only under `vite dev`. A build
 *   never contains it, so no production deployment can be talked into writing
 *   to the repository.
 * - **The file name is checked against the schema map, not concatenated.** Only
 *   the names `CONTENT_FILE_SCHEMAS` knows are writable, which makes
 *   `../../etc/passwd` an unknown content file rather than a path.
 * - **The payload is parsed by that file's zod schema before it is written.**
 *   Invalid content is rejected with the issue; the file on disk is never
 *   touched. The full cross-file reference check still happens on load, which
 *   is where it belongs — one file cannot be validated against the others in
 *   isolation.
 *
 * The schema map is fetched through `server.ssrLoadModule` rather than
 * imported at the top of this file. A Vite config is loaded by Node, and
 * `@printhead/core` exports TypeScript source (the monorepo has no build step
 * for internal packages), so a static import would make the config itself
 * unloadable. Vite's module runner transpiles it on demand, which is exactly
 * the seam that exists for this.
 */
export const CONTENT_WRITE_PATH = '/__printhead/content/';

/** Bodies are small JSON documents; anything larger is not a content file. */
const MAX_BODY_BYTES = 1_000_000;

export type ContentSchemaMap = Readonly<Record<string, ZodTypeAny>>;

export interface ContentWriteBackOptions {
  readonly contentDir: string;
}

export function isWritableContentFile(schemas: ContentSchemaMap, name: string): boolean {
  return Object.hasOwn(schemas, name);
}

async function readBody(request: Connect.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('content payload is too large to be a content file');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface WriteOutcome {
  readonly status: number;
  readonly body: { readonly ok: boolean; readonly message: string };
}

/** The endpoint's whole decision, extracted so it is testable without a server. */
export function validateWrite(
  schemas: ContentSchemaMap,
  name: string,
  payload: unknown,
): WriteOutcome {
  if (!isWritableContentFile(schemas, name)) {
    return { status: 404, body: { ok: false, message: `unknown content file: ${name}` } };
  }
  const schema = schemas[name] as ZodTypeAny;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') ?? '(root)';
    return {
      status: 422,
      body: { ok: false, message: `rejected — ${path}: ${issue?.message ?? 'invalid'}` },
    };
  }
  return { status: 200, body: { ok: true, message: `wrote ${name}.json` } };
}

export function contentWriteBack(options: ContentWriteBackOptions): Plugin {
  const contentDir = resolve(options.contentDir);
  let schemas: ContentSchemaMap | null = null;

  const loadSchemas = async (server: ViteDevServer): Promise<ContentSchemaMap> => {
    if (schemas === null) {
      const core = (await server.ssrLoadModule('@printhead/core')) as {
        CONTENT_FILE_SCHEMAS: ContentSchemaMap;
      };
      schemas = core.CONTENT_FILE_SCHEMAS;
    }
    return schemas;
  };

  return {
    name: 'printhead:content-write-back',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(CONTENT_WRITE_PATH, (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }
        const name = (request.url ?? '').replace(/^\//, '').split('?')[0] ?? '';
        const send = (outcome: WriteOutcome): void => {
          response.statusCode = outcome.status;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(outcome.body));
        };
        void (async () => {
          try {
            const payload = JSON.parse(await readBody(request)) as unknown;
            const outcome = validateWrite(await loadSchemas(server), name, payload);
            if (outcome.status === 200) {
              writeFileSync(
                resolve(contentDir, `${name}.json`),
                `${JSON.stringify(payload, null, 2)}\n`,
              );
              server.config.logger.info(`[printhead] editor wrote ${name}.json`);
            }
            send(outcome);
          } catch (error) {
            send({ status: 400, body: { ok: false, message: String(error) } });
          }
        })();
      });
    },
  };
}
