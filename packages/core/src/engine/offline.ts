import type { Content } from '../content/schema.js';
import { countEventsByType, createEventBus } from '../events/bus.js';
import type { DomainEvent, DomainEventType } from '../events/types.js';
import { restoreRng } from '../rng/mulberry32.js';
import type { GameState, ReduceContext } from '../state/game-state.js';
import { reduce } from '../state/reduce.js';
import { advanceOffline } from './loop.js';
import { createPaceMapping } from './pace.js';

/**
 * Offline progress (spec §7.4): a deterministic chunked fast-forward through
 * the *same* reducer and the *same* pace mapping as the live loop, capped by
 * `pacing.offlineCapHours`, returning the summary the "welcome back" screen
 * shows. There is no separate offline economy — that is the whole point.
 */
export interface OfflineGains {
  readonly parts: number;
  readonly money: number;
  readonly scrap: number;
  readonly printsCompleted: number;
  readonly partsProduced: number;
}

export interface OfflineSummary {
  readonly appliedWallMs: number;
  readonly skippedWallMs: number;
  readonly cappedHours: number;
  readonly ticks: number;
  readonly chunks: number;
  readonly simElapsedMs: number;
  readonly fromPhaseId: string;
  readonly toPhaseId: string;
  readonly gains: OfflineGains;
  readonly eventCounts: Readonly<Partial<Record<DomainEventType, number>>>;
}

export interface OfflineCatchUpInput {
  readonly state: GameState;
  readonly content: Content;
  readonly wallElapsedMs: number;
  readonly nowMs: number;
  readonly carrySimMs?: number;
  readonly chunkWallMs?: number;
}

export interface OfflineCatchUpResult {
  readonly state: GameState;
  readonly carrySimMs: number;
  readonly summary: OfflineSummary;
  readonly events: readonly DomainEvent[];
}

export function runOfflineCatchUp(input: OfflineCatchUpInput): OfflineCatchUpResult {
  const { state, content } = input;
  const pace = createPaceMapping(content.pacing);
  const bus = createEventBus();

  const result = advanceOffline({
    state,
    carrySimMs: input.carrySimMs ?? 0,
    wallElapsedMs: input.wallElapsedMs,
    pace,
    capHours: content.pacing.offlineCapHours,
    ...(input.chunkWallMs === undefined ? {} : { chunkWallMs: input.chunkWallMs }),
    tick: (current, simDtMs) => {
      const ctx: ReduceContext = {
        content,
        nowMs: input.nowMs,
        rng: restoreRng(current.rng),
        emit: bus.emit,
      };
      return reduce(current, { type: 'TICK', simDtMs }, ctx);
    },
  });

  const events = bus.drain();
  const next = result.state;
  return {
    state: next,
    carrySimMs: result.carrySimMs,
    events,
    summary: {
      appliedWallMs: result.appliedWallMs,
      skippedWallMs: result.skippedWallMs,
      cappedHours: content.pacing.offlineCapHours,
      ticks: result.ticks,
      chunks: result.chunks,
      simElapsedMs: next.simTimeMs - state.simTimeMs,
      fromPhaseId: state.phaseId,
      toPhaseId: next.phaseId,
      gains: {
        parts: next.resources.parts - state.resources.parts,
        money: next.resources.money - state.resources.money,
        scrap: next.resources.scrap - state.resources.scrap,
        printsCompleted: next.stats.printsCompleted - state.stats.printsCompleted,
        partsProduced: next.stats.partsProduced - state.stats.partsProduced,
      },
      eventCounts: countEventsByType(events),
    },
  };
}
