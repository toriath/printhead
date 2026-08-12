/**
 * Printable PRINTHEAD (spec §20) — M7 deliverable, placeholder in M0.
 *
 * What exists today is the printability contract: the parameter record the
 * OpenSCAD/build123d generator will consume and the invariants CI will assert
 * (`pnpm stl:check`: manifold, min wall thickness, bed fit, slice pass).
 */
export interface PrintabilityLimits {
  readonly minWallThicknessMm: number;
  readonly maxOverhangDegrees: number;
  readonly bedSizeMm: number;
  readonly maxPrintHours: number;
  readonly layerHeightMm: number;
}

export const PRINTABILITY_LIMITS: PrintabilityLimits = {
  minWallThicknessMm: 1.2,
  maxOverhangDegrees: 45,
  bedSizeMm: 180,
  maxPrintHours: 2,
  layerHeightMm: 0.2,
};

/** Machine-tier variants mirror the frame upgrades of spec §5A. */
export type FrameTier = 'acrylic' | 'aluminum' | 'steel';

export interface PrinterModelParams {
  readonly frameTier: FrameTier;
  readonly widthMm: number;
  readonly depthMm: number;
  readonly heightMm: number;
  readonly wallThicknessMm: number;
}

export const DEFAULT_MODEL_PARAMS: PrinterModelParams = {
  frameTier: 'steel',
  widthMm: 120,
  depthMm: 120,
  heightMm: 160,
  wallThicknessMm: 1.6,
};

export interface PrintabilityIssue {
  readonly rule: 'min-wall-thickness' | 'bed-fit';
  readonly detail: string;
}

export function checkPrintability(
  params: PrinterModelParams,
  limits: PrintabilityLimits = PRINTABILITY_LIMITS,
): PrintabilityIssue[] {
  const issues: PrintabilityIssue[] = [];
  if (params.wallThicknessMm < limits.minWallThicknessMm) {
    issues.push({
      rule: 'min-wall-thickness',
      detail: `${params.wallThicknessMm} mm < ${limits.minWallThicknessMm} mm`,
    });
  }
  const footprint = Math.max(params.widthMm, params.depthMm);
  if (footprint > limits.bedSizeMm) {
    issues.push({ rule: 'bed-fit', detail: `${footprint} mm > ${limits.bedSizeMm} mm bed` });
  }
  return issues;
}
