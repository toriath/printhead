import { describe, expect, it } from 'vitest';
import { marketStateOf } from '../systems/market.js';
import {
  FIRST_OBJECT_ID,
  FIRST_SLOT_ID,
  TEST_CONTENT,
  createSim,
  testSlot,
} from './__fixtures__/sim.js';
import {
  buyAutomation,
  buyFilament,
  buyUpgrade,
  recycleScrap,
  sellFilament,
  setAutomation,
  setSlotConfig,
} from './actions.js';
import type { GameState } from './game-state.js';

/**
 * The M3 actions driven through the *real* reducer, because that is where the
 * phase gate, the systems and the event bus meet. The systems themselves are
 * unit-tested next door; what these prove is the wiring — that a rejection
 * really is announced, that a purchase really lands in the ledger the phase FSM
 * then reads, and that nothing needs a rule the reducer does not enforce.
 */
const content = TEST_CONTENT;
const RECYCLER_ID = content.failure.recycler.requiresUpgradeId;

/** Fast-forward into a phase without playing the whole intro. */
function at(phaseId: string, over: Partial<GameState> = {}) {
  const sim = createSim();
  sim.state = { ...sim.state, phaseId, ...over };
  return sim;
}

const withParts = (parts: number) => ({
  resources: { ...createSim().state.resources, parts },
  partsValue: parts,
});

describe('BUY_UPGRADE', () => {
  it('is refused before the phase that unlocks it', () => {
    const sim = at('intro', withParts(1000));
    sim.do(buyUpgrade('heated-bed'));
    expect(sim.state.upgrades['heated-bed']).toBeUndefined();
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('phase-gated');
  });

  it('installs a node and announces it', () => {
    const sim = at('bench', withParts(1000));
    sim.do(buyUpgrade('heated-bed'));
    expect(sim.state.upgrades['heated-bed']).toBe(1);
    expect(sim.eventsOf('UPGRADE_INSTALLED')[0]).toMatchObject({
      upgradeId: 'heated-bed',
      level: 1,
    });
    expect(sim.state.resources.parts).toBeLessThan(1000);
  });

  it('reports the specific reason it cannot be installed', () => {
    const sim = at('bench', withParts(1000));
    sim.do(buyUpgrade('ghost'));
    sim.do(buyUpgrade('hardened-nozzle'));
    sim.do(buyUpgrade('heated-bed'));
    sim.do(buyUpgrade('heated-bed'));
    expect(sim.eventsOf('ACTION_REJECTED').map((event) => event.reason)).toEqual([
      'unknown-target',
      'missing-prerequisite',
      'max-level',
    ]);
  });

  it('refuses a node the ledger cannot pay for', () => {
    const sim = at('bench');
    sim.do(buyUpgrade('heated-bed'));
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('insufficient-resources');
  });

  it('gates a material behind its machine node (spec §3)', () => {
    const sim = at('bench', withParts(1000));
    sim.do(setSlotConfig(FIRST_SLOT_ID, 'petg', FIRST_OBJECT_ID));
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('locked');
    sim.do(buyUpgrade('heated-bed'));
    sim.do(setSlotConfig(FIRST_SLOT_ID, 'petg', FIRST_OBJECT_ID));
    expect(sim.state.slots[0]?.materialId).toBe('petg');
  });
});

describe('SET_SLOT_CONFIG charges a changeover', () => {
  it('purges the outgoing spool and locks the slot for the downtime', () => {
    const sim = at('bench', { ...withParts(1000), filamentGrams: { pla: 500, petg: 0 } });
    sim.do(buyUpgrade('heated-bed'));
    sim.do(setSlotConfig(FIRST_SLOT_ID, 'pla', FIRST_OBJECT_ID));
    sim.do(setSlotConfig(FIRST_SLOT_ID, 'petg', FIRST_OBJECT_ID));
    const configured = sim.eventsOf('SLOT_CONFIGURED').at(-1);
    expect(configured?.downtimeMs).toBeGreaterThan(0);
    expect(configured?.purgedGrams).toBeGreaterThan(0);
    expect(sim.state.filamentGrams.pla).toBeLessThan(500);
    expect(sim.state.slots[0]?.changeoverMs).toBe(configured?.downtimeMs);
  });

  it('refuses another switch while the purge is running', () => {
    const sim = at('bench', { ...withParts(1000), filamentGrams: { pla: 500, petg: 0 } });
    sim.do(buyUpgrade('heated-bed'));
    sim.do(setSlotConfig(FIRST_SLOT_ID, 'pla', FIRST_OBJECT_ID));
    sim.do(setSlotConfig(FIRST_SLOT_ID, 'petg', FIRST_OBJECT_ID));
    sim.drain();
    sim.do(setSlotConfig(FIRST_SLOT_ID, 'pla', FIRST_OBJECT_ID));
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('slot-busy');
  });

  it('will not start a print until the purge is over', () => {
    const sim = at('bench', { ...withParts(1000), filamentGrams: { pla: 500, petg: 500 } });
    sim.do(buyUpgrade('heated-bed'));
    sim.do(setSlotConfig(FIRST_SLOT_ID, 'pla', FIRST_OBJECT_ID));
    sim.do(setSlotConfig(FIRST_SLOT_ID, 'petg', FIRST_OBJECT_ID));
    sim.do({ type: 'START_PRINT', slotId: FIRST_SLOT_ID });
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('slot-busy');
  });
});

describe('trading filament', () => {
  const trader = () =>
    at('bench', {
      ...withParts(0),
      resources: { ...createSim().state.resources, money: 500 },
      upgrades: { 'heated-bed': 1 },
    });

  it('buys at the market price and announces the fill', () => {
    const sim = trader();
    sim.do(buyFilament('petg', 100));
    const purchased = sim.eventsOf('FILAMENT_PURCHASED')[0];
    expect(purchased?.grams).toBe(100);
    expect(purchased?.money).toBeGreaterThan(0);
    expect(sim.state.filamentGrams.petg).toBe(100);
  });

  it('refuses a material the machine tree has not unlocked', () => {
    const sim = at('bench', { resources: { ...createSim().state.resources, money: 500 } });
    sim.do(buyFilament('petg', 100));
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('locked');
  });

  it('sells back at the market price, below what it charged', () => {
    const sim = trader();
    sim.do(buyFilament('petg', 200));
    const afterBuy = sim.state.resources.money;
    sim.do(sellFilament('petg', 200));
    const sold = sim.eventsOf('FILAMENT_SOLD')[0];
    expect(sold?.grams).toBe(200);
    expect(sim.state.resources.money).toBeGreaterThan(afterBuy);
    // The round trip is a loss — spread plus slippage (spec §13).
    expect(sim.state.resources.money).toBeLessThan(500);
    expect(sim.state.filamentGrams.petg).toBe(0);
  });

  it('refuses to sell a material nobody lists', () => {
    const sim = trader();
    sim.do(buyFilament('pla', 100));
    sim.drain();
    sim.do(sellFilament('pla', 10));
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('not-tradeable');
  });

  it('refuses unknown materials on both sides of the trade', () => {
    const sim = trader();
    sim.do(buyFilament('unobtainium', 10));
    sim.do(sellFilament('unobtainium', 10));
    expect(sim.eventsOf('ACTION_REJECTED').map((event) => event.reason)).toEqual([
      'unknown-target',
      'unknown-target',
    ]);
  });

  it('refuses to sell grams that are not in stock', () => {
    const sim = trader();
    sim.do(sellFilament('petg', 10));
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('insufficient-resources');
  });

  it('lets the market drift and restock on the clock', () => {
    const sim = trader();
    const before = marketStateOf(sim.state, 'petg').stockGrams;
    sim.do(buyFilament('petg', 1000));
    const drained = marketStateOf(sim.state, 'petg').stockGrams;
    sim.tickSeconds(120);
    expect(drained).toBe(before - 1000);
    expect(marketStateOf(sim.state, 'petg').stockGrams).toBeGreaterThan(drained);
  });
});

describe('RECYCLE_SCRAP', () => {
  const scrapped = (over: Partial<GameState> = {}) =>
    at('bench', {
      resources: { ...createSim().state.resources, scrap: 40, parts: 1000 },
      partsValue: 1000,
      scrapValue: 2,
      ...over,
    });

  it('is refused without the recycler node', () => {
    const sim = scrapped();
    sim.do(recycleScrap('pla', null));
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('no-recycler');
  });

  it('turns scrap into filament and announces both sides', () => {
    const sim = scrapped();
    sim.do(buyUpgrade(RECYCLER_ID));
    sim.do(recycleScrap('pla', null));
    const recycled = sim.eventsOf('SCRAP_RECYCLED')[0];
    expect(recycled?.scrapGrams).toBe(40);
    expect(recycled?.filamentGrams).toBeGreaterThan(0);
    expect(sim.state.resources.scrap).toBe(0);
    expect(sim.state.stats.scrapRecycledGrams).toBe(40);
  });

  it('refuses an empty bin and an unknown material', () => {
    const sim = scrapped({ resources: { ...createSim().state.resources, scrap: 0, parts: 1000 } });
    sim.do(buyUpgrade(RECYCLER_ID));
    sim.drain();
    sim.do(recycleScrap('pla', null));
    sim.do(recycleScrap('unobtainium', null));
    expect(sim.eventsOf('ACTION_REJECTED').map((event) => event.reason)).toEqual([
      'nothing-to-do',
      'unknown-target',
    ]);
  });
});

describe('automation', () => {
  const buyer = () => at('bench', withParts(2000));

  it('installs, announces and then runs on the clock', () => {
    const sim = buyer();
    sim.do(buyAutomation('auto-sell'));
    expect(sim.eventsOf('AUTOMATION_INSTALLED')[0]).toMatchObject({ automationId: 'auto-sell' });
    const before = sim.state.resources.parts;
    const interval = content.automation[0]?.intervalDesignSeconds ?? 5;
    sim.tickSeconds(interval);
    expect(sim.state.resources.parts).toBeLessThan(before);
    expect(sim.eventsOf('AUTOMATION_FIRED').length).toBeGreaterThan(0);
  });

  it("honours the player's switch and threshold", () => {
    const sim = buyer();
    sim.do(buyAutomation('auto-sell'));
    sim.do(setAutomation('auto-sell', { enabled: false }));
    expect(sim.eventsOf('AUTOMATION_CONFIGURED')[0]?.enabled).toBe(false);
    const before = sim.state.resources.parts;
    sim.tickSeconds(60);
    expect(sim.state.resources.parts).toBe(before);
  });

  it('refuses to configure something that is not installed', () => {
    const sim = buyer();
    sim.do(setAutomation('auto-sell', { threshold: 5 }));
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('unknown-target');
  });

  it('reports the specific reason it cannot be bought', () => {
    const sim = buyer();
    sim.do(buyAutomation('ghost'));
    sim.do(buyAutomation('auto-trade'));
    sim.do(buyAutomation('auto-sell'));
    sim.do(buyAutomation('auto-sell'));
    expect(sim.eventsOf('ACTION_REJECTED').map((event) => event.reason)).toEqual([
      'unknown-target',
      'locked',
      'max-level',
    ]);
  });
});

describe('the tick order is fixed', () => {
  /**
   * Automation runs after the printers have paid out and after the market has
   * drifted, so a machine bot sees exactly the world a player checking in at
   * that instant would. Proven by giving the auto-seller a threshold of zero
   * and checking it banks the parts the *same* tick's print produced.
   */
  it('lets automation act on what this very tick produced', () => {
    const runSeconds = content.objects[0]?.printDesignSeconds ?? 12;
    const sim = at('bench', {
      printers: { 'bench-mk1': 1 },
      filamentGrams: { pla: 500 },
      slots: [testSlot({ id: FIRST_SLOT_ID, printerCount: 1 })],
      resources: { ...createSim().state.resources, parts: 0 },
      automation: {
        // Timed to come due on exactly the tick the print finishes.
        'auto-sell': {
          level: 1,
          enabled: true,
          threshold: 0,
          cooldownMs: (content.objects[0]?.printDesignSeconds ?? 12) * 1000,
        },
      },
    });
    sim.do(setSlotConfig(FIRST_SLOT_ID, 'pla', FIRST_OBJECT_ID));
    sim.do({ type: 'START_PRINT', slotId: FIRST_SLOT_ID });
    sim.tickSeconds(runSeconds);
    expect(sim.state.stats.printsCompleted).toBeGreaterThan(0);
    expect(sim.state.resources.parts).toBe(0);
    expect(sim.state.resources.money).toBeGreaterThan(0);
  });
});
