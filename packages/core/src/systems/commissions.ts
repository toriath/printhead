import { indexById } from '../content/load.js';
import type { Content } from '../content/schema.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import type { EventSink } from '../events/types.js';
import { hashUnit } from '../rng/mulberry32.js';
import type { CommissionState, GameState } from '../state/game-state.js';
import { isPhaseReached } from './phases.js';
import { withResource } from './resources.js';
import { isInstalled } from './upgrades.js';

/**
 * The commission board (content: `commissions.json`). Clients post orders —
 * so many of an object in a material, before a deadline — and pay a bonus on
 * delivery. Every finished print counts towards every matching order, so the
 * player's decision is *which* order to chase with which bay, never a click per
 * delivery.
 *
 * Offers are drawn from a hash of the run's seed and the board's issue counter,
 * not from the rng stream, so the board is a pure function of the save and
 * replaying from any point offers the same clients the same jobs.
 */

export type CommissionTemplate = Content['commissions']['templates'][number];

const NONE = 0;
const ONE = 1;

export function isBoardOpen(state: GameState, content: Content): boolean {
  return isPhaseReached(content.pacing.phases, state.phaseId, content.commissions.unlockPhaseId);
}

export function commissionTemplate(
  content: Content,
  templateId: string,
): CommissionTemplate | undefined {
  return indexById(content.commissions.templates).get(templateId);
}

/** Templates the workshop could actually deliver right now, and not already posted. */
export function offerableTemplates(
  state: GameState,
  content: Content,
): readonly CommissionTemplate[] {
  const phases = content.pacing.phases;
  const materials = indexById(content.materials);
  const objects = indexById(content.objects);
  const posted = new Set(state.commissions.open.map((offer) => offer.templateId));
  return content.commissions.templates.filter((template) => {
    const material = materials.get(template.materialId);
    const object = objects.get(template.objectId);
    return (
      material !== undefined &&
      object !== undefined &&
      !posted.has(template.id) &&
      isPhaseReached(phases, state.phaseId, template.unlockPhaseId) &&
      isPhaseReached(phases, state.phaseId, material.unlockPhaseId) &&
      isPhaseReached(phases, state.phaseId, object.unlockPhaseId) &&
      (material.requiresUpgradeId === null || isInstalled(state, material.requiresUpgradeId))
    );
  });
}

/** What delivering a commission pays, in money (inflation included). */
export function commissionReward(
  content: Content,
  template: CommissionTemplate,
  inflation: number,
): number {
  const material = indexById(content.materials).get(template.materialId);
  const object = indexById(content.objects).get(template.objectId);
  if (material === undefined || object === undefined) {
    return NONE;
  }
  return (
    template.count *
    object.basePartValue *
    material.valueMultiplier *
    template.rewardMultiplier *
    inflation
  );
}

function pick<T>(entries: readonly T[], label: string, seed: number): T | undefined {
  return entries[Math.floor(hashUnit(label, seed) * entries.length)];
}

/**
 * Run the board's clocks: deadlines run down and expire, and a fresh offer is
 * posted whenever the board has room and the offer clock comes round.
 */
export function tickCommissions(
  state: GameState,
  content: Content,
  dtMs: number,
  emit: EventSink | undefined,
): GameState {
  if (!isBoardOpen(state, content)) {
    return state;
  }
  const board = state.commissions;
  const kept: CommissionState[] = [];
  for (const offer of board.open) {
    const remainingMs = offer.remainingMs - dtMs;
    if (remainingMs <= NONE) {
      emit?.({
        type: 'COMMISSION_EXPIRED',
        simTimeMs: state.simTimeMs,
        serial: offer.serial,
        templateId: offer.templateId,
      });
      continue;
    }
    kept.push({ ...offer, remainingMs });
  }
  let next: GameState = {
    ...state,
    commissions: { ...board, open: kept, nextOfferMs: board.nextOfferMs - dtMs },
  };
  const { boardSize, offerEveryDesignSeconds, clients } = content.commissions;
  if (next.commissions.nextOfferMs > NONE || next.commissions.open.length >= boardSize) {
    return next;
  }
  const everyMs = offerEveryDesignSeconds * MS_PER_SECOND;
  const issued = next.commissions.issued;
  const template = pick(offerableTemplates(next, content), `commission:${issued}`, state.rng.seed);
  const client = pick(clients, `commission-client:${issued}`, state.rng.seed);
  if (template === undefined || client === undefined) {
    return { ...next, commissions: { ...next.commissions, nextOfferMs: everyMs } };
  }
  const offer: CommissionState = {
    serial: issued + ONE,
    templateId: template.id,
    clientId: client.id,
    delivered: NONE,
    remainingMs: template.timeLimitDesignSeconds * MS_PER_SECOND,
  };
  emit?.({
    type: 'COMMISSION_OFFERED',
    simTimeMs: state.simTimeMs,
    serial: offer.serial,
    templateId: template.id,
    clientId: client.id,
  });
  next = {
    ...next,
    commissions: {
      open: [...next.commissions.open, offer],
      nextOfferMs: everyMs,
      issued: issued + ONE,
    },
  };
  return next;
}

/**
 * Count freshly printed Parts towards every matching order, and pay out the
 * ones that are now complete. The Parts stay the player's: a commission is a
 * bonus for printing the right thing, not a sale.
 */
export function creditCommissions(
  state: GameState,
  content: Content,
  materialId: string,
  objectId: string,
  parts: number,
  inflation: number,
  emit: EventSink | undefined,
): GameState {
  if (parts <= NONE || state.commissions.open.length === NONE) {
    return state;
  }
  let money = NONE;
  let completed = NONE;
  const open: CommissionState[] = [];
  for (const offer of state.commissions.open) {
    const template = commissionTemplate(content, offer.templateId);
    if (
      template === undefined ||
      template.materialId !== materialId ||
      template.objectId !== objectId
    ) {
      open.push(offer);
      continue;
    }
    const delivered = offer.delivered + parts;
    if (delivered < template.count) {
      open.push({ ...offer, delivered });
      continue;
    }
    const reward = commissionReward(content, template, inflation);
    money += reward;
    completed += ONE;
    emit?.({
      type: 'COMMISSION_COMPLETED',
      simTimeMs: state.simTimeMs,
      serial: offer.serial,
      templateId: offer.templateId,
      clientId: offer.clientId,
      reward,
    });
  }
  return {
    ...state,
    resources: withResource(state.resources, 'money', money),
    commissions: { ...state.commissions, open },
    stats: {
      ...state.stats,
      moneyEarned: state.stats.moneyEarned + money,
      commissionsCompleted: state.stats.commissionsCompleted + completed,
    },
  };
}
