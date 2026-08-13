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
  'PRINT_SECTION',
  'START_FABRICATOR',
  'NEW_GAME_PLUS',
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
  'CREATE_DESIGN',
  'SET_SLOT_DESIGN',
  'SELL_PRODUCTS',
  'PRESTIGE',
  'BUY_MONEY_PRINTER',
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
  'products',
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
  /** Designs owned — they survive prestige, so this only ever grows (spec §5D). */
  'designs',
  /** Total levels across every design: how much the studio has been *used*. */
  'designLevels',
  /** 1 once `prestige.requiredDesignId` exists — the Money Plate capstone. */
  'capstoneDesigned',
  'productsProduced',
  'productsSold',
  /** Melt-downs completed (spec §5D). */
  'prestigeCount',
  /** Money the Plates have printed directly (spec §5E). */
  'moneyPrinted',
  'moneyPrintersInstalled',
  /** Levels installed in the Endgame Tree (spec §5E) — the Plate sink. */
  'endgameNodes',
  /** Fabricator sections pre-printed (spec §7.3). */
  'fabricatorSections',
  /** 1 once the Universal Fabricator has finished printing (spec §6 phase 6). */
  'fabricatorComplete',
  /** 1 once the ending sequence has run its course — the FSM's last gate. */
  'endingComplete',
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
    /**
     * Design slots the studio opens with (spec §5D: "design slots"). Designs
     * are permanent and survive prestige, so the slot count is what stops the
     * player from simply owning every design at once; the design tree sells
     * more of them through a `designSlots` upgrade effect.
     */
    designSlots: z.number().int().positive(),
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
    /**
     * What a gram is paid for in. Everything the workshop buys with Money says
     * so here, and the endgame's exotic feedstock says `plates` — which is the
     * whole of spec §3's "Composite/exotic … Cost: Plates". The market prices a
     * gram; this says which till the money comes out of, so a material bought
     * with prestige currency needs no second buying path.
     */
    priceResource: ScalarResourceKindSchema,
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
    /**
     * **Stub.** Maintenance and degradation (spec §5C) are not implemented:
     * nothing in `systems/` reads this field yet. It is authored here so the
     * shape is settled and the numbers can be balanced when the maintenance
     * bots land; until then it is inert by design, not by accident.
     */
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
  /** Extra Design Studio slots (spec §5D) — `add`, so nodes stack. */
  'designSlots',
  /** Money value of a printed Product (spec §5D) — the studio's own tree. */
  'productValueMultiplier',
  /**
   * Printers the printed factory turns out per design-minute (spec §5E:
   * "print a factory (outputs printers)"). `add`, so factory levels stack.
   */
  'printerFactoryRate',
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

/**
 * The Design Studio (spec §5D).
 *
 * A Design is drafted once — it costs Money and occupies the studio for
 * `designDesignMinutes` — and is then **permanent**: it survives prestige, and
 * printing it makes Products instead of Parts. Every batch printed levels the
 * design up (`printsPerLevel`), and `levelValueCurveId` turns that level into
 * the multiplier on `baseProductValue`, which is the whole reason to keep
 * printing one design rather than drafting another.
 *
 * `requiredMaterialId` is how spec §3's "resin is **required** for
 * Designs/Products/Plates" is expressed: the studio simply cannot draft a
 * design whose material the machine tree has not opened.
 */
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
    /** Levels stop here, so the value multiplier cannot run away. */
    maxLevel: z.number().int().positive(),
    /** Drafting is the Money sink of spec §2's resource flow. */
    costCurveId: IdSchema,
    costResource: ResourceKindSchema,
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

/**
 * One tier of the money printer (spec §5E: bills → bundles → pallets → "the
 * central bank"). Tier 1 ships in M5 as the first sink for Plates; the deeper
 * tiers are M6 and are added here as data, not as code.
 *
 * `rateCurveId` is evaluated at the **Plate count**, which is what makes money
 * printing monotone in Plates (spec §13) without any system knowing the
 * formula: a curve that does not decrease in `n` cannot produce a rate that
 * decreases in Plates.
 */
export const MoneyPrinterDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    tier: z.number().int().positive(),
    costCurveId: IdSchema,
    costResource: ResourceKindSchema,
    maxLevel: z.number().int().positive(),
    /** Money per design-second, per installed level, read at `plates`. */
    rateCurveId: IdSchema,
    unlockPhaseId: IdSchema,
  })
  .strict();

/**
 * Prestige (spec §5D): the melt-down. The run is scrapped, Designs survive
 * exactly, and the wreckage is engraved into Plates.
 *
 * `plateInputResource × plateInputScale` is the reading the `plateCurveId`
 * curve turns into Plates, so both the input and the shape of the reward are
 * content. `retainedResources` and `retainedLedgers` are the *whole* rule for
 * what survives — nothing in `systems/` names a resource or a ledger — which is
 * what makes "prestige preserves Designs exactly" a property of the data as
 * well as of the code.
 */
export const PrestigeFileSchema = z
  .object({
    requiredDesignId: IdSchema,
    plateCurveId: IdSchema,
    moneyPrintCurveId: IdSchema,
    meltdownDesignSeconds: Positive,
    retainedResources: z.array(ResourceKindSchema).min(1),
    /**
     * Keyed ledgers carried across a melt-down whole. Designs are the spec's
     * named survivor (§2), and the money printers join them because they are
     * bought with Plates: an endgame node paid for in prestige currency that
     * the next melt-down confiscates would be a tax, not a reward (§5E).
     *
     * The same argument carries the whole **Endgame Tree** across, for the same
     * reason — every node in it is priced in Plates — and the Fabricator's
     * pre-printed sections, which is precisely how a Farm build hands its work
     * to the Goliath run that finishes the job (§7.3). As always the list is
     * the *only* place any of this is decided.
     */
    retainedLedgers: z
      .array(z.enum(['designs', 'moneyPrinters', 'endgameTree', 'fabricator']))
      .min(1),
    plateInputResource: ResourceKindSchema,
    plateInputScale: Positive,
    /** Plates a melt-down must be worth before the button does anything. */
    minimumPlates: Positive,
    unlockPhaseId: IdSchema,
    moneyPrinters: z.array(MoneyPrinterDefSchema).min(1),
  })
  .strict()
  .refine(
    (prestige) =>
      !prestige.retainedLedgers.includes('designs') ||
      prestige.retainedResources.includes('designs'),
    {
      // `resources.designs` mirrors the ledger for the phase gates to read;
      // keeping one and dropping the other would leave the count lying.
      message: 'retaining the designs ledger requires retaining the designs resource',
      path: ['retainedResources'],
    },
  );

// --- endgame.json -----------------------------------------------------------

/**
 * On-screen inflation (spec §6 phase 5: "the economy eats itself").
 *
 * The index is a curve read at a *reading of the simulation* — by default the
 * Money the Plates have printed — so the devaluation is caused by the player's
 * own money printers rather than by a timer. It never falls below 1 and never
 * passes `maxMultiplier`, so a runaway curve cannot produce an unrenderable
 * price. `startPhaseId` is when it switches on: before that the index is
 * exactly 1 and nothing in the economy is touched.
 */
/**
 * Which reading of the run drives the inflation index.
 *
 * Deliberately a *narrow* selector rather than the whole `Metric` union: the
 * index is read on every market quote and every batch that comes off a bed, so
 * it has to be computable from `stats` alone. Going through the general metric
 * interpreter would drag the automation, the market and the studio in behind
 * it — and those all ask the market for a price, which asks for the index.
 */
export const InflationMetricSchema = z.enum(['moneyPrinted', 'moneyEarned', 'platesEarned']);

export const InflationSchema = z
  .object({
    startPhaseId: IdSchema,
    metric: InflationMetricSchema,
    /** The reading is scaled before the curve sees it, so curves stay readable. */
    inputScale: Positive,
    curveId: IdSchema,
    maxMultiplier: Multiplier,
  })
  .strict();

/**
 * A backdrop the workshop is drawn against (spec §5E: "print a building
 * (backdrop change)"). The first entry with `requiresUpgradeId: null` is the
 * default; the last one whose node is installed wins, so the list reads as a
 * progression and the renderer only ever receives an id.
 */
export const BackdropDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    requiresUpgradeId: IdSchema.nullable(),
  })
  .strict();

/** The printed factory (spec §5E): a node that turns out machines by itself. */
export const FactoryDefSchema = z
  .object({
    /** Which printer the factory produces — an ordinary `printers.json` def. */
    printerId: IdSchema,
  })
  .strict();

/**
 * The Universal Fabricator (spec §6 phase 6, §7.3) — the final print.
 *
 * It needs the blueprint, every active bay committed to it, and the fork that
 * declares `requiredForFinalPrint` (spec §7.3: Goliath). A Farm build stays
 * viable by **pre-printing sections**: each finished section takes
 * `sectionDesignMinutes` off the final build, and sections survive a melt-down
 * when `prestige.retainedLedgers` says so — which is exactly how a Farm run
 * hands its work to the Goliath run that follows.
 */
export const FabricatorDefSchema = z
  .object({
    requiresUpgradeId: IdSchema,
    /** Feedstock for the build — the endgame material, bought with Plates. */
    materialId: IdSchema,
    filamentGrams: Positive,
    /** The full build, before any pre-printed section shortens it. */
    designMinutes: Positive,
    /** Never shorter than this, however many sections were pre-printed. */
    minDesignMinutes: Positive,
    /** Layers the synced render draws (spec §6: "layer by layer"). */
    layers: z.number().int().positive(),
    /**
     * Machines that must be standing in the committed bays before the print
     * will start (spec §4: "a deliberate return to total commitment"). Without
     * a number here "all slots committed" would mean one manned bay under a
     * Goliath run, which is no commitment at all.
     */
    requiredPrinters: z.number().int().positive(),
    maxSections: z.number().int().positive(),
    sectionDesignMinutes: Positive,
    sectionFilamentGrams: Positive,
    sectionCostCurveId: IdSchema,
    sectionCostResource: ResourceKindSchema,
  })
  .strict()
  .refine((def) => def.minDesignMinutes <= def.designMinutes, {
    message: 'minDesignMinutes must not exceed designMinutes',
    path: ['minDesignMinutes'],
  });

/**
 * The ending (spec §6 phase 6): "numbers fade to ∞ → museum shot of printer #1
 * → credits print out". The three stages are durations in design-seconds and
 * the credits are content, so the whole sequence is data.
 */
export const EndingDefSchema = z
  .object({
    numbersDesignSeconds: Positive,
    museumDesignSeconds: Positive,
    creditsDesignSeconds: Positive,
    /** The machine the museum shot puts under glass — printer #1. */
    museumPrinterId: IdSchema,
    /** A blank line is a spacer in a credit roll, so empty strings are allowed. */
    credits: z.array(z.string()).min(1),
  })
  .strict();

/**
 * New Game Plus (spec §18 M6): "a new run keeping designs + optional
 * modifiers". What survives is named here exactly as prestige names it, and the
 * modifiers are ordinary `UpgradeEffect` bundles the player opts into, folded
 * by the same interpreter the trees use — so a new modifier is a JSON edit.
 */
export const NewGamePlusModifierSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    effects: z.array(UpgradeEffectSchema).min(1),
  })
  .strict();

export const NewGamePlusSchema = z
  .object({
    retainedResources: z.array(ResourceKindSchema),
    retainedLedgers: z.array(z.enum(['designs', 'moneyPrinters'])),
    modifiers: z.array(NewGamePlusModifierSchema),
  })
  .strict();

export const EndgameFileSchema = z
  .object({
    inflation: InflationSchema,
    backdrops: z.array(BackdropDefSchema).min(1),
    factory: FactoryDefSchema,
    fabricator: FabricatorDefSchema,
    ending: EndingDefSchema,
    newGamePlus: NewGamePlusSchema,
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
    endgame: EndgameFileSchema,
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
  endgame: EndgameFileSchema,
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
export type MoneyPrinterDef = z.infer<typeof MoneyPrinterDefSchema>;
export type PrestigeContent = z.infer<typeof PrestigeFileSchema>;
export type RetainedLedger = PrestigeContent['retainedLedgers'][number];
export type InflationMetric = z.infer<typeof InflationMetricSchema>;
export type InflationDef = z.infer<typeof InflationSchema>;
export type BackdropDef = z.infer<typeof BackdropDefSchema>;
export type FactoryDef = z.infer<typeof FactoryDefSchema>;
export type FabricatorDef = z.infer<typeof FabricatorDefSchema>;
export type EndingDef = z.infer<typeof EndingDefSchema>;
export type NewGamePlusModifier = z.infer<typeof NewGamePlusModifierSchema>;
export type NewGamePlusContent = z.infer<typeof NewGamePlusSchema>;
export type EndgameContent = z.infer<typeof EndgameFileSchema>;
export type Content = z.infer<typeof ContentSchema>;
export type RawContent = Record<ContentFileName, unknown>;
