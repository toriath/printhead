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
 * The commission board (content: `commissions.json`). Clients come with
 * proposals — so many of an object in a material, before a deadline — and the
 * player takes them on or turns them down. An accepted order counts every
 * matching print towards it and pays a bonus on delivery; a client whose
 * orders keep arriving pays more the next time (loyalty), so a good client
 * turns into a standing contract. An unanswered proposal walks off when its
 * window closes.
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

/** How much more a client pays for having had `orders` delivered before. */
export function loyaltyMultiplier(content: Content, orders: number): number {
  const { loyaltyBonusPerOrder, loyaltyMaxOrders } = content.commissions;
  return ONE + loyaltyBonusPerOrder * Math.min(orders, loyaltyMaxOrders);
}

/** What delivering a commission pays, in money (inflation and loyalty included). */
export function commissionReward(
  content: Content,
  template: CommissionTemplate,
  inflation: number,
  loyalOrders = NONE,
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
    inflation *
    loyaltyMultiplier(content, loyalOrders)
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
    // A proposal first: the clock is the answer window, not the deadline.
    remainingMs: content.commissions.offerWindowDesignSeconds * MS_PER_SECOND,
    accepted: false,
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
      ...next.commissions,
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
  let loyalty = state.commissions.loyalty;
  const open: CommissionState[] = [];
  for (const offer of state.commissions.open) {
    const template = commissionTemplate(content, offer.templateId);
    if (
      !offer.accepted ||
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
    const reward = commissionReward(content, template, inflation, loyalty[offer.clientId] ?? NONE);
    money += reward;
    completed += ONE;
    loyalty = { ...loyalty, [offer.clientId]: (loyalty[offer.clientId] ?? NONE) + ONE };
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
    commissions: { ...state.commissions, open, loyalty },
    stats: {
      ...state.stats,
      moneyEarned: state.stats.moneyEarned + money,
      commissionsCompleted: state.stats.commissionsCompleted + completed,
    },
  };
}

/**
 * Answer a proposal: accept it and its deadline starts; decline it and the
 * client goes. Answering an order already taken on, or one not on the board,
 * is refused (`null`).
 */
export function answerProposal(
  state: GameState,
  content: Content,
  serial: number,
  accept: boolean,
  emit: EventSink | undefined,
): GameState | null {
  const offer = state.commissions.open.find((candidate) => candidate.serial === serial);
  const template = offer === undefined ? undefined : commissionTemplate(content, offer.templateId);
  if (offer === undefined || template === undefined || offer.accepted) {
    return null;
  }
  emit?.({
    type: 'COMMISSION_ANSWERED',
    simTimeMs: state.simTimeMs,
    serial,
    clientId: offer.clientId,
    accepted: accept,
  });
  const open = accept
    ? state.commissions.open.map((candidate) =>
        candidate.serial === serial
          ? {
              ...candidate,
              accepted: true,
              remainingMs: template.timeLimitDesignSeconds * MS_PER_SECOND,
            }
          : candidate,
      )
    : state.commissions.open.filter((candidate) => candidate.serial !== serial);
  return { ...state, commissions: { ...state.commissions, open } };
}
