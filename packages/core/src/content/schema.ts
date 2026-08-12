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
  'BUY_PRINTER',
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
  'printers',
  'partsProduced',
  'partsSold',
  'printsCompleted',
  'piecesAttached',
  'assemblyProgress',
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
    slotCount: z.number().int().positive(),
    slotIdPrefix: IdSchema,
    startingResources: StartingResourcesSchema,
    startingFilament: z.array(StartingFilamentSchema),
    /** 6–8 pieces, attached in order — one click each (spec §6 phase 0). */
    assemblyPieces: z.array(AssemblyPieceSchema).min(1),
  })
  .strict();

// --- materials.json ---------------------------------------------------------

export const MaterialDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    identity: z.string().min(1),
    qualityTier: z.number().int().positive(),
    supply: z.enum(['infinite', 'market', 'printed']),
    costPerGram: NonNegative,
    printSpeedMultiplier: Multiplier,
    failureChargePerPrint: Fraction,
    scrapRecoveryFraction: Fraction,
    valueMultiplier: Multiplier,
    unlockPhaseId: IdSchema,
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

export const UpgradeEffectSchema = z
  .object({
    type: z.enum([
      'failureChargeMultiplier',
      'printSpeedMultiplier',
      'partsYieldMultiplier',
      'configSlots',
    ]),
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

export const MarketFileSchema = z
  .object({
    model: z
      .object({
        strategy: z.enum(['sine-noise-supply', 'flat']),
        periodDesignMinutes: Positive,
        sineAmplitude: Fraction,
        noiseAmplitude: Fraction,
        supplyResponse: Fraction,
        minPriceMultiplier: Multiplier,
        maxPriceMultiplier: Multiplier,
      })
      .strict(),
    listings: z.array(MarketListingSchema).min(1),
  })
  .strict();

// --- automation.json --------------------------------------------------------

export const AutomationDefSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    costCurveId: IdSchema,
    costResource: ResourceKindSchema,
    unlockPhaseId: IdSchema,
    intervalDesignSeconds: Positive,
    defaultThreshold: NonNegative,
  })
  .strict();

export const AutomationFileSchema = z.array(AutomationDefSchema).min(1);

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
    designs: DesignsFileSchema,
    market: MarketFileSchema,
    automation: AutomationFileSchema,
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
  designs: DesignsFileSchema,
  market: MarketFileSchema,
  automation: AutomationFileSchema,
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
export type MaterialDef = z.infer<typeof MaterialDefSchema>;
export type ObjectDef = z.infer<typeof ObjectDefSchema>;
export type PrinterDef = z.infer<typeof PrinterDefSchema>;
export type UpgradeEffect = z.infer<typeof UpgradeEffectSchema>;
export type UpgradeDef = z.infer<typeof UpgradeDefSchema>;
export type DesignDef = z.infer<typeof DesignDefSchema>;
export type MarketListing = z.infer<typeof MarketListingSchema>;
export type MarketContent = z.infer<typeof MarketFileSchema>;
export type AutomationDef = z.infer<typeof AutomationDefSchema>;
export type PrestigeContent = z.infer<typeof PrestigeFileSchema>;
export type Content = z.infer<typeof ContentSchema>;
export type RawContent = Record<ContentFileName, unknown>;
