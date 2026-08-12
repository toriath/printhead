import { z } from 'zod';
import { CurvesFileSchema, IdSchema } from '../curves/schema.js';

/**
 * Every gameplay number in PRINTHEAD lives in `packages/core/content/*.json`
 * and is validated here (spec §11). Schemas are `.strict()` so a typo in a
 * content file fails CI instead of silently defaulting at runtime.
 */

const NonNegative = z.number().finite().nonnegative();
const Positive = z.number().finite().positive();
const Multiplier = z.number().finite().positive();
const Fraction = z.number().finite().min(0).max(1);

export const ResourceKindSchema = z.enum([
  'filament',
  'parts',
  'scrap',
  'money',
  'designs',
  'products',
  'plates',
]);

/**
 * Filament is tracked per material (spec §2), so it is not part of the flat
 * resource ledger; everything else is a single scalar balance.
 */
export const SCALAR_RESOURCE_KINDS = [
  'parts',
  'scrap',
  'money',
  'designs',
  'products',
  'plates',
] as const;

export const ScalarResourceKindSchema = z.enum(SCALAR_RESOURCE_KINDS);

/**
 * Actions the phase FSM gates (spec §15). `TICK` and `ADVANCE_PHASE` are engine
 * concerns and are never gated; everything a player can click is listed per
 * phase in `pacing.json`, so unlocking a mechanic is a data edit.
 */
export const GatedActionTypeSchema = z.enum([
  'ATTACH_PIECE',
  'SET_SLOT_CONFIG',
  'START_PRINT',
  'SELL_PARTS',
  'BUY_FILAMENT',
  'SELL_FILAMENT',
  'BUY_PRINTER',
  'BUY_UPGRADE',
  'BUY_AUTOMATION',
  'SET_AUTOMATION',
  'RECYCLE_SCRAP',
  'BUY_SLOT',
  'ASSIGN_PRINTER',
  'SET_SLOT_QUEUE',
  'CHOOSE_FORK',
]);

/**
 * Named readings of the game state that content may gate on. The interpreter
 * lives in `systems/requirements.ts`; adding a metric here plus a case there is
 * all a new phase gate needs.
 */
export const MetricSchema = z.enum([
  'parts',
  'scrap',
  'money',
  'plates',
  'printers',
  'slots',
  'partsProduced',
  'partsSold',
  'printsCompleted',
  'printsFailed',
  'piecesAttached',
  'assemblyProgress',
  'upgradesInstalled',
  'automationsInstalled',
  'scrapRecycledGrams',
  'filamentTradedGrams',
  'phaseDesignMinutes',
  'totalDesignMinutes',
]);

export const RequirementSchema = z
  .object({
    metric: MetricSchema,
    atLeast: NonNegative,
  })
  .strict();

// --- pacing.json ------------------------------------------------------------

export const PhaseDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    budgetDesignMinutes: Positive,
    waitWallBudgetDesignMinutes: NonNegative,
    /** Which player actions this phase permits (cumulative lists, authored per phase). */
    allowedActions: z.array(GatedActionTypeSchema),
    /** All of these must hold before the FSM moves on to the next phase. */
    advanceWhen: z.array(RequirementSchema).min(1),
  })
  .strict();

export const PacingFileSchema = z
  .object({
    targetHours: Positive,
    baselineHours: Positive,
    offlineCapHours: Positive,
    phaseBudgetTolerance: Fraction,
    phases: z.array(PhaseDefSchema).min(1),
  })
  .strict();

// --- start.json -------------------------------------------------------------

export const AssemblyPieceSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    /** Design-seconds of bench work before this piece can be attached. */
    attachDesignSeconds: NonNegative,
  })
  .strict();

export const StartingFilamentSchema = z
  .object({
    materialId: IdSchema,
    grams: NonNegative,
  })
  .strict();

export const StartingResourcesSchema = z
  .object({
    parts: NonNegative,
    scrap: NonNegative,
    money: NonNegative,
    designs: NonNegative,
    products: NonNegative,
    plates: NonNegative,
  })
  .strict();

export const StartFileSchema = z
  .object({
    /** The printer the intro assembly produces (spec §6 phase 0). */
    printerId: IdSchema,
    /**
     * Bays the workshop opens with. The rest are bought one at a time through
     * `slots.json`, and the hard maximum (spec §4: 1 → 2 → 3 → 4) is this plus
     * the length of that list — so the cap cannot be misconfigured into
     * disagreeing with the unlocks that are meant to reach it.
     */
    slotCount: z.number().int().positive(),
    /**
     * Machines one bay can hold (spec §4). This is what makes a config slot
     * worth buying: a slot is not just a second recipe, it is the only way to
     * field more printers, so "how do I allocate my fleet across slots?"
     * becomes a real question instead of a cosmetic one. A fork may override it
     * — that is precisely what one giant printer means (spec §5B).
     */
    printersPerSlot: z.number().int().positive(),
    slotIdPrefix: IdSchema,
    startingResources: StartingResourcesSchema,
    startingFilament: z.array(StartingFilamentSchema),
    /** 6–8 pieces, attached in order — one click each (spec §6 phase 0). */
    assemblyPieces: z.array(AssemblyPieceSchema).min(1),
  })
  .strict();

// --- materials.json ---------------------------------------------------------

/**
 * Material identity (spec §3). One mechanical personality per material,
 * expressed entirely in the numbers below — the label is what the editor shows
 * and what a reader of the JSON can recognise the row by.
 */
export const MaterialIdentitySchema = z.enum([
  'cheap-and-infinite',
  'balanced-workhorse',
  'fine-detail',
  'structural',
  'exotic',
]);

/**
 * How a material is obtained. This is the Strategy selector of spec §15 for
 * pricing: `infinite` is always in stock at its flat `costPerGram` (PLA is
 * ~free and unlimited), `market` is priced and stock-limited by `market.json`,
 * and `printed` cannot be bought at all — late-game filament you make yourself.
 */
export const MaterialSupplySchema = z.enum(['infinite', 'market', 'printed']);

export const MaterialDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    identity: MaterialIdentitySchema,
    qualityTier: z.number().int().positive(),
    supply: MaterialSupplySchema,
    costPerGram: NonNegative,
    printSpeedMultiplier: Multiplier,
    /** Pity charge each print in this material adds (spec §7.1). */
    failureChargePerPrint: Fraction,
    /** Share of a failed print's filament that comes back as Scrap. */
    scrapRecoveryFraction: Fraction,
    valueMultiplier: Multiplier,
    /** Design-seconds a slot is out of action when switching *to* it (spec §3). */
    changeoverDesignSeconds: NonNegative,
    /** Filament purged from the *outgoing* spool by that switch (spec §3). */
    changeoverWasteGrams: NonNegative,
    unlockPhaseId: IdSchema,
    /** Machine node that must be installed first — `null` for the starters. */
    requiresUpgradeId: IdSchema.nullable(),
  })
  .strict();

export const MaterialsFileSchema = z.array(MaterialDefSchema).min(1);

// --- objects.json -----------------------------------------------------------

export const ObjectDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    printDesignSeconds: Positive,
    filamentGrams: Positive,
    partsYield: z.number().int().positive(),
    basePartValue: Positive,
    unlockPhaseId: IdSchema,
  })
  .strict();

export const ObjectsFileSchema = z.array(ObjectDefSchema).min(1);

// --- printers.json ----------------------------------------------------------

export const PrinterDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    machineTier: z.number().int().positive(),
    speedMultiplier: Multiplier,
    failureChargeMultiplier: Multiplier,
    costCurveId: IdSchema,
    costResource: ResourceKindSchema,
    degradationPerDesignHour: NonNegative,
    unlockPhaseId: IdSchema,
  })
  .strict();

export const PrintersFileSchema = z.array(PrinterDefSchema).min(1);

// --- upgrades.json ----------------------------------------------------------

/**
 * Upgrade effects (spec §5). Every node in every tree is expressed as a list of
 * these, and `systems/upgrades.ts` is the single generic interpreter that folds
 * the installed levels into a modifier set. Adding a node is a JSON edit; only
 * a genuinely new *kind* of effect touches code.
 *
 * `combine` says how levels and nodes stack, so the interpreter never has to
 * know what a particular effect means:
 * - `multiply` — the values of every installed level are multiplied together
 *   (speed, failure charge, yield).
 * - `add` — summed (extra config slots).
 * - `max` — the strongest node wins (the recycler's yield, machine tier).
 */
export const UpgradeEffectTypeSchema = z.enum([
  'failureChargeMultiplier',
  'printSpeedMultiplier',
  'partsYieldMultiplier',
  'machineTier',
  'recyclerYieldFraction',
  'marketFeeMultiplier',
]);

export const UpgradeEffectSchema = z
  .object({
    type: UpgradeEffectTypeSchema,
    combine: z.enum(['multiply', 'add', 'max']),
    value: z.number().finite(),
  })
  .strict();

export const UpgradeDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    tree: z.enum(['machine', 'farm', 'automation', 'design', 'endgame']),
    maxLevel: z.number().int().positive(),
    costCurveId: IdSchema,
    costResource: ResourceKindSchema,
    requiresUpgradeIds: z.array(IdSchema),
    unlockPhaseId: IdSchema,
    effects: z.array(UpgradeEffectSchema).min(1),
  })
  .strict();

export const UpgradesFileSchema = z.array(UpgradeDefSchema).min(1);

// --- slots.json -------------------------------------------------------------

/**
 * Config-slot progression (spec §4): **1 → 2 → 3 → 4 and stop**.
 *
 * One def per bay the player can buy, in the order they become available. The
 * hard maximum is `start.slotCount + slots.length`, so the "never unlimited"
 * rule is a property of the data rather than a constant someone has to remember
 * to keep in step. Slot 3 is expensive and slot 4 is prestige-gated purely
 * through the fields below — `costCurveId` shapes the price and `requires` is
 * the same metric gate the phase FSM uses, so slot 4's
 * `{ metric: "plates", atLeast: 1 }` locks it until M5 mints the first Plate.
 */
export const SlotUnlockDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    costCurveId: IdSchema,
    costResource: ResourceKindSchema,
    unlockPhaseId: IdSchema,
    requiresUpgradeIds: z.array(IdSchema),
    /** Extra state gates — empty for the ones a phase alone opens. */
    requires: z.array(RequirementSchema),
  })
  .strict();

export const SlotsFileSchema = z.array(SlotUnlockDefSchema);

// --- forks.json -------------------------------------------------------------

/**
 * The per-run fork of spec §5B: **Farm** (throughput) versus **Goliath** (one
 * giant printer, required for the largest endgame builds). Mutually exclusive
 * within a run — `GameState.forkId` holds the commitment and the reducer never
 * lets it be taken back.
 *
 * Both branches are ordinary content: a price, some gates, a list of the same
 * `UpgradeEffect` records the machine tree uses (so `computeModifiers` folds
 * them without knowing a fork exists), and two fields the rest of the game
 * reads instead of hard-coding "goliath":
 *
 * - `slotCapacity` — `null` keeps the normal slot progression; a number caps
 *   the workshop at that many bays, which is what makes Goliath *one* machine.
 * - `visual` — which way the renderer should draw the workshop.
 */
export const ForkLayoutSchema = z.enum(['rack', 'goliath']);

export const ForkDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    visual: ForkLayoutSchema,
    costCurveId: IdSchema,
    costResource: ResourceKindSchema,
    unlockPhaseId: IdSchema,
    requiresUpgradeIds: z.array(IdSchema),
    requires: z.array(RequirementSchema),
    /** Bays this branch allows; `null` means "whatever the slots you own". */
    slotCapacity: z.number().int().positive().nullable(),
    /** Machines one bay may hold; `null` keeps `start.printersPerSlot`. */
    printersPerSlot: z.number().int().positive().nullable(),
    /** Spec §7.3: the Fabricator print needs the giant machine (M6). */
    requiredForFinalPrint: z.boolean(),
    effects: z.array(UpgradeEffectSchema),
  })
  .strict();

export const ForksFileSchema = z.array(ForkDefSchema).min(2);

// --- designs.json -----------------------------------------------------------

export const DesignDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    requiredMaterialId: IdSchema,
    designDesignMinutes: Positive,
    printDesignSeconds: Positive,
    filamentGrams: Positive,
    baseProductValue: Positive,
    levelValueCurveId: IdSchema,
    printsPerLevel: z.number().int().positive(),
    unlockPhaseId: IdSchema,
  })
  .strict();

export const DesignsFileSchema = z.array(DesignDefSchema).min(1);

// --- market.json ------------------------------------------------------------

export const MarketListingSchema = z
  .object({
    materialId: IdSchema,
    basePricePerGram: Positive,
    stockGrams: Positive,
    restockGramsPerDesignMinute: NonNegative,
    unlockPhaseId: IdSchema,
  })
  .strict();

export const MarketModelSchema = z
  .object({
    /** Strategy selector (spec §15) interpreted by `systems/market.ts`. */
    strategy: z.enum(['sine-noise-supply', 'flat']),
    periodDesignMinutes: Positive,
    sineAmplitude: Fraction,
    noiseAmplitude: Fraction,
    /** Design minutes one pseudo-random noise sample holds for. */
    noiseStepDesignMinutes: Positive,
    /** How hard net player trading pushes the price around (spec §7.2). */
    supplyResponse: Fraction,
    /** Grams of net trade that move pressure by a full unit. */
    pressureScaleGrams: Positive,
    /** Share of the remaining pressure that decays each design minute. */
    pressureDecayPerDesignMinute: Fraction,
    minPriceMultiplier: Multiplier,
    maxPriceMultiplier: Multiplier,
    /**
     * The spread the house keeps: you buy at the price and sell at
     * `price × (1 − spread)`. This is what makes a buy/sell round-trip a loss
     * rather than a money printer (spec §13, "round-trips never create value").
     */
    spread: Fraction,
  })
  .strict()
  .refine((model) => model.maxPriceMultiplier >= model.minPriceMultiplier, {
    message: 'maxPriceMultiplier must be at least minPriceMultiplier',
    path: ['maxPriceMultiplier'],
  });

export const MarketFileSchema = z
  .object({
    model: MarketModelSchema,
    listings: z.array(MarketListingSchema).min(1),
  })
  .strict();

// --- automation.json --------------------------------------------------------

/**
 * Automation (spec §5C): introduce friction, then sell its removal. Each def is
 * a *behaviour* plus the numbers that behaviour needs, as a discriminated union
 * so the schema itself rules out an auto-seller with trading thresholds. The
 * interpreter in `systems/automation.ts` switches on `behavior` — the Strategy
 * pattern of spec §15, selected by content.
 */
const AutomationBase = {
  id: IdSchema,
  name: z.string().min(1),
  costCurveId: IdSchema,
  costResource: ResourceKindSchema,
  unlockPhaseId: IdSchema,
  requiresUpgradeIds: z.array(IdSchema),
  /** Tier-1 automations are a single install; later tiers can raise this. */
  maxLevel: z.number().int().positive(),
  /** Design-seconds between firings — the bot inside the machine's check-in. */
  intervalDesignSeconds: Positive,
};

export const SellPartsAutomationSchema = z
  .object({
    ...AutomationBase,
    behavior: z.literal('sell-parts'),
    /** Sell once the parts pile reaches this many. Player-editable. */
    defaultThreshold: NonNegative,
  })
  .strict();

export const BuyFilamentAutomationSchema = z
  .object({
    ...AutomationBase,
    behavior: z.literal('buy-filament'),
    /** Top the loaded material back up to this many grams. */
    defaultThreshold: NonNegative,
    /** Never spend the last of the till: keep this much money in reserve. */
    moneyReserve: NonNegative,
  })
  .strict();

export const TradeFilamentAutomationSchema = z
  .object({
    ...AutomationBase,
    behavior: z.literal('trade-filament'),
    /** Grams moved per firing. */
    defaultThreshold: Positive,
    /** Buy when the price multiplier is below this. */
    buyBelowMultiplier: Multiplier,
    /** Sell when it is above this. */
    sellAboveMultiplier: Multiplier,
    /** Never hold more than this many grams of a traded material. */
    maxHoldingGrams: Positive,
  })
  .strict();

/**
 * Auto-changeover (spec §5B/§5C): the slot's **print queue** runs itself. The
 * player writes a rota of `{ material, object }` entries onto a slot; while this
 * automation is installed *and* switched on, the slot rotates to the next entry
 * by itself once the current one has printed its batches. Switch it off and the
 * rota freezes where it is — the friction comes back, which is the whole design
 * brief for the automation tree.
 *
 * `defaultThreshold` is the stock floor: the rota will not purge into a material
 * the workshop cannot feed, which is the failure mode this automation would
 * otherwise cause every time the market ran dry.
 */
export const ChangeoverAutomationSchema = z
  .object({
    ...AutomationBase,
    behavior: z.literal('auto-changeover'),
    /** Grams of the *incoming* material required before the rota advances. */
    defaultThreshold: NonNegative,
  })
  .strict();

export const AutomationDefSchema = z.discriminatedUnion('behavior', [
  SellPartsAutomationSchema,
  BuyFilamentAutomationSchema,
  TradeFilamentAutomationSchema,
  ChangeoverAutomationSchema,
]);

export const AutomationFileSchema = z.array(AutomationDefSchema).min(1);

// --- failure.json -----------------------------------------------------------

/**
 * The failure model (spec §7.1): a **deterministic pity timer**, not a dice
 * roll. Every print adds `material.failureChargePerPrint × modifiers` to the
 * slot's charge; when the charge crosses `chargeThreshold` the *next* print
 * fails and the threshold is subtracted. A player can therefore predict — and
 * an upgrade can visibly reduce — how often the workshop wastes a spool.
 *
 * The recycler is the consolation loop: Scrap converts back into filament at
 * `recycler.yieldFraction` of the value it carried in, which is strictly less
 * than one, so recycling can never mint value (spec §13).
 */
export const FailureFileSchema = z
  .object({
    model: z
      .object({
        strategy: z.enum(['pity-timer', 'never']),
        chargeThreshold: Positive,
        /** Charge left on the slot after a failure, as a share of the threshold. */
        carryFraction: Fraction,
      })
      .strict(),
    recycler: z
      .object({
        /** Machine node that must be installed before Scrap can be recycled. */
        requiresUpgradeId: IdSchema,
        /** Share of the scrap's banked value that survives recycling (< 1). */
        yieldFraction: z.number().finite().positive().max(1),
      })
      .strict(),
  })
  .strict();

// --- prestige.json ----------------------------------------------------------

export const PrestigeFileSchema = z
  .object({
    requiredDesignId: IdSchema,
    plateCurveId: IdSchema,
    moneyPrintCurveId: IdSchema,
    meltdownDesignSeconds: Positive,
    retainedResources: z.array(ResourceKindSchema).min(1),
    plateInputResource: ResourceKindSchema,
    plateInputScale: Positive,
  })
  .strict();

// --- the whole content set --------------------------------------------------

export const ContentSchema = z
  .object({
    pacing: PacingFileSchema,
    start: StartFileSchema,
    curves: CurvesFileSchema,
    materials: MaterialsFileSchema,
    objects: ObjectsFileSchema,
    printers: PrintersFileSchema,
    upgrades: UpgradesFileSchema,
    slots: SlotsFileSchema,
    forks: ForksFileSchema,
    designs: DesignsFileSchema,
    market: MarketFileSchema,
    automation: AutomationFileSchema,
    failure: FailureFileSchema,
    prestige: PrestigeFileSchema,
  })
  .strict();

/** File name (without extension) → schema, used by the validator and editor. */
export const CONTENT_FILE_SCHEMAS = {
  pacing: PacingFileSchema,
  start: StartFileSchema,
  curves: CurvesFileSchema,
  materials: MaterialsFileSchema,
  objects: ObjectsFileSchema,
  printers: PrintersFileSchema,
  upgrades: UpgradesFileSchema,
  slots: SlotsFileSchema,
  forks: ForksFileSchema,
  designs: DesignsFileSchema,
  market: MarketFileSchema,
  automation: AutomationFileSchema,
  failure: FailureFileSchema,
  prestige: PrestigeFileSchema,
} as const;

export type ContentFileName = keyof typeof CONTENT_FILE_SCHEMAS;

export const CONTENT_FILE_NAMES = Object.keys(CONTENT_FILE_SCHEMAS) as readonly ContentFileName[];

export type ResourceKind = z.infer<typeof ResourceKindSchema>;
export type ScalarResourceKind = z.infer<typeof ScalarResourceKindSchema>;
export type GatedActionType = z.infer<typeof GatedActionTypeSchema>;
export type Metric = z.infer<typeof MetricSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type PhaseDef = z.infer<typeof PhaseDefSchema>;
export type PacingContent = z.infer<typeof PacingFileSchema>;
export type AssemblyPieceDef = z.infer<typeof AssemblyPieceSchema>;
export type StartingFilament = z.infer<typeof StartingFilamentSchema>;
export type StartContent = z.infer<typeof StartFileSchema>;
export type MaterialIdentity = z.infer<typeof MaterialIdentitySchema>;
export type MaterialSupply = z.infer<typeof MaterialSupplySchema>;
export type MaterialDef = z.infer<typeof MaterialDefSchema>;
export type ObjectDef = z.infer<typeof ObjectDefSchema>;
export type PrinterDef = z.infer<typeof PrinterDefSchema>;
export type UpgradeEffectType = z.infer<typeof UpgradeEffectTypeSchema>;
export type UpgradeEffect = z.infer<typeof UpgradeEffectSchema>;
export type UpgradeDef = z.infer<typeof UpgradeDefSchema>;
export type SlotUnlockDef = z.infer<typeof SlotUnlockDefSchema>;
export type ForkLayout = z.infer<typeof ForkLayoutSchema>;
export type ForkDef = z.infer<typeof ForkDefSchema>;
export type DesignDef = z.infer<typeof DesignDefSchema>;
export type MarketListing = z.infer<typeof MarketListingSchema>;
export type MarketModel = z.infer<typeof MarketModelSchema>;
export type MarketContent = z.infer<typeof MarketFileSchema>;
export type AutomationDef = z.infer<typeof AutomationDefSchema>;
export type AutomationBehavior = AutomationDef['behavior'];
export type SellPartsAutomationDef = z.infer<typeof SellPartsAutomationSchema>;
export type BuyFilamentAutomationDef = z.infer<typeof BuyFilamentAutomationSchema>;
export type TradeFilamentAutomationDef = z.infer<typeof TradeFilamentAutomationSchema>;
export type ChangeoverAutomationDef = z.infer<typeof ChangeoverAutomationSchema>;
export type FailureContent = z.infer<typeof FailureFileSchema>;
export type PrestigeContent = z.infer<typeof PrestigeFileSchema>;
export type Content = z.infer<typeof ContentSchema>;
export type RawContent = Record<ContentFileName, unknown>;
