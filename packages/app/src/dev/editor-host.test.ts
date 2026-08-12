import 'fake-indexeddb/auto';
import { RAW_CONTENT, createMutableContentSource } from '@printhead/core';
import { createMemoryPlatform } from '@printhead/platform';
import { describe, expect, it, vi } from 'vitest';
import { type BootedGame, bootGame } from '../boot.js';
import { createEditorHost } from './editor-host.js';

/**
 * The app's half of the editor contract (spec §14). The panel is tested against
 * a fake host in `@printhead/editor`; what is tested here is that the *real*
 * host does what the panel assumes — including the two powers that only exist
 * in dev, the time warp and the phase jump.
 */
async function boot(): Promise<{
  game: BootedGame;
  source: ReturnType<typeof createMutableContentSource>;
}> {
  const platform = createMemoryPlatform(1_000_000);
  const source = createMutableContentSource();
  const game = await bootGame({ platform, contentSource: source, autoStart: false });
  return { game, source };
}

describe('createEditorHost', () => {
  it('reads the raw documents, not the parsed model', async () => {
    const { game, source } = await boot();
    const host = createEditorHost({ game, source });
    expect(host.getRawContent().pacing).toBe(RAW_CONTENT.pacing);
  });

  it('hot-applies valid content to the running simulation', async () => {
    const { game, source } = await boot();
    const host = createEditorHost({ game, source });
    const raw = structuredClone(RAW_CONTENT);
    (raw.pacing as { targetHours: number }).targetHours = 4;
    expect(host.applyContent(raw).ok).toBe(true);
    expect(game.store.getContent().pacing.targetHours).toBe(4);
  });

  it('rejects invalid content and leaves the game on the last good set', async () => {
    const { game, source } = await boot();
    const host = createEditorHost({ game, source });
    const raw = structuredClone(RAW_CONTENT);
    (raw.pacing as { targetHours: number }).targetHours = 0;
    expect(host.applyContent(raw).ok).toBe(false);
    expect(game.store.getContent().pacing.targetHours).toBe(8);
  });

  it('posts a write to the dev endpoint and reports what came back', async () => {
    const { game, source } = await boot();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, message: 'wrote pacing.json' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const host = createEditorHost({ game, source, fetchImpl });
    const result = await host.writeContent('pacing', RAW_CONTENT.pacing);
    expect(result).toEqual({ ok: true, message: 'wrote pacing.json' });
  });

  it('reports a rejected write rather than pretending it landed', async () => {
    const { game, source } = await boot();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, message: 'nope' }), { status: 422 }),
    ) as unknown as typeof fetch;
    const host = createEditorHost({ game, source, fetchImpl });
    expect(await host.writeContent('pacing', {})).toEqual({ ok: false, message: 'nope' });
  });

  it('survives the dev server being gone', async () => {
    const { game, source } = await boot();
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const host = createEditorHost({ game, source, fetchImpl });
    const result = await host.writeContent('pacing', {});
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ECONNREFUSED');
  });

  it('pauses and resumes the real loop', async () => {
    const { game, source } = await boot();
    const host = createEditorHost({ game, source });
    expect(host.isPaused()).toBe(true);
    host.setPaused(false);
    expect(game.loop.isRunning()).toBe(true);
    host.setPaused(true);
    expect(game.loop.isRunning()).toBe(false);
    await game.shutdown();
  });

  /**
   * The warp multiplies wall time *on top of* pace (spec §8/§14): the same
   * frame, the same reducer, the same `paceScale` — the loop is simply told a
   * larger gap elapsed, exactly as a stalled tab would.
   */
  it('warps time without touching the pace mapping', async () => {
    const { game, source } = await boot();
    const host = createEditorHost({ game, source });
    const platform = game.platform;
    expect(host.getTimeScale()).toBe(1);

    platform.clock.nowMs();
    (platform.clock as unknown as { advance(ms: number): void }).advance(1000);
    game.loop.frame();
    const normal = game.store.getState().simTimeMs;

    host.setTimeScale(10);
    (platform.clock as unknown as { advance(ms: number): void }).advance(1000);
    game.loop.frame();
    const warped = game.store.getState().simTimeMs - normal;

    expect(host.getTimeScale()).toBe(10);
    expect(warped).toBeCloseTo(normal * 10, 6);
    // The pace mapping is untouched — targetHours still says what it said.
    expect(game.store.getContent().pacing.targetHours).toBe(8);
  });

  it('refuses a nonsensical warp', async () => {
    const { game, source } = await boot();
    const host = createEditorHost({ game, source });
    expect(() => host.setTimeScale(0)).toThrow(RangeError);
    expect(() => host.setTimeScale(Number.NaN)).toThrow(RangeError);
  });

  it('jumps the FSM into a phase the gate has not opened', async () => {
    const { game, source } = await boot();
    const host = createEditorHost({ game, source });
    expect(host.getState().phaseId).toBe('intro');
    host.jumpToPhase('studio');
    expect(host.getState().phaseId).toBe('studio');
    expect(host.getVisualState().phaseName).toBe('Studio');
  });

  it('exports and re-imports the save', async () => {
    const { game, source } = await boot();
    const host = createEditorHost({ game, source });
    host.jumpToPhase('farm');
    const json = host.exportSave();
    host.jumpToPhase('intro');
    expect(host.importSave(json)).toEqual({ ok: true, message: 'save loaded' });
    expect(host.getState().phaseId).toBe('farm');
  });

  it('reports a corrupt import instead of throwing at the panel', async () => {
    const { game, source } = await boot();
    const host = createEditorHost({ game, source });
    const result = host.importSave('{not json');
    expect(result.ok).toBe(false);
    expect(host.getState().phaseId).toBe('intro');
  });
});
