import { z } from 'zod';

/**
 * The frozen `VisualState` contract (Projection/Adapter, spec §15).
 *
 * The renderer is a *pure function of this structure* and may never read sim
 * internals, so the structure itself is the API between the simulation and
 * every present and future renderer (SVG today, RIVE later, the STL generator
 * in M7). It is therefore versioned and schema-validated exactly like a save:
 * `__fixtures__/` holds one frozen JSON document per shipped version, and
 * `visual-state.test.ts` parses each of them with the *strict* schema below.
 *
 * That makes the freeze real in both directions: adding a field breaks the old
 * fixtures (missing key) and removing one breaks them too (unknown key). Either
 * way the only way forward is to bump {@link VISUAL_STATE_VERSION} and add a
 * new fixture — which is the whole point of calling it frozen.
 *
 * History:
 * - v1 (M0) — draft: phase id and a slot list, no renderer to speak of.
 * - v2 (M1) — draft: run progress, the intro assembly and the HUD ledger.
 * - v3 (M2) — frozen: every slot is projected (empty bays included) so the
 *   renderer can draw the "max 4, faint outline" rule from data alone.
 * - v4 (M3) — frozen: the economy becomes visible. Slots carry their
 *   changeover and their pity charge; the market board, the machine tree and
 *   the automation rack are projected as lists, so the shell can offer every
 *   purchase without a content table of its own.
 * - v5 (M4) — frozen: slots and scale. The rack knows how many bays are
 *   owned, which one is on sale and what it costs; every bay carries its print
 *   rota and the machines assigned to it; and the run's Farm/Goliath
 *   commitment is projected as a choice *and* as a drawing instruction, so the
 *   renderer switches to the one-giant-printer layout from data.
 * - v6 (M5) — **frozen**: the meta layer. Every bay says whether it is making
 *   Parts or Products; the Design Studio is projected as a bench plus a
 *   catalogue of drafts with their levels; prestige is projected as a single
 *   offer with the Plates it would pay and the reason it is not on offer; the
 *   money printers are a list like every other purchase; and the intro carries
 *   a `selfAssembling` flag so the renderer can show the workshop building
 *   itself instead of waiting for clicks (spec §6 phase 4).
 * - v7 (M6) — **frozen**: the endgame. The workshop carries the backdrop it is
 *   drawn against (spec §5E: "print a building"), the inflation index the
 *   presses have caused (spec §6 phase 5), the Universal Fabricator as a
 *   synced, layer-by-layer build (spec §6 phase 6) with the sections
 *   pre-printed for it (spec §7.3), and the ending sequence — stage, progress
 *   and the credits themselves — followed by the New Game Plus offer.
 */
export const VISUAL_STATE_VERSION = 7;

const NonNegative = z.number().finite().nonnegative();
const NonNegativeInt = z.number().int().nonnegative();
/** 0..1 — the renderer never has to clamp. */
const Unit = z.number().finite().min(0).max(1);
const NonEmpty = z.string().min(1);

/** One entry of a slot's print rota (spec §5B), named for display. */
export const QueueEntryVisualSchema = z
  .object({
    materialId: NonEmpty,
    materialName: NonEmpty,
    objectId: NonEmpty,
    objectName: NonEmpty,
    batches: z.number().int().positive(),
    /** The entry the bay is printing right now. */
    current: z.boolean(),
  })
  .strict();

/**
 * One config slot (spec §4 rendering rule): rendered **once per slot**, never
 * once per printer, carrying the `×N` count badge and the best machine tier
 * among the printers assigned to it.
 */
export const SlotVisualSchema = z
  .object({
    slotId: NonEmpty,
    /** Position in the workshop, so layout does not depend on array order. */
    index: NonNegativeInt,
    materialId: NonEmpty.nullable(),
    /** Display name, so the renderer needs no content table (cf. `phaseName`). */
    materialName: NonEmpty.nullable(),
    /** The object or Design loaded — whichever it is (spec §5D). */
    objectId: NonEmpty.nullable(),
    objectName: NonEmpty.nullable(),
    /** What a finished print becomes: Parts, or Products from a Design. */
    output: z.enum(['parts', 'products']),
    /** The Design this bay is printing, or `null` for a stock object. */
    designId: NonEmpty.nullable(),
    machineTier: NonNegativeInt,
    printerCount: NonNegativeInt,
    /** Machines this bay can hold (spec §4) — the fleet-allocation ceiling. */
    printerCapacity: z.number().int().positive(),
    /** 0..1 animation offset so identical printers do not move in lockstep. */
    phaseOffset: Unit,
    /** Configured *and* staffed: anything else draws as a faint empty bay. */
    occupied: z.boolean(),
    running: z.boolean(),
    /** 0..1 through the current batch. */
    progress: Unit,
    batch: NonNegativeInt,
    /** Purging for a material change (spec §3) — nothing prints meanwhile. */
    changingOver: z.boolean(),
    /** 0..1 through that purge; 0 when there is none. */
    changeoverProgress: Unit,
    /**
     * 0..1 towards the next guaranteed failure (spec §7.1). The pity timer is
     * deterministic, so this is a promise to the player, not a probability.
     */
    failureRisk: Unit,
    /** The rota this bay works through; empty when it prints one config. */
    queue: z.array(QueueEntryVisualSchema),
    /** Batches finished on the current rota entry. */
    queueBatches: NonNegativeInt,
  })
  .strict();

/** The next config slot on sale (spec §4), or absent once the rack is full. */
export const SlotUnlockVisualSchema = z
  .object({
    unlockId: NonEmpty,
    name: NonEmpty,
    /** Phase reached, prerequisites met, gates satisfied. */
    available: z.boolean(),
    affordable: z.boolean(),
    cost: NonNegative,
    costResource: NonEmpty,
    /** Why it is not on offer — `null` when it is. Renderers show this. */
    blockedReason: NonEmpty.nullable(),
  })
  .strict();

/** One branch of the per-run Farm/Goliath fork (spec §5B). */
export const ForkVisualSchema = z
  .object({
    forkId: NonEmpty,
    name: NonEmpty,
    description: NonEmpty,
    /** How the workshop should be drawn if this branch is taken. */
    layout: z.enum(['rack', 'goliath']),
    chosen: z.boolean(),
    available: z.boolean(),
    affordable: z.boolean(),
    cost: NonNegative,
    costResource: NonEmpty,
    requiredForFinalPrint: z.boolean(),
  })
  .strict();

/** The fleet as a whole (spec §4): machines, bays, and the hard ceiling. */
export const FleetVisualSchema = z
  .object({
    printers: NonNegativeInt,
    /** Machines standing in a bay. Equal to `printers` — the invariant, shown. */
    assigned: NonNegativeInt,
    slotsOwned: NonNegativeInt,
    /** Bays in use right now; a Goliath run caps this at one. */
    slotsActive: NonNegativeInt,
    /** Spec §4's hard maximum: the rack can never grow past this. */
    slotsMaximum: NonNegativeInt,
    /** Machines the active bays can hold in total — the fleet ceiling. */
    printerCapacity: NonNegativeInt,
  })
  .strict();

/** One row of the market board (spec §7.2). */
export const MarketVisualSchema = z
  .object({
    materialId: NonEmpty,
    materialName: NonEmpty,
    /** Listed materials can be sold back; the rest are shelf-price only. */
    tradeable: z.boolean(),
    /**
     * Which balance a gram comes out of (spec §3). Money for everything the
     * workshop prints with; **Plates** for the endgame's exotic feedstock — so
     * a shell that assumed Money would offer a button the till cannot pay.
     */
    priceResource: NonEmpty,
    /** Whether the phase and the machine tree have opened this material. */
    available: z.boolean(),
    buyPerGram: NonNegative,
    sellPerGram: NonNegative,
    /** Price relative to the listing's base — 1 is "normal". */
    priceMultiplier: NonNegative,
    /** Grams on the shelf; unlisted materials are unlimited and report 0. */
    stockGrams: NonNegative,
    heldGrams: NonNegative,
  })
  .strict();

/** One node of the upgrade trees (spec §5), ready to be offered or greyed out. */
export const UpgradeVisualSchema = z
  .object({
    upgradeId: NonEmpty,
    name: NonEmpty,
    tree: NonEmpty,
    level: NonNegativeInt,
    maxLevel: z.number().int().positive(),
    /** Unlocked, prerequisites met and not yet maxed. */
    available: z.boolean(),
    affordable: z.boolean(),
    cost: NonNegative,
    costResource: NonEmpty,
  })
  .strict();

/** One automation (spec §5C): what it costs, or what it is set to. */
export const AutomationVisualSchema = z
  .object({
    automationId: NonEmpty,
    name: NonEmpty,
    behavior: NonEmpty,
    level: NonNegativeInt,
    installed: z.boolean(),
    enabled: z.boolean(),
    threshold: NonNegative,
    available: z.boolean(),
    affordable: z.boolean(),
    cost: NonNegative,
    costResource: NonEmpty,
  })
  .strict();

/** The consolation loop (spec §2): what the scrap bin is worth right now. */
export const RecyclerVisualSchema = z
  .object({
    installed: z.boolean(),
    scrapGrams: NonNegative,
    /** Grams the bin would return if fed into the loaded material. */
    yieldGrams: NonNegative,
    yieldMaterialId: NonEmpty.nullable(),
  })
  .strict();

/** The intro printer being built piece by piece (spec §6 phase 0). */
export const AssemblyVisualSchema = z
  .object({
    attachedPieceIds: z.array(NonEmpty),
    totalPieces: NonNegativeInt,
    nextPieceId: NonEmpty.nullable(),
    nextPieceName: NonEmpty.nullable(),
    /** Design-milliseconds of bench work left before the next piece attaches. */
    cooldownMs: NonNegative,
    /** The next piece can be attached right now. */
    ready: z.boolean(),
    /**
     * The workshop rebuilds itself (spec §6 phase 4). True on every run after
     * the first melt-down: the pieces clip on by themselves and the renderer
     * shows a machine assembling rather than a button waiting to be pressed.
     */
    selfAssembling: z.boolean(),
    /** 0..1 across the whole assembly. */
    progress: Unit,
    complete: z.boolean(),
  })
  .strict();

export const LedgerVisualSchema = z
  .object({
    parts: NonNegative,
    money: NonNegative,
    scrap: NonNegative,
    products: NonNegative,
    plates: NonNegative,
    filamentGrams: z.record(NonEmpty, NonNegative),
  })
  .strict();

/** One row of the Design Studio catalogue (spec §5D). */
export const DesignVisualSchema = z
  .object({
    designId: NonEmpty,
    name: NonEmpty,
    materialId: NonEmpty,
    /** 0 until it has been drafted; 1 the moment it comes off the bench. */
    level: NonNegativeInt,
    maxLevel: z.number().int().positive(),
    owned: z.boolean(),
    /** 0..1 towards the next level. */
    levelProgress: Unit,
    /** Money one Product is worth at today's level. */
    productValue: NonNegative,
    /** The Money Plate: drafting it is what unlocks prestige (spec §5D). */
    capstone: z.boolean(),
    available: z.boolean(),
    affordable: z.boolean(),
    cost: NonNegative,
    costResource: NonEmpty,
    /** Why it cannot be drafted — `null` when it can. */
    blockedReason: NonEmpty.nullable(),
  })
  .strict();

/** The Design Studio itself: the bench, its capacity and what is on it. */
export const StudioVisualSchema = z
  .object({
    /** Design slots owned (spec §5D) and how many are still free. */
    slots: z.number().int().positive(),
    freeSlots: NonNegativeInt,
    /** The draft on the bench right now, or `null`. */
    draftingDesignId: NonEmpty.nullable(),
    draftingName: NonEmpty.nullable(),
    /** 0..1 through that draft. */
    draftProgress: Unit,
    designs: z.array(DesignVisualSchema),
  })
  .strict();

/** The melt-down offer (spec §5D) and what it would pay. */
export const PrestigeVisualSchema = z
  .object({
    available: z.boolean(),
    /** Plates the melt-down would award right now. */
    platesOnOffer: NonNegative,
    platesHeld: NonNegative,
    /** Melt-downs already done — run 1 is the first post-prestige run. */
    runsCompleted: NonNegativeInt,
    /** Money printed per design-second by the Plates (spec §5E). */
    moneyPerDesignSecond: NonNegative,
    blockedReason: NonEmpty.nullable(),
  })
  .strict();

/** One money-printer tier (spec §5E), priced in Plates. */
export const MoneyPrinterVisualSchema = z
  .object({
    moneyPrinterId: NonEmpty,
    name: NonEmpty,
    tier: z.number().int().positive(),
    level: NonNegativeInt,
    maxLevel: z.number().int().positive(),
    available: z.boolean(),
    affordable: z.boolean(),
    cost: NonNegative,
    costResource: NonEmpty,
  })
  .strict();

/**
 * On-screen inflation (spec §6 phase 5). The multiplier is what every price the
 * player sees has been through, and the reading is what caused it — so the HUD
 * can say *why* a bracket now costs what a printer used to.
 */
export const InflationVisualSchema = z
  .object({
    active: z.boolean(),
    /** ≥ 1. Multiplies every money price and every freshly banked value. */
    multiplier: z.number().finite().min(1),
    /** Money the presses have printed — the reading the index is read at. */
    moneyPrinted: NonNegative,
  })
  .strict();

/**
 * The Universal Fabricator (spec §6 phase 6) — the one synced render.
 *
 * `layer`/`layers` are what makes it synced: the renderer draws the build layer
 * by layer straight off the projection, so it needs no clock and two viewers of
 * the same save are on the same layer.
 */
export const FabricatorVisualSchema = z
  .object({
    /** The blueprint is owned, so the whole thing is worth showing at all. */
    unlocked: z.boolean(),
    available: z.boolean(),
    /** Why it cannot be started — `null` when it can. */
    blockedReason: NonEmpty.nullable(),
    running: z.boolean(),
    complete: z.boolean(),
    progress: Unit,
    layer: NonNegativeInt,
    layers: z.number().int().positive(),
    remainingMs: NonNegative,
    /** Design-milliseconds the build takes at today's section count. */
    totalMs: NonNegative,
    materialId: NonEmpty,
    filamentGrams: NonNegative,
    heldGrams: NonNegative,
    /** Sections pre-printed, and the most that can be (spec §7.3). */
    sections: NonNegativeInt,
    maxSections: z.number().int().positive(),
    sectionRunning: z.boolean(),
    sectionProgress: Unit,
    sectionAvailable: z.boolean(),
    sectionBlockedReason: NonEmpty.nullable(),
    sectionCost: NonNegative,
    sectionCostResource: NonEmpty,
    /** Does the run's fork allow the final print at all (spec §7.3)? */
    forkAllows: z.boolean(),
    /** Are all the active bays staffed and ready to commit (spec §4)? */
    slotsCommitted: z.boolean(),
    /** Machines standing in them, and how many the print asks for. */
    committedPrinters: NonNegativeInt,
    requiredPrinters: z.number().int().positive(),
  })
  .strict();

/** One optional New Game Plus modifier (spec §18 M6). */
export const NewGamePlusModifierVisualSchema = z
  .object({
    modifierId: NonEmpty,
    name: NonEmpty,
    description: NonEmpty,
    /** Taken on the current run. */
    active: z.boolean(),
  })
  .strict();

/**
 * The ending (spec §6 phase 6): numbers → museum → credits → the post-game.
 * The credits are content, carried here so the renderer holds no copy of them,
 * and `stage` is derived from the clock alone.
 */
export const EndingVisualSchema = z
  .object({
    stage: z.enum(['none', 'numbers', 'museum', 'credits', 'complete']),
    active: z.boolean(),
    /** 0..1 through the whole sequence. */
    progress: Unit,
    /** 0..1 through the current stage — what a fade or a scroll runs on. */
    stageProgress: Unit,
    /** The machine the museum shot puts under glass: printer #1. */
    museumPrinterId: NonEmpty,
    museumTier: NonNegativeInt,
    credits: z.array(z.string()),
    /** How many credit lines have printed out so far. */
    creditLines: NonNegativeInt,
    /** The numbers have gone to ∞ (spec §6): stop rendering the ledger. */
    infinite: z.boolean(),
    newGamePlusAvailable: z.boolean(),
    newGamePlusRun: NonNegativeInt,
    modifiers: z.array(NewGamePlusModifierVisualSchema),
  })
  .strict();

export const VisualStateSchema = z
  .object({
    version: z.literal(VISUAL_STATE_VERSION),
    phaseId: NonEmpty,
    /** Display name from `pacing.json` — the renderer holds no content table. */
    phaseName: NonEmpty,
    simTimeMs: NonNegative,
    /** Bays to draw right now (spec §4: 1 → 2 → 3 → 4; Goliath collapses to 1). */
    slotCapacity: z.number().int().positive(),
    /**
     * Draw one giant printer instead of the rack (spec §5B). Derived from the
     * chosen fork's `visual`, so the renderer never has to know an id.
     */
    goliath: z.boolean(),
    slots: z.array(SlotVisualSchema),
    fleet: FleetVisualSchema,
    slotUnlock: SlotUnlockVisualSchema.nullable(),
    forks: z.array(ForkVisualSchema),
    assembly: AssemblyVisualSchema,
    ledger: LedgerVisualSchema,
    market: z.array(MarketVisualSchema),
    upgrades: z.array(UpgradeVisualSchema),
    automation: z.array(AutomationVisualSchema),
    recycler: RecyclerVisualSchema,
    studio: StudioVisualSchema,
    prestige: PrestigeVisualSchema,
    moneyPrinters: z.array(MoneyPrinterVisualSchema),
    /** What the workshop is drawn against (spec §5E), as an id, not a picture. */
    backdrop: NonEmpty,
    inflation: InflationVisualSchema,
    fabricator: FabricatorVisualSchema,
    ending: EndingVisualSchema,
  })
  .strict();

/**
 * `z.infer` gives mutable types; the projection is a read-only snapshot and
 * treating it as one is what stops a renderer from "fixing" the sim in place.
 */
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type QueueEntryVisual = DeepReadonly<z.infer<typeof QueueEntryVisualSchema>>;
export type SlotVisual = DeepReadonly<z.infer<typeof SlotVisualSchema>>;
export type SlotUnlockVisual = DeepReadonly<z.infer<typeof SlotUnlockVisualSchema>>;
export type ForkVisual = DeepReadonly<z.infer<typeof ForkVisualSchema>>;
export type FleetVisual = DeepReadonly<z.infer<typeof FleetVisualSchema>>;
export type MarketVisual = DeepReadonly<z.infer<typeof MarketVisualSchema>>;
export type UpgradeVisual = DeepReadonly<z.infer<typeof UpgradeVisualSchema>>;
export type AutomationVisual = DeepReadonly<z.infer<typeof AutomationVisualSchema>>;
export type RecyclerVisual = DeepReadonly<z.infer<typeof RecyclerVisualSchema>>;
export type DesignVisual = DeepReadonly<z.infer<typeof DesignVisualSchema>>;
export type StudioVisual = DeepReadonly<z.infer<typeof StudioVisualSchema>>;
export type PrestigeVisual = DeepReadonly<z.infer<typeof PrestigeVisualSchema>>;
export type MoneyPrinterVisual = DeepReadonly<z.infer<typeof MoneyPrinterVisualSchema>>;
export type InflationVisual = DeepReadonly<z.infer<typeof InflationVisualSchema>>;
export type FabricatorVisual = DeepReadonly<z.infer<typeof FabricatorVisualSchema>>;
export type NewGamePlusModifierVisual = DeepReadonly<
  z.infer<typeof NewGamePlusModifierVisualSchema>
>;
export type EndingVisual = DeepReadonly<z.infer<typeof EndingVisualSchema>>;
export type AssemblyVisual = DeepReadonly<z.infer<typeof AssemblyVisualSchema>>;
export type LedgerVisual = DeepReadonly<z.infer<typeof LedgerVisualSchema>>;
export type VisualState = DeepReadonly<z.infer<typeof VisualStateSchema>>;

export interface VisualStateIssue {
  readonly path: string;
  readonly message: string;
}

export type VisualStateValidation =
  | { readonly ok: true; readonly visual: VisualState; readonly issues: readonly [] }
  | { readonly ok: false; readonly visual: null; readonly issues: readonly VisualStateIssue[] };

/** Used by the fixture freeze test, the editor and any future renderer host. */
export function validateVisualState(candidate: unknown): VisualStateValidation {
  const result = VisualStateSchema.safeParse(candidate);
  if (result.success) {
    return { ok: true, visual: result.data, issues: [] };
  }
  return {
    ok: false,
    visual: null,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.message,
    })),
  };
}
