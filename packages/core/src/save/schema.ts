import { z } from 'zod';
import { SAVE_SCHEMA_VERSION } from './version.js';

export const RngSnapshotSchema = z
  .object({
    seed: z.number().int(),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const GameStateV1Schema = z
  .object({
    saveVersion: z.literal(SAVE_SCHEMA_VERSION),
    simTimeMs: z.number().finite().nonnegative(),
    tickCount: z.number().int().nonnegative(),
    phaseId: z.string().min(1),
    rng: RngSnapshotSchema,
  })
  .strict();

export const SaveFileSchema = z
  .object({
    version: z.number().int().positive(),
    savedAtMs: z.number().finite().nonnegative(),
    state: z.unknown(),
  })
  .strict();

export type SaveFile = z.infer<typeof SaveFileSchema>;
export type GameStateV1 = z.infer<typeof GameStateV1Schema>;
