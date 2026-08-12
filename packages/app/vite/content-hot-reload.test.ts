// @vitest-environment node
// This is the dev server's half of the content watcher: it reads the disk and
// never touches a DOM, so it runs outside jsdom — which also keeps
// `import.meta.url` a real file URL.
import { fileURLToPath } from 'node:url';
import { CONTENT_FILE_NAMES, validateContent } from '@printhead/core';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_FILES,
  contentHotReload,
  isContentFile,
  readRawContent,
} from './content-hot-reload.js';

const contentDir = fileURLToPath(new URL('../../core/content', import.meta.url));

describe('the dev content watcher (spec §11)', () => {
  it('reads a set the validator accepts, straight off disk', () => {
    const validation = validateContent(readRawContent(contentDir) as never);
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('watches exactly the files core bundles — no more, no fewer', () => {
    // If these drift, the watcher would push a set missing a file and the
    // client would reject every edit while blaming the edit.
    expect([...CONTENT_FILES].sort()).toEqual([...CONTENT_FILE_NAMES].sort());
  });

  it('ignores changes to anything that is not a content file', () => {
    expect(isContentFile(contentDir, `${contentDir}/pacing.json`)).toBe(true);
    expect(isContentFile(contentDir, `${contentDir}/notes.md`)).toBe(false);
    expect(isContentFile(contentDir, `${contentDir}/scratch.json`)).toBe(false);
    expect(isContentFile(contentDir, '/somewhere/else/pacing.json')).toBe(false);
    // A sibling directory whose path merely starts with the same characters.
    expect(isContentFile(contentDir, `${contentDir}-backup/pacing.json`)).toBe(false);
  });

  it('only installs itself on the dev server', () => {
    const plugin = contentHotReload({ contentDir });
    expect(plugin.name).toBe('printhead:content-hot-reload');
    expect(plugin.apply).toBe('serve');
  });

  it('pushes the whole set on a change and stays quiet about other files', () => {
    const sent: { event: string; data: unknown }[] = [];
    const handlers = new Map<string, (file: string) => void>();
    const server = {
      watcher: {
        add: () => undefined,
        on: (event: string, handler: (file: string) => void) => {
          handlers.set(event, handler);
        },
      },
      ws: { send: (message: { event: string; data: unknown }) => sent.push(message) },
      config: { logger: { info: () => undefined, warn: () => undefined } },
    };
    const plugin = contentHotReload({ contentDir });
    const configureServer = plugin.configureServer;
    if (typeof configureServer !== 'function') {
      throw new TypeError('the plugin must configure the dev server');
    }
    configureServer.call({} as never, server as never);

    handlers.get('change')?.(`${contentDir}/readme.txt`);
    expect(sent).toEqual([]);

    handlers.get('change')?.(`${contentDir}/pacing.json`);
    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]?.data as Record<string, unknown>).sort()).toEqual(
      [...CONTENT_FILES].sort(),
    );
  });
});
