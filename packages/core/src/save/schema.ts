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

export const SlotStateSchema = z
  .object({
    id: z.string().min(1),
    materialId: z.string().min(1).nullable(),
    objectId: z.string().min(1).nullable(),
    printerCount: z.number().int().nonnegative(),
    autoRestart: z.boolean(),
    run: PrintRunStateSchema.nullable(),
  })
  .strict();

export const StatsStateSchema = z
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
    saveVersion: z.literal(SAVE_SCHEMA_VERSION),
    simTimeMs: NonNegative,
    tickCount: z.number().int().nonnegative(),
    phaseId: z.string().min(1),
    phaseEnteredAtMs: NonNegative,
    rng: RngSnapshotSchema,
    resources: ResourceLedgerSchema,
    partsValue: NonNegative,
    filamentGrams: FilamentLedgerSchema,
    printers: PrinterLedgerSchema,
    slots: z.array(SlotStateSchema),
    assembly: AssemblyStateSchema,
    stats: StatsStateSchema,
  })
  .strict();

/** The schema of the *current* state shape — what `fromSaveFile` validates against. */
export const GameStateSchema = GameStateV2Schema;

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
