import type { Page } from '@playwright/test';

/**
 * The E2E driver.
 *
 * Everything here goes through the dev test seam the app installs under
 * `import.meta.env.DEV` (`packages/app/src/dev/hooks.ts`). The seam does two
 * things and no more: it freezes the wall clock and it lets a test step the
 * frame loop. No rule is bypassed — a warped intro still needs seven clicks,
 * and the reducer still refuses anything the phase FSM forbids.
 *
 * Note the literal `window.__PRINTHEAD__` inside every `page.evaluate`: those
 * function bodies are serialised to the browser, so they cannot close over a
 * constant defined here.
 */
export const BOOT_KEY = '__PRINTHEAD_BOOT__';
export const HOOKS_KEY = '__PRINTHEAD__';

/** A fixed wall-clock origin, so every run is byte-identical. */
export const T0 = 1_700_000_000_000;

interface ContentShape {
  readonly start: { readonly assemblyPieces: readonly { readonly id: string }[] };
  readonly objects: readonly { readonly printDesignSeconds: number }[];
  readonly pacing: { readonly offlineCapHours: number; readonly targetHours: number };
}

interface DevHooksShape {
  warp(wallMs: number): void;
  nowMs(): number;
  snapshot(): unknown;
  saveNow(): Promise<void>;
  pause(): void;
  resume(): void;
  game: { store: { getContent(): ContentShape } };
}

declare global {
  interface Window {
    __PRINTHEAD__?: DevHooksShape;
    __PRINTHEAD_BOOT__?: { nowMs?: number; paused?: boolean };
  }
}

export interface BootOptions {
  readonly nowMs?: number;
  readonly paused?: boolean;
}

/** Load the game with a frozen clock. Must run before the page's own scripts. */
export async function bootGame(page: Page, options: BootOptions = {}): Promise<void> {
  const boot = { nowMs: options.nowMs ?? T0, paused: options.paused ?? false };
  await page.addInitScript((value) => {
    window.__PRINTHEAD_BOOT__ = value;
  }, boot);
  await page.goto('/');
  await waitForHooks(page);
}

export async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__PRINTHEAD__ !== undefined);
}

/** Advance wall-clock time and run one frame — the whole loop, instantly. */
export async function warp(page: Page, wallMs: number): Promise<void> {
  await page.evaluate((ms) => {
    window.__PRINTHEAD__?.warp(ms);
  }, wallMs);
}

/** The platform clock as the page sees it — the basis for an exact offline gap. */
export async function nowMs(page: Page): Promise<number> {
  const now = await page.evaluate(() => window.__PRINTHEAD__?.nowMs());
  if (now === undefined) {
    throw new Error('the dev test seam is not installed on this page');
  }
  return now;
}

export async function snapshot(page: Page): Promise<unknown> {
  return page.evaluate(() => window.__PRINTHEAD__?.snapshot());
}

export async function saveNow(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__PRINTHEAD__?.saveNow();
  });
}

export async function pause(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__PRINTHEAD__?.pause();
  });
}

export async function content(page: Page): Promise<ContentShape> {
  const raw = await page.evaluate(() => window.__PRINTHEAD__?.game.store.getContent());
  if (raw === undefined) {
    throw new Error('the dev test seam is not installed on this page');
  }
  return raw;
}

const MS_PER_SECOND = 1000;

/** Click through the whole intro assembly, waiting out each piece's bench work. */
export async function assemblePrinter(page: Page): Promise<void> {
  const pieces = await page.evaluate(
    () =>
      window.__PRINTHEAD__?.game.store
        .getContent()
        .start.assemblyPieces.map(
          (piece) => (piece as unknown as { attachDesignSeconds: number }).attachDesignSeconds,
        ) ?? [],
  );
  for (const seconds of pieces) {
    await warp(page, seconds * MS_PER_SECOND);
    await page.getByTestId('attach').click();
  }
}
