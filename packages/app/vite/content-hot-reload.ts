import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Content hot-reload, server half (spec §11: "Content is hot-reloadable in dev
 * — Vite watch → sim swaps defs live — this powers both the editor (§14) and
 * fast agent iteration").
 *
 * The whole raw content set is pushed on every change rather than a diff: the
 * client validates it as a set anyway (cross-file references), and a partial
 * update could never be validated on its own.
 */
export const CONTENT_HMR_EVENT = 'printhead:content';

/** Mirrors `core/src/content/raw.ts`; the validator rejects a mismatch. */
export const CONTENT_FILES = [
  'pacing',
  'start',
  'curves',
  'materials',
  'objects',
  'printers',
  'upgrades',
  'slots',
  'forks',
  'designs',
  'market',
  'automation',
  'failure',
  'prestige',
  'endgame',
] as const;

export function readRawContent(contentDir: string): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const name of CONTENT_FILES) {
    raw[name] = JSON.parse(readFileSync(resolve(contentDir, `${name}.json`), 'utf8')) as unknown;
  }
  return raw;
}

export function isContentFile(contentDir: string, file: string): boolean {
  const dir = resolve(contentDir);
  return (
    file.startsWith(`${dir}/`) &&
    file.endsWith('.json') &&
    CONTENT_FILES.some((name) => file.endsWith(`/${name}.json`))
  );
}

export interface ContentHotReloadOptions {
  readonly contentDir: string;
}

export function contentHotReload(options: ContentHotReloadOptions): Plugin {
  const { contentDir } = options;
  return {
    name: 'printhead:content-hot-reload',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.watcher.add(resolve(contentDir));
      const push = (file: string): void => {
        if (!isContentFile(contentDir, file)) {
          return;
        }
        try {
          server.ws.send({
            type: 'custom',
            event: CONTENT_HMR_EVENT,
            data: readRawContent(contentDir),
          });
          server.config.logger.info(`[printhead] content reloaded (${file.split('/').pop()})`);
        } catch (error) {
          // A file caught mid-write is normal; the next event will be complete.
          server.config.logger.warn(`[printhead] content not readable yet: ${String(error)}`);
        }
      };
      server.watcher.on('change', push);
      server.watcher.on('add', push);
    },
  };
}
