import type {
  ContentFileName,
  ContentValidation,
  GameState,
  RawContent,
  ScalarResourceKind,
  VisualState,
} from '@printhead/core';

/**
 * What the editor needs from whoever is hosting it (spec §14).
 *
 * The editor is a *dev-only* package and must stay decoupled from the shell:
 * `app` depends on `editor`, so `editor` cannot depend on `app` without a
 * cycle. Everything the panel can do to the running game therefore arrives
 * through this interface, which also means the whole panel can be driven by a
 * fake host in tests — no store, no clock, no browser.
 */
export interface ContentWriteResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * One entry of the action-log tail (spec §14). The action itself plus when it
 * happened, in design time — the pair a `(seed, actionLog)` bug report needs
 * (spec §13).
 */
export interface LoggedAction {
  readonly type: string;
  readonly simTimeMs: number;
  readonly detail: string;
}

export interface EditorHost {
  /** The raw (unvalidated) content set currently driving the simulation. */
  getRawContent(): RawContent;
  /**
   * Hot-apply an edited content set. Invalid input is rejected and the last
   * good set is kept, so a half-typed number cannot take the game down.
   */
  applyContent(raw: RawContent): ContentValidation;
  /** Persist a file back to `packages/core/content/` through the dev server. */
  writeContent(file: ContentFileName, value: unknown): Promise<ContentWriteResult>;

  getState(): GameState;
  getVisualState(): VisualState;
  /** Re-render the panel when the game moves. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;

  // --- time controls (spec §14) ---------------------------------------------
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  /** Dev warp, applied **on top of** pace — never instead of it (spec §8). */
  getTimeScale(): number;
  setTimeScale(scale: number): void;

  /** Drop the FSM straight into a phase, for testing late-game content. */
  jumpToPhase(phaseId: string): void;
  /** The current save, as JSON, for export/import. */
  exportSave(): string;
  importSave(json: string): ContentWriteResult;

  // --- state tools (spec §14) -----------------------------------------------
  /** The most recent player actions, oldest first. Ticks are not actions here. */
  getActionLog(): readonly LoggedAction[];
  /** Re-seed the deterministic stream, and rewind its position to the start. */
  setSeed(seed: number): void;
  /** Hand the workshop a resource outright — the cheat, named as one. */
  grantResource(kind: ScalarResourceKind, amount: number): void;
}
