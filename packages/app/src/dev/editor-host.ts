import {
  type ContentFileName,
  type ContentValidation,
  type GameState,
  type MutableContentSource,
  type RawContent,
  type VisualState,
  deserializeSave,
  serializeSave,
} from '@printhead/core';
import type { ContentWriteResult, EditorHost } from '@printhead/editor';
import type { BootedGame } from '../boot.js';

/**
 * The app's half of the editor contract (spec §14). Lives under `src/dev/` and
 * is only ever imported from a dynamic `import.meta.env.DEV` branch, so the
 * production bundle contains neither this nor the panel it feeds.
 *
 * Everything here is a thin adapter over things the shell already has. The one
 * genuinely dev-only power is {@link EditorHost.jumpToPhase}, which moves the
 * FSM pointer without satisfying the gate — a cheat, deliberately kept out of
 * the reducer so no shipped code path can perform it.
 */
export const CONTENT_WRITE_PATH = '/__printhead/content/';

export interface EditorHostOptions {
  readonly game: BootedGame;
  readonly source: MutableContentSource;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
}

export function createEditorHost(options: EditorHostOptions): EditorHost {
  const { game, source } = options;
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    getRawContent: () => source.raw(),
    applyContent: (raw: RawContent): ContentValidation => source.replace(raw),

    async writeContent(file: ContentFileName, value: unknown): Promise<ContentWriteResult> {
      try {
        const response = await doFetch(`${CONTENT_WRITE_PATH}${file}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
        });
        const body = (await response.json()) as ContentWriteResult;
        return { ok: response.ok && body.ok, message: body.message };
      } catch (error) {
        return { ok: false, message: `write failed: ${String(error)}` };
      }
    },

    getState: (): GameState => game.store.getState(),
    getVisualState: (): VisualState => game.store.getVisualState(),
    subscribe: (listener) => game.store.subscribe(listener),

    isPaused: () => !game.loop.isRunning(),
    setPaused(paused) {
      if (paused) {
        game.loop.stop();
      } else {
        game.loop.start();
      }
    },
    getTimeScale: () => game.loop.getTimeScale(),
    setTimeScale: (scale) => game.loop.setTimeScale(scale),

    jumpToPhase(phaseId) {
      const state = game.store.getState();
      game.store.replaceState({ ...state, phaseId, phaseEnteredAtMs: state.simTimeMs });
    },

    exportSave: () => serializeSave(game.store.getState(), game.platform.clock.nowMs()),
    importSave(json) {
      try {
        game.store.replaceState(deserializeSave(json));
        return { ok: true, message: 'save loaded' };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    },
  };
}
