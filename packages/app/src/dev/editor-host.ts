import {
  type Action,
  type ContentFileName,
  type ContentValidation,
  type GameState,
  type MutableContentSource,
  type RawContent,
  type ScalarResourceKind,
  type VisualState,
  createRng,
  deserializeSave,
  serializeSave,
} from '@printhead/core';
import type { ContentWriteResult, EditorHost, LoggedAction } from '@printhead/editor';
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

/**
 * How many entries the action-log tail keeps (spec §14). A tail, not a
 * transcript: the panel is for "what did I just click?", and an unbounded log
 * in a dev session that runs for hours is a memory leak with a UI.
 */
export const ACTION_LOG_LIMIT = 50;

/** Everything about an action except its `type`, rendered for the tail. */
function describeAction(action: Action): string {
  const { type: _type, ...rest } = action as Record<string, unknown> & { type: string };
  const parts = Object.entries(rest).map(
    ([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
  );
  return parts.join(' ');
}

export interface EditorHostOptions {
  readonly game: BootedGame;
  readonly source: MutableContentSource;
  /** Injected so tests need no network. */
  readonly fetchImpl?: typeof fetch;
}

export function createEditorHost(options: EditorHostOptions): EditorHost {
  const { game, source } = options;
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const actionLog: LoggedAction[] = [];
  game.store.onAction((action) => {
    actionLog.push({
      type: action.type,
      simTimeMs: game.store.getState().simTimeMs,
      detail: describeAction(action),
    });
    if (actionLog.length > ACTION_LOG_LIMIT) {
      actionLog.splice(0, actionLog.length - ACTION_LOG_LIMIT);
    }
  });

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

    getActionLog: () => actionLog,

    setSeed(seed) {
      // A fresh stream at the new seed, rewound to position zero: "reset the
      // seed" has to mean the same run is reproducible from here, not that the
      // old stream carries on under a new name.
      game.store.replaceState({ ...game.store.getState(), rng: createRng(seed).snapshot() });
    },

    grantResource(kind: ScalarResourceKind, amount) {
      const state = game.store.getState();
      const next = Math.max(state.resources[kind] + amount, 0);
      game.store.replaceState({
        ...state,
        resources: { ...state.resources, [kind]: next },
        // Parts, Scrap and Products carry a banked money value beside their
        // count (spec §5D). A cheat that granted the count alone would make a
        // Part worth nothing, so the granted stock is valued at what the
        // existing stock is worth — and at nothing when there is none.
        ...valueFor(state, kind, next),
      });
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

/**
 * Keep a valued pool's banked money in step with a granted count. The unit
 * value of what is already there is the only honest price for more of it.
 */
function valueFor(state: GameState, kind: ScalarResourceKind, next: number): Partial<GameState> {
  const scale = (count: number, value: number): number => (count <= 0 ? 0 : (value / count) * next);
  if (kind === 'parts') {
    return { partsValue: scale(state.resources.parts, state.partsValue) };
  }
  if (kind === 'scrap') {
    return { scrapValue: scale(state.resources.scrap, state.scrapValue) };
  }
  if (kind === 'products') {
    return { productsValue: scale(state.resources.products, state.productsValue) };
  }
  return {};
}
