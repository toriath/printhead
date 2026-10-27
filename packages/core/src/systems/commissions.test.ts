import { describe, expect, it } from 'vitest';
import { MS_PER_SECOND } from '../engine/constants.js';
import { collectEvents } from '../events/bus.js';
import { TEST_CONTENT } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import {
  answerProposal,
  commissionReward,
  creditCommissions,
  isBoardOpen,
  loyaltyMultiplier,
  offerableTemplates,
  tickCommissions,
} from './commissions.js';

/** Take on every proposal on the board, as an eager player would. */
function acceptAll(state: GameState): GameState {
  let next = state;
  for (const offer of state.commissions.open) {
    if (!offer.accepted) {
      next = answerProposal(next, content, offer.serial, true, undefined) ?? next;
    }
  }
  return next;
}

const content = TEST_CONTENT;
const base = createInitialState(content, { seed: 7 });
const board = content.commissions;
const inBench: GameState = { ...base, phaseId: 'shop' };
const firstMs = board.firstOfferDesignSeconds * MS_PER_SECOND;

describe('the commission board', () => {
  it('stays shut until its phase', () => {
    expect(isBoardOpen(base, content)).toBe(false);
    expect(tickCommissions(base, content, firstMs, undefined)).toBe(base);
    expect(isBoardOpen(inBench, content)).toBe(true);
  });

  it('only offers what the workshop can deliver today', () => {
    const offered = offerableTemplates(inBench, content);
    expect(offered.length).toBeGreaterThan(0);
    // PETG needs the heated bed: not on offer without it.
    expect(offered.every((template) => template.materialId === 'pla')).toBe(true);
    const heated = { ...inBench, upgrades: { 'heated-bed': 1 } };
    expect(offerableTemplates(heated, content).some((t) => t.materialId === 'petg')).toBe(true);
  });

  it('posts offers on its clock, up to the board size, the same way every time', () => {
    let state = inBench;
    const { events } = collectEvents((emit) => {
      for (let i = 0; i < board.boardSize + 2; i += 1) {
        state = acceptAll(
          tickCommissions(state, content, Math.max(state.commissions.nextOfferMs, 1), emit),
        );
      }
    });
    const offered = offerableTemplates(inBench, content).length;
    expect(state.commissions.open.length).toBe(Math.min(board.boardSize, offered));
    // An order can expire and be re-posted along the way, so at least as many.
    expect(
      events.filter((event) => event.type === 'COMMISSION_OFFERED').length,
    ).toBeGreaterThanOrEqual(state.commissions.open.length);
    const replay = tickCommissions(inBench, content, firstMs, undefined);
    const again = tickCommissions(inBench, content, firstMs, undefined);
    expect(replay.commissions.open).toEqual(again.commissions.open);
  });

  it('lets an order expire when its deadline runs out', () => {
    const posted = acceptAll(tickCommissions(inBench, content, firstMs, undefined));
    const offer = posted.commissions.open[0];
    expect(offer).toBeDefined();
    const { result, events } = collectEvents((emit) =>
      tickCommissions(posted, content, (offer?.remainingMs ?? 0) + 1, emit),
    );
    expect(result.commissions.open.some((o) => o.serial === offer?.serial)).toBe(false);
    expect(events.some((event) => event.type === 'COMMISSION_EXPIRED')).toBe(true);
  });

  it('counts matching parts and pays the bonus on delivery, keeping the parts', () => {
    const posted = acceptAll(tickCommissions(inBench, content, firstMs, undefined));
    const offer = posted.commissions.open[0];
    const template = content.commissions.templates.find((t) => t.id === offer?.templateId);
    if (offer === undefined || template === undefined) {
      throw new Error('expected an offer');
    }
    const partial = creditCommissions(
      posted,
      content,
      template.materialId,
      template.objectId,
      template.count - 1,
      1,
      undefined,
    );
    expect(partial.commissions.open[0]?.delivered).toBe(template.count - 1);
    expect(partial.resources.money).toBe(posted.resources.money);

    const wrong = creditCommissions(
      partial,
      content,
      'resin',
      template.objectId,
      999,
      1,
      undefined,
    );
    expect(wrong.commissions.open[0]?.delivered).toBe(template.count - 1);

    const { result, events } = collectEvents((emit) =>
      creditCommissions(partial, content, template.materialId, template.objectId, 1, 1, emit),
    );
    const reward = commissionReward(content, template, 1);
    expect(reward).toBeGreaterThan(0);
    expect(result.resources.money).toBeCloseTo(posted.resources.money + reward, 9);
    expect(result.stats.commissionsCompleted).toBe(1);
    expect(result.commissions.open.some((o) => o.serial === offer.serial)).toBe(false);
    expect(events).toMatchObject([{ type: 'COMMISSION_COMPLETED', reward }]);
  });

  it('arrives as a proposal that walks off if nobody answers', () => {
    const posted = tickCommissions(inBench, content, firstMs, undefined);
    const offer = posted.commissions.open[0];
    expect(offer?.accepted).toBe(false);
    const windowMs = board.offerWindowDesignSeconds * MS_PER_SECOND;
    const ignored = tickCommissions(posted, content, windowMs + 1, undefined);
    expect(ignored.commissions.open.some((o) => o.serial === offer?.serial)).toBe(false);
  });

  it('counts nothing towards a proposal until it is taken on', () => {
    const posted = tickCommissions(inBench, content, firstMs, undefined);
    const offer = posted.commissions.open[0];
    const template = content.commissions.templates.find((t) => t.id === offer?.templateId);
    if (offer === undefined || template === undefined) {
      throw new Error('expected an offer');
    }
    const credited = creditCommissions(
      posted,
      content,
      template.materialId,
      template.objectId,
      template.count,
      1,
      undefined,
    );
    expect(credited.commissions.open[0]?.delivered).toBe(0);
  });

  it('starts the deadline on accepting, and lets a declined client go', () => {
    const posted = tickCommissions(inBench, content, firstMs, undefined);
    const offer = posted.commissions.open[0];
    const template = content.commissions.templates.find((t) => t.id === offer?.templateId);
    if (offer === undefined || template === undefined) {
      throw new Error('expected an offer');
    }
    const { result, events } = collectEvents((emit) =>
      answerProposal(posted, content, offer.serial, true, emit),
    );
    expect(result?.commissions.open[0]).toMatchObject({
      accepted: true,
      remainingMs: template.timeLimitDesignSeconds * MS_PER_SECOND,
    });
    expect(events).toMatchObject([{ type: 'COMMISSION_ANSWERED', accepted: true }]);
    // Answering twice, or answering a stranger, is refused.
    expect(answerProposal(result ?? posted, content, offer.serial, true, undefined)).toBeNull();
    expect(answerProposal(posted, content, 999, true, undefined)).toBeNull();
    const declined = answerProposal(posted, content, offer.serial, false, undefined);
    expect(declined?.commissions.open).toEqual([]);
  });

  it('pays a regular client more, up to a cap', () => {
    const template = content.commissions.templates[0];
    if (template === undefined) {
      throw new Error('expected a template');
    }
    expect(loyaltyMultiplier(content, 0)).toBe(1);
    expect(commissionReward(content, template, 1, 2)).toBeGreaterThan(
      commissionReward(content, template, 1, 0),
    );
    expect(loyaltyMultiplier(content, board.loyaltyMaxOrders + 10)).toBe(
      loyaltyMultiplier(content, board.loyaltyMaxOrders),
    );
  });
});
