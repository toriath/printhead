import {
  type Content,
  type GameState,
  type VisualState,
  requirementProgress,
} from '@printhead/core';
import type { ControlModel } from './controls-model.js';

/**
 * Nudges, not instructions. An idle game is learned by poking at it, so the
 * shell never tells the player what to do: `nextStep` only picks the one
 * control worth a gentle glow, and `layerProgress` fills the layer in the top
 * bar. Both read the projection and the phase's own data gate, so neither can
 * point at something the reducer would refuse.
 */

export type NextStepTarget =
  | 'attach'
  | 'configure'
  | 'print'
  | 'buy-filament'
  | 'sell'
  | 'spend'
  | null;

export interface NextStep {
  readonly text: string;
  /** The control the step is about, so the shell can highlight it. */
  readonly target: NextStepTarget;
}

/** The single most useful thing to do right now. */
export function nextStep(
  visual: VisualState,
  model: ControlModel,
  /** Bays stopped because their spool ran dry (see `starve.ts`). */
  starved: readonly string[] = [],
): NextStep {
  if (model.attach !== null) {
    return model.attach.enabled
      ? { text: `Drag the ${model.attach.label.toLowerCase()} onto printer #1.`, target: 'attach' }
      : {
          text: `The ${model.attach.label.toLowerCase()} is on the bench. It clips on in a moment.`,
          target: null,
        };
  }
  const bay = visual.slots.find((slot) => slot.slotId === model.slotId);
  // A dry spool outranks everything: nothing happens until it is fixed.
  if (starved.length > 0) {
    const dry = visual.slots.find((slot) => starved.includes(slot.slotId));
    const material = dry?.materialName ?? 'filament';
    return model.buyFilament?.enabled === true
      ? {
          text: `Out of ${material}! Buy a spool or the printer just sits there.`,
          target: 'buy-filament',
        }
      : model.canSell
        ? { text: `Out of ${material} and money: sell parts to buy a spool.`, target: 'sell' }
        : { text: `Out of ${material}. Nothing prints until there is more.`, target: null };
  }
  if (bay !== undefined && bay.printerCount > 0 && bay.materialId === null) {
    return { text: 'Load a material and an object into the bay.', target: 'configure' };
  }
  if (bay?.occupied && !bay.running && !bay.changingOver) {
    if (model.canPrint) {
      return { text: 'Press Print to start the bay.', target: 'print' };
    }
    if (model.buyFilament?.enabled === true) {
      return { text: 'Out of filament: buy a spool to keep printing.', target: 'buy-filament' };
    }
    if (model.canSell) {
      return { text: 'Out of filament and money: sell parts to buy a spool.', target: 'sell' };
    }
  }
  const affordable =
    model.buyPrinter?.enabled === true ||
    visual.upgrades.some((row) => row.available && row.affordable);
  if (affordable) {
    return { text: 'You can afford an upgrade or another printer.', target: 'spend' };
  }
  const order = visual.commissions.offers[0];
  if (order !== undefined) {
    return {
      text: `${order.clientName} wants ${order.count} ${order.materialName} ${order.objectName.toLowerCase()}s.`,
      target: null,
    };
  }
  if (model.canSell && visual.ledger.parts > 0) {
    return { text: 'Sell parts for money, or save them for the next machine.', target: 'sell' };
  }
  return { text: 'The workshop is printing. Overclock a bay to speed it up.', target: null };
}

/**
 * How close the current layer is to done, 0..1: the mean of its gate's
 * requirements, each capped at met. The top bar fills the layer it is
 * printing with this and says nothing more — what the next layer needs, and
 * what it is, the player finds out by playing.
 */
export function layerProgress(state: GameState, content: Content): number {
  const phase = content.pacing.phases.find((candidate) => candidate.id === state.phaseId);
  if (phase === undefined) {
    return 1;
  }
  const progress = requirementProgress(state, content, phase.advanceWhen);
  if (progress.length === 0) {
    return 0;
  }
  const sum = progress.reduce(
    (total, req) => total + (req.met ? 1 : Math.min(req.actual / req.atLeast, 1)),
    0,
  );
  return sum / progress.length;
}
