import type { MutableContentSource } from '@printhead/core';
import type { ReactElement } from 'react';
import { createElement } from 'react';
import type { BootedGame } from '../boot.js';
import { createEditorHost } from './editor-host.js';

/**
 * Loads the dev Editor panel (spec §14) as a **separate chunk**.
 *
 * The `import()` is what does the work: `@printhead/editor` is reachable only
 * from inside this function, and this function is only called from a
 * `import.meta.env.DEV` branch, so Rollup emits the panel as its own chunk and
 * a production build drops it entirely along with the dead branch. Importing
 * the panel at the top of `main.tsx` — even behind a runtime `if` — would pull
 * it into the main bundle instead.
 */
export interface MountEditorOptions {
  readonly game: BootedGame;
  readonly contentSource: MutableContentSource;
}

export async function mountEditor(options: MountEditorOptions): Promise<ReactElement | null> {
  try {
    const { EditorPanel } = await import('@printhead/editor');
    const host = createEditorHost({ game: options.game, source: options.contentSource });
    return createElement(EditorPanel, { host });
  } catch (error) {
    // A dev tool that stops the game from booting is worse than no dev tool.
    console.warn('[printhead] editor panel unavailable:', error);
    return null;
  }
}
