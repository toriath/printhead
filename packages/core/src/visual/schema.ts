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
 * - v3 (M2) — **frozen**: every slot is projected (empty bays included) so the
 *   renderer can draw the "max 4, faint outline" rule from data alone.
 */
export const VISUAL_STATE_VERSION = 3;

const NonNegative = z.number().finite().nonnegative();
const NonNegativeInt = z.number().int().nonnegative();
/** 0..1 — the renderer never has to clamp. */
const Unit = z.number().finite().min(0).max(1);
const NonEmpty = z.string().min(1);

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
    objectId: NonEmpty.nullable(),
    objectName: NonEmpty.nullable(),
    machineTier: NonNegativeInt,
    printerCount: NonNegativeInt,
    /** 0..1 animation offset so identical printers do not move in lockstep. */
    phaseOffset: Unit,
    /** Configured *and* staffed: anything else draws as a faint empty bay. */
    occupied: z.boolean(),
    running: z.boolean(),
    /** 0..1 through the current batch. */
    progress: Unit,
    batch: NonNegativeInt,
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
    filamentGrams: z.record(NonEmpty, NonNegative),
  })
  .strict();

export const VisualStateSchema = z
  .object({
    version: z.literal(VISUAL_STATE_VERSION),
    phaseId: NonEmpty,
    /** Display name from `pacing.json` — the renderer holds no content table. */
    phaseName: NonEmpty,
    simTimeMs: NonNegative,
    /** Hard maximum number of bays to draw (spec §4: 1 → 2 → 3 → 4). */
    slotCapacity: z.number().int().positive(),
    slots: z.array(SlotVisualSchema),
    assembly: AssemblyVisualSchema,
    ledger: LedgerVisualSchema,
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

export type SlotVisual = DeepReadonly<z.infer<typeof SlotVisualSchema>>;
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
