import { z } from 'zod';
import { SAVE_SCHEMA_VERSION } from './version.js';

export const RngSnapshotSchema = z
  .object({
    seed: z.number().int(),
    count: z.number().int().nonnegative(),
  })
  .strict();

const NonNegative = z.number().finite().nonnegative();

/**
 * v1 (M0) — kept forever so the fixture corpus can prove it still loads
 * (spec §13, "Saves"). The migration to v2 lives in `migrations.ts`.
 */
export const GameStateV1Schema = z
  .object({
    saveVersion: z.literal(1),
    simTimeMs: NonNegative,
    tickCount: z.number().int().nonnegative(),
    phaseId: z.string().min(1),
    rng: RngSnapshotSchema,
  })
  .strict();

export const ResourceLedgerSchema = z
  .object({
    parts: NonNegative,
    scrap: NonNegative,
    money: NonNegative,
    designs: NonNegative,
    products: NonNegative,
    plates: NonNegative,
  })
  .strict();

export const FilamentLedgerSchema = z.record(z.string().min(1), NonNegative);
export const PrinterLedgerSchema = z.record(z.string().min(1), z.number().int().nonnegative());

export const AssemblyStateSchema = z
  .object({
    attachedPieceIds: z.array(z.string().min(1)),
    cooldownMs: NonNegative,
  })
  .strict();

export const PrintRunStateSchema = z
  .object({
    remainingMs: z.number().finite(),
    totalMs: z.number().finite().positive(),
    batch: z.number().int().positive(),
  })
  .strict();

/** v2 (M1) — kept for the frozen fixture; migrated to v3 by `migrations.ts`. */
export const SlotStateV2Schema = z
  .object({
    id: z.string().min(1),
    materialId: z.string().min(1).nullable(),
    objectId: z.string().min(1).nullable(),
    printerCount: z.number().int().nonnegative(),
    autoRestart: z.boolean(),
    run: PrintRunStateSchema.nullable(),
  })
  .strict();

export const StatsStateV2Schema = z
  .object({
    printsCompleted: z.number().int().nonnegative(),
    partsProduced: NonNegative,
    partsSold: NonNegative,
    moneyEarned: NonNegative,
    filamentPurchasedGrams: NonNegative,
  })
  .strict();

export const GameStateV2Schema = z
  .object({
    saveVersion: z.literal(2),
    simTimeMs: NonNegative,
    tickCount: z.number().int().nonnegative(),
    phaseId: z.string().min(1),
    phaseEnteredAtMs: NonNegative,
    rng: RngSnapshotSchema,
    resources: ResourceLedgerSchema,
    partsValue: NonNegative,
    filamentGrams: FilamentLedgerSchema,
    printers: PrinterLedgerSchema,
    slots: z.array(SlotStateV2Schema),
    assembly: AssemblyStateSchema,
    stats: StatsStateV2Schema,
  })
  .strict();

// --- v3 (M3) ----------------------------------------------------------------

/** v3 (M3) — kept for the frozen fixture; migrated to v4 by `migrations.ts`. */
export const SlotStateV3Schema = SlotStateV2Schema.extend({
  failureCharge: NonNegative,
  changeoverMs: NonNegative,
}).strict();

export const StatsStateSchema = StatsStateV2Schema.extend({
  printsFailed: z.number().int().nonnegative(),
  filamentSoldGrams: NonNegative,
  scrapProducedGrams: NonNegative,
  scrapRecycledGrams: NonNegative,
}).strict();

export const UpgradeLedgerSchema = z.record(z.string().min(1), z.number().int().nonnegative());

export const AutomationSlotStateSchema = z
  .object({
    level: z.number().int().nonnegative(),
    enabled: z.boolean(),
    threshold: NonNegative,
    cooldownMs: z.number().finite(),
  })
  .strict();

export const AutomationLedgerSchema = z.record(z.string().min(1), AutomationSlotStateSchema);

export const MarketMaterialStateSchema = z
  .object({
    stockGrams: NonNegative,
    /** Signed: negative when the player has been buying, positive when dumping. */
    pressure: z.number().finite(),
  })
  .strict();

export const MarketLedgerSchema = z.record(z.string().min(1), MarketMaterialStateSchema);

export const GameStateV3Schema = z
  .object({
    saveVersion: z.literal(3),
    simTimeMs: NonNegative,
    tickCount: z.number().int().nonnegative(),
    phaseId: z.string().min(1),
    phaseEnteredAtMs: NonNegative,
    rng: RngSnapshotSchema,
    resources: ResourceLedgerSchema,
    partsValue: NonNegative,
    scrapValue: NonNegative,
    filamentGrams: FilamentLedgerSchema,
    printers: PrinterLedgerSchema,
    upgrades: UpgradeLedgerSchema,
    automation: AutomationLedgerSchema,
    market: MarketLedgerSchema,
    slots: z.array(SlotStateV3Schema),
    assembly: AssemblyStateSchema,
    stats: StatsStateSchema,
  })
  .strict();

// --- v4 (M4) ----------------------------------------------------------------

/** One entry of a slot's print rota (spec §5B). */
export const SlotQueueEntrySchema = z
  .object({
    materialId: z.string().min(1),
    objectId: z.string().min(1),
    batches: z.number().int().positive(),
  })
  .strict();

/** v4 (M4) — kept for the frozen fixture; migrated to v5 by `migrations.ts`. */
export const SlotStateV4Schema = SlotStateV3Schema.extend({
  queue: z.array(SlotQueueEntrySchema),
  queueIndex: z.number().int().nonnegative(),
  queueBatches: z.number().int().nonnegative(),
}).strict();

export const StatsStateV4Schema = StatsStateSchema;

export const GameStateV4Schema = GameStateV3Schema.extend({
  saveVersion: z.literal(4),
  slots: z.array(SlotStateV4Schema),
  /** The run's Farm/Goliath commitment (spec §5B); `null` until it is made. */
  forkId: z.string().min(1).nullable(),
}).strict();

// --- v5 (M5) ----------------------------------------------------------------

/** A bay prints an object *or* a Design (spec §5D) — never both. */
export const SlotStateSchema = SlotStateV4Schema.extend({
  designId: z.string().min(1).nullable(),
}).strict();

export const DesignStateSchema = z
  .object({
    level: z.number().int().positive(),
    printsOnLevel: NonNegative,
  })
  .strict();

export const DesignLedgerSchema = z.record(z.string().min(1), DesignStateSchema);

export const StudioProjectStateSchema = z
  .object({
    designId: z.string().min(1),
    remainingMs: NonNegative,
  })
  .strict();

export const MoneyPrinterLedgerSchema = z.record(z.string().min(1), z.number().int().nonnegative());

export const StatsStateV5Schema = StatsStateSchema.extend({
  productsProduced: NonNegative,
  productsSold: NonNegative,
  moneyPrinted: NonNegative,
  prestigeCount: z.number().int().nonnegative(),
}).strict();

export const GameStateV5Schema = GameStateV4Schema.extend({
  saveVersion: z.literal(SAVE_SCHEMA_VERSION),
  productsValue: NonNegative,
  slots: z.array(SlotStateSchema),
  designs: DesignLedgerSchema,
  studio: StudioProjectStateSchema.nullable(),
  moneyPrinters: MoneyPrinterLedgerSchema,
  selfAssembling: z.boolean(),
  stats: StatsStateV5Schema,
}).strict();

/** The schema of the *current* state shape — what `fromSaveFile` validates against. */
export const GameStateSchema = GameStateV5Schema;

export const SaveFileSchema = z
  .object({
    version: z.number().int().positive(),
    savedAtMs: NonNegative,
    state: z.unknown(),
  })
  .strict();

export type SaveFile = z.infer<typeof SaveFileSchema>;
export type GameStateV1 = z.infer<typeof GameStateV1Schema>;
export type GameStateV2 = z.infer<typeof GameStateV2Schema>;
export type GameStateV3 = z.infer<typeof GameStateV3Schema>;
export type GameStateV4 = z.infer<typeof GameStateV4Schema>;
export type GameStateV5 = z.infer<typeof GameStateV5Schema>;
