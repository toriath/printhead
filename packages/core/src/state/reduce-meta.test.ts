import { describe, expect, it } from 'vitest';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MS_PER_MINUTE } from '../engine/constants.js';
import { nextDesignCost, productValueOf } from '../systems/designs.js';
import { nextMoneyPrinterCost, platesFor } from '../systems/prestige.js';
import { slotUnlockAvailability } from '../systems/slots.js';
import { computeModifiers } from '../systems/upgrades.js';
import { TEST_CONTENT, createSim, testSlot } from './__fixtures__/sim.js';
import {
  buyMoneyPrinter,
  createDesign,
  prestige,
  sellParts,
  sellProducts,
  setSlotConfig,
  setSlotDesign,
  startPrint,
  tick,
} from './actions.js';
import type { GameState } from './game-state.js';

/**
 * The M5 actions through the real reducer (spec §5D, §5E). Every case here is
 * a sequence of clicks, and every rejection is a button the shell must not
 * offer.
 */
const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const materialId = content.materials[0]?.id ?? 'pla';
const objectId = content.objects[0]?.id ?? 'bracket';
const capstoneId = content.prestige.requiredDesignId;
const capstone = content.designs.find((def) => def.id === capstoneId);
const pressId = content.prestige.moneyPrinters[0]?.id ?? 'bill-printer';

if (capstone === undefined) {
  throw new Error('content must ship the capstone design prestige.json names');
}

/** A studio-phase workshop: resin open, money banked, one staffed bay. */
function studioSim(over: Partial<GameState> = {}) {
  const sim = createSim();
  sim.state = {
    ...sim.state,
    phaseId: 'studio',
    printers: { [content.start.printerId]: 2 },
    upgrades: { 'heated-bed': 1, enclosure: 1, 'sla-unit': 1, 'design-desk': 2 },
    resources: { ...sim.state.resources, money: 5_000_000, parts: 200 },
    partsValue: 400,
    filamentGrams: { ...sim.state.filamentGrams, resin: 5000 },
    slots: [testSlot({ id: 'slot-1', materialId, objectId, printerCount: 2 })],
    ...over,
  };
  return sim;
}

/** The same workshop with the capstone already owned. */
function ownsCapstone(over: Partial<GameState> = {}) {
  return studioSim({
    designs: { [capstoneId]: { level: 1, printsOnLevel: 0 } },
    resources: { ...studioSim().state.resources, designs: 1 },
    ...over,
  });
}

describe('CREATE_DESIGN (spec §5D)', () => {
  it('puts the commission on the bench, charges for it and announces it', () => {
    const sim = studioSim();
    const cost = nextDesignCost(sim.state, content, curves, capstoneId)?.amount ?? 0;
    const before = sim.state.resources.money;
    sim.do(createDesign(capstoneId));
    expect(sim.state.studio).toEqual({
      designId: capstoneId,
      remainingMs: capstone.designDesignMinutes * MS_PER_MINUTE,
    });
    expect(sim.state.resources.money).toBe(before - cost);
    expect(sim.eventsOf('DESIGN_STARTED')[0]).toMatchObject({ designId: capstoneId, paid: cost });
    // Not owned yet: the studio has to actually do the work.
    expect(sim.state.designs[capstoneId]).toBeUndefined();
  });

  it('hands the Design over when the bench work is done', () => {
    const sim = studioSim().do(createDesign(capstoneId));
    sim.tickMs(capstone.designDesignMinutes * MS_PER_MINUTE);
    expect(sim.state.studio).toBeNull();
    expect(sim.state.designs[capstoneId]).toEqual({ level: 1, printsOnLevel: 0 });
    expect(sim.state.resources.designs).toBe(1);
    expect(sim.eventsOf('DESIGN_CREATED')[0]).toMatchObject({
      designId: capstoneId,
      designsOwned: 1,
    });
  });

  it('refuses before the machine tree opens resin (spec §3)', () => {
    const sim = studioSim({ upgrades: {} }).do(createDesign(capstoneId));
    expect(sim.state.studio).toBeNull();
    expect(sim.eventsOf('ACTION_REJECTED')[0]).toMatchObject({
      actionType: 'CREATE_DESIGN',
      reason: 'missing-prerequisite',
    });
  });

  it('refuses a second commission while the bench is busy', () => {
    const sim = studioSim().do(createDesign(capstoneId), createDesign('phone-stand'));
    expect(sim.state.studio?.designId).toBe(capstoneId);
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('slot-busy');
  });

  it('refuses when the workshop cannot pay', () => {
    const sim = studioSim({ resources: { ...studioSim().state.resources, money: 0 } });
    sim.do(createDesign(capstoneId));
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('insufficient-resources');
  });
});

describe('SET_SLOT_DESIGN (spec §5D)', () => {
  it('loads the bay with the Design and its material, and clears the object', () => {
    const sim = ownsCapstone().do(setSlotDesign('slot-1', capstoneId));
    const slot = sim.state.slots[0];
    expect(slot?.designId).toBe(capstoneId);
    expect(slot?.objectId).toBeNull();
    expect(slot?.materialId).toBe(capstone.requiredMaterialId);
    expect(sim.eventsOf('SLOT_CONFIGURED')[0]).toMatchObject({
      slotId: 'slot-1',
      recipeId: capstoneId,
    });
  });

  it('charges the changeover, because a Design is a different spool', () => {
    const sim = ownsCapstone().do(setSlotDesign('slot-1', capstoneId));
    // The bay came off PLA, so switching to resin purges (spec §3).
    expect(sim.state.slots[0]?.changeoverMs).toBeGreaterThan(0);
    expect(sim.eventsOf('SLOT_CONFIGURED')[0]?.purgedGrams).toBeGreaterThan(0);
  });

  it('loading a stock object afterwards takes the bay out of Design mode', () => {
    const sim = ownsCapstone().do(setSlotDesign('slot-1', capstoneId));
    sim.tickSeconds(120);
    sim.do(setSlotConfig('slot-1', materialId, objectId));
    expect(sim.state.slots[0]?.designId).toBeNull();
    expect(sim.state.slots[0]?.objectId).toBe(objectId);
  });

  it('refuses a Design the studio has not drafted', () => {
    const sim = studioSim().do(setSlotDesign('slot-1', capstoneId));
    expect(sim.state.slots[0]?.designId).toBeNull();
    expect(sim.eventsOf('ACTION_REJECTED')[0]).toMatchObject({
      actionType: 'SET_SLOT_DESIGN',
      reason: 'missing-prerequisite',
    });
  });

  it('refuses one whose material the tree has closed again', () => {
    const sim = ownsCapstone({ upgrades: {} }).do(setSlotDesign('slot-1', capstoneId));
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('locked');
  });

  it('refuses a bay that does not exist, and a Design content does not describe', () => {
    const sim = ownsCapstone().do(
      setSlotDesign('no-such-bay', capstoneId),
      setSlotDesign('slot-1', 'no-such-design'),
    );
    expect(sim.eventsOf('ACTION_REJECTED').map((event) => event.reason)).toEqual([
      'unknown-target',
      'unknown-target',
    ]);
  });

  it('refuses a bay mid-purge: the nozzle is already half-flushed', () => {
    const sim = ownsCapstone().do(setSlotDesign('slot-1', capstoneId));
    sim.do(setSlotDesign('slot-1', capstoneId));
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('slot-busy');
  });
});

describe('printing a Design makes Products, not Parts (spec §5D)', () => {
  it('banks Products at the value the Design’s level makes them worth', () => {
    const sim = ownsCapstone().do(setSlotDesign('slot-1', capstoneId));
    sim.tickSeconds(120);
    sim.do(startPrint('slot-1'));
    sim.tickSeconds(capstone.printDesignSeconds * 3);
    expect(sim.state.resources.products).toBeGreaterThan(0);
    expect(sim.state.resources.parts).toBe(200);
    expect(sim.state.stats.productsProduced).toBeGreaterThan(0);
    expect(sim.state.stats.partsProduced).toBe(0);
    const unit = productValueOf(
      capstone,
      curves,
      sim.state.designs[capstoneId]?.level ?? 1,
      computeModifiers(sim.state, content),
    );
    expect(sim.state.productsValue).toBeGreaterThanOrEqual(unit * 0.5);
    const completed = sim.eventsOf('PRINT_COMPLETED')[0];
    expect(completed?.pool).toBe('products');
    expect(completed?.recipeId).toBe(capstoneId);
  });

  it('levels the Design up as the batches land, and says so', () => {
    const sim = ownsCapstone().do(setSlotDesign('slot-1', capstoneId));
    sim.tickSeconds(120);
    sim.do(startPrint('slot-1'));
    sim.tickSeconds(capstone.printDesignSeconds * capstone.printsPerLevel * 4);
    expect(sim.state.designs[capstoneId]?.level).toBeGreaterThan(1);
    expect(sim.eventsOf('DESIGN_LEVELLED')[0]?.designId).toBe(capstoneId);
  });
});

describe('SELL_PRODUCTS (spec §5D)', () => {
  const stocked = () =>
    ownsCapstone({
      resources: { ...ownsCapstone().state.resources, products: 10 },
      productsValue: 2000,
    });

  it('sells at the value the Products were banked at', () => {
    const sim = stocked();
    const before = sim.state.resources.money;
    sim.do(sellProducts(4));
    expect(sim.state.resources.products).toBe(6);
    expect(sim.state.resources.money - before).toBeCloseTo(800, 6);
    expect(sim.state.productsValue).toBeCloseTo(1200, 6);
    expect(sim.state.stats.productsSold).toBe(4);
    expect(sim.eventsOf('PRODUCT_SOLD')[0]).toMatchObject({ products: 4, money: 800 });
  });

  it('sells the lot when asked for everything', () => {
    const sim = stocked().do(sellProducts(null));
    expect(sim.state.resources.products).toBe(0);
    expect(sim.state.productsValue).toBe(0);
  });

  it('is a different till from Parts: selling one does not spend the other', () => {
    const sim = stocked().do(sellParts(null));
    expect(sim.state.resources.products).toBe(10);
    expect(sim.state.productsValue).toBe(2000);
  });

  it('refuses when there is nothing on the shelf', () => {
    const sim = ownsCapstone().do(sellProducts(null));
    expect(sim.eventsOf('ACTION_REJECTED')[0]).toMatchObject({
      actionType: 'SELL_PRODUCTS',
      reason: 'nothing-to-do',
    });
  });
});

describe('PRESTIGE (spec §5D)', () => {
  const meltable = (over: Partial<GameState> = {}) =>
    ownsCapstone({
      phaseId: content.prestige.unlockPhaseId,
      resources: {
        ...ownsCapstone().state.resources,
        money: 4_000_000,
        designs: 1,
      },
      ...over,
    });

  it('awards the Plates, keeps the Designs and starts the workshop again', () => {
    const sim = meltable();
    const quoted = platesFor(sim.state, content, curves);
    const designs = sim.state.designs;
    sim.do(prestige());
    expect(sim.state.resources.plates).toBe(quoted);
    expect(sim.state.designs).toBe(designs);
    expect(sim.state.printers).toEqual({});
    expect(sim.state.selfAssembling).toBe(true);
    expect(sim.eventsOf('PRESTIGED')[0]).toMatchObject({
      platesAwarded: quoted,
      runNumber: 1,
      designsKept: 1,
    });
  });

  it('rebuilds the intro by itself, through the same path a click takes', () => {
    const sim = meltable().do(prestige());
    expect(sim.state.assembly.attachedPieceIds).toEqual([]);
    for (const piece of content.start.assemblyPieces) {
      sim.tickSeconds(piece.attachDesignSeconds + content.prestige.meltdownDesignSeconds + 1);
    }
    expect(sim.state.assembly.attachedPieceIds).toHaveLength(content.start.assemblyPieces.length);
    // The very same events a clicking player would have produced.
    expect(sim.eventsOf('PIECE_ATTACHED')).toHaveLength(content.start.assemblyPieces.length);
    expect(sim.eventsOf('ASSEMBLY_COMPLETED')).toHaveLength(1);
    expect(sim.state.printers[content.start.printerId]).toBe(1);
  });

  it('does not self-assemble a workshop that has never melted down', () => {
    const sim = studioSim();
    sim.tickSeconds(600);
    expect(sim.state.assembly.attachedPieceIds).toEqual([]);
  });

  it('refuses without the capstone, before the phase, or for a trivial run', () => {
    // The FSM refuses it before the system ever sees it: `PRESTIGE` is not in
    // the studio phase's `allowedActions`, so the rejection is `phase-gated`.
    expect(studioSim().do(prestige()).eventsOf('ACTION_REJECTED')[0]?.reason).toBe('phase-gated');
    expect(meltable({ designs: {} }).do(prestige()).eventsOf('ACTION_REJECTED')[0]?.reason).toBe(
      'missing-prerequisite',
    );
    expect(
      meltable({ resources: { ...ownsCapstone().state.resources, money: 0 } })
        .do(prestige())
        .eventsOf('ACTION_REJECTED')[0]?.reason,
    ).toBe('not-worth-it');
  });

  it('keeps the presses, so the Plates buy something that lasts (spec §5E)', () => {
    const sim = meltable({ moneyPrinters: { [pressId]: 1 } }).do(prestige());
    expect(sim.state.moneyPrinters[pressId]).toBe(1);
  });

  /**
   * Spec §4: "slot 4 prestige-gated". M4 could only prove that gate by granting
   * a Plate, because nothing in the game could mint one. This is the same gate,
   * opened the way the game opens it.
   */
  it('opens the fourth bay, which nothing before the melt-down could', () => {
    const fourth = content.slots.at(-1);
    expect(fourth?.id).toBe('slot-4');
    const before = meltable();
    expect(slotUnlockAvailability(before.state, content, fourth?.id ?? '')).not.toBeNull();

    const after = meltable().do(prestige());
    expect(after.state.resources.plates).toBeGreaterThan(0);
    // Everything the earlier bays needed has to be re-earned, so the fourth is
    // gated on the rack below it rather than on the Plates alone...
    const rebuilt = {
      ...after.state,
      slots: ['slot-1', 'slot-2', 'slot-3'].map((id) => testSlot({ id })),
      resources: { ...after.state.resources, parts: 1e9 },
      partsValue: 1e9,
      upgrades: { enclosure: 1 },
    };
    // ...and with the rack back, the Plates are what open it.
    expect(slotUnlockAvailability(rebuilt, content, fourth?.id ?? '')).toBeNull();
    expect(
      slotUnlockAvailability(
        { ...rebuilt, resources: { ...rebuilt.resources, plates: 0 } },
        content,
        fourth?.id ?? '',
      ),
    ).toBe('locked');
  });
});

describe('BUY_MONEY_PRINTER (spec §5E)', () => {
  const banked = (plates: number, over: Partial<GameState> = {}) =>
    ownsCapstone({
      phaseId: content.prestige.unlockPhaseId,
      resources: { ...ownsCapstone().state.resources, plates },
      ...over,
    });

  it('installs a level and takes the Plates for it', () => {
    const sim = banked(200);
    const cost = nextMoneyPrinterCost(sim.state, content, curves, pressId)?.amount ?? 0;
    sim.do(buyMoneyPrinter(pressId));
    expect(sim.state.moneyPrinters[pressId]).toBe(1);
    expect(sim.state.resources.plates).toBe(200 - cost);
    expect(sim.eventsOf('MONEY_PRINTER_INSTALLED')[0]).toMatchObject({
      moneyPrinterId: pressId,
      level: 1,
      paid: cost,
    });
  });

  it('prints money every tick once it is installed', () => {
    const sim = banked(200).do(buyMoneyPrinter(pressId));
    const before = sim.state.resources.money;
    sim.tickSeconds(10);
    expect(sim.state.resources.money).toBeGreaterThan(before);
    expect(sim.state.stats.moneyPrinted).toBeGreaterThan(0);
  });

  it('refuses an unknown tier, a locked phase and an empty plate tin', () => {
    expect(
      banked(200).do(buyMoneyPrinter('no-such-press')).eventsOf('ACTION_REJECTED')[0]?.reason,
    ).toBe('unknown-target');
    expect(
      ownsCapstone({ resources: { ...ownsCapstone().state.resources, plates: 200 } })
        .do(buyMoneyPrinter(pressId))
        .eventsOf('ACTION_REJECTED')[0]?.reason,
    ).toBe('phase-gated');
    expect(banked(0).do(buyMoneyPrinter(pressId)).eventsOf('ACTION_REJECTED')[0]?.reason).toBe(
      'insufficient-resources',
    );
  });

  it('refuses once the tier is maxed out', () => {
    const def = content.prestige.moneyPrinters[0];
    const sim = banked(100_000, { moneyPrinters: { [pressId]: def?.maxLevel ?? 1 } });
    sim.do(buyMoneyPrinter(pressId));
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('max-level');
  });
});

describe('the tick order puts the presses after the printers', () => {
  it('mints money in the same tick the studio and the rack ran', () => {
    const sim = ownsCapstone({
      phaseId: content.prestige.unlockPhaseId,
      resources: { ...ownsCapstone().state.resources, plates: 20 },
      moneyPrinters: { [pressId]: 1 },
    });
    sim.do(createDesign('phone-stand'));
    const before = sim.state.resources.money;
    sim.do(tick(100));
    expect(sim.state.resources.money).toBeGreaterThan(before);
    expect(sim.state.studio?.remainingMs).toBeLessThan(
      (content.designs.find((d) => d.id === 'phone-stand')?.designDesignMinutes ?? 0) *
        MS_PER_MINUTE,
    );
  });
});
