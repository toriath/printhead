import { z } from 'zod';

/**
 * Curves are *named parametric records* (spec §11): content never stores a
 * formula, only a type plus its parameters. `packages/core/src/curves` is the
 * only place that knows how to turn such a record into a number.
 */
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const IdSchema = z.string().regex(ID_PATTERN, 'ids must be kebab-case ascii');

const CurveBase = {
  id: IdSchema,
  name: z.string().min(1),
};

export const ConstantCurveSchema = z
  .object({ ...CurveBase, type: z.literal('constant'), value: z.number().finite() })
  .strict();

export const LinearCurveSchema = z
  .object({
    ...CurveBase,
    type: z.literal('linear'),
    base: z.number().finite(),
    step: z.number().finite(),
  })
  .strict();

export const ExponentialCurveSchema = z
  .object({
    ...CurveBase,
    type: z.literal('exponential'),
    base: z.number().finite().positive(),
    growth: z.number().finite().positive(),
  })
  .strict();

export const PowerCurveSchema = z
  .object({
    ...CurveBase,
    type: z.literal('power'),
    base: z.number().finite(),
    exponent: z.number().finite(),
  })
  .strict();

export const CurveDefSchema = z.discriminatedUnion('type', [
  ConstantCurveSchema,
  LinearCurveSchema,
  ExponentialCurveSchema,
  PowerCurveSchema,
]);

export const CurvesFileSchema = z.array(CurveDefSchema).min(1);

export type CurveDef = z.infer<typeof CurveDefSchema>;
export type CurveType = CurveDef['type'];
export type CurvesFile = z.infer<typeof CurvesFileSchema>;
