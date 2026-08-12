/**
 * Machine-tier appearance (spec §5A: "every node changes the SVG").
 *
 * The projection hands the renderer a `machineTier` number and nothing else
 * (spec §15), so what a tier *looks like* is decided here — presentation, not
 * simulation. Frame acrylic → aluminium → steel, nozzle brass → hardened →
 * glowing, bed tape → heated → auto-level, exactly as the upgrade tree reads.
 *
 * M3 splits the machine tree into independent nodes; when it does, the extra
 * fields arrive in `VisualState` and this table gains rows rather than logic.
 */
export interface MachineTierStyle {
  readonly tier: number;
  /** Slug used in class names and test ids: `printer--frame-aluminium`. */
  readonly frame: 'acrylic' | 'aluminium' | 'steel';
  readonly nozzle: 'brass' | 'hardened' | 'glowing';
  readonly bed: 'tape' | 'heated' | 'auto-level';
  readonly label: string;
  /** Struts get visibly heavier as the machine gets more serious. */
  readonly strutScale: number;
  readonly enclosure: boolean;
}

export const MACHINE_TIER_STYLES: readonly MachineTierStyle[] = [
  {
    tier: 1,
    frame: 'acrylic',
    nozzle: 'brass',
    bed: 'tape',
    label: 'Acrylic frame · brass nozzle · taped bed',
    strutScale: 1,
    enclosure: false,
  },
  {
    tier: 2,
    frame: 'aluminium',
    nozzle: 'hardened',
    bed: 'heated',
    label: 'Aluminium frame · hardened nozzle · heated bed',
    strutScale: 1.3,
    enclosure: false,
  },
  {
    tier: 3,
    frame: 'steel',
    nozzle: 'glowing',
    bed: 'auto-level',
    label: 'Steel frame · glowing nozzle · auto-levelling bed',
    strutScale: 1.7,
    enclosure: true,
  },
];

const FIRST_TIER_STYLE = MACHINE_TIER_STYLES[0] as MachineTierStyle;

/**
 * Tiers beyond the table reuse the top style rather than vanishing: content can
 * add a tier-4 printer before the art exists, and a missing SVG is a worse bug
 * than a reused one.
 */
export function machineTierStyle(tier: number): MachineTierStyle {
  const clamped = Math.min(Math.max(Math.floor(tier), 1), MACHINE_TIER_STYLES.length);
  return MACHINE_TIER_STYLES[clamped - 1] ?? FIRST_TIER_STYLE;
}
