import type { CSSProperties, ReactElement, ReactNode } from 'react';

/**
 * The shell's icons, drawn to the design system's grid: 24 units, a 2-unit
 * round stroke, no fills except where a shape is the point (a coin, a spool's
 * filament). One component, so every icon sits on the same baseline.
 */
export type IconName =
  | 'money'
  | 'parts'
  | 'scrap'
  | 'products'
  | 'plates'
  | 'prices'
  | 'filament'
  | 'printer'
  | 'machine'
  | 'automation'
  | 'market'
  | 'fleet'
  | 'studio'
  | 'meltdown'
  | 'endgame'
  | 'order'
  | 'sell'
  | 'sound'
  | 'muted'
  | 'music'
  | 'bracket'
  | 'gearset'
  | 'design'
  | 'diary'
  | 'agent';

const PATHS: Record<IconName, ReactNode> = {
  money: (
    <>
      {/* A stack of coins, because coins are what fly into it. */}
      <ellipse cx="12" cy="6.5" rx="7" ry="3" />
      <path d="M5 6.5v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4" />
      <path d="M5 10.5v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4" />
      <path d="M5 14.5v3c0 1.7 3.1 3 7 3s7-1.3 7-3v-3" />
    </>
  ),
  parts: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </>
  ),
  scrap: (
    <>
      <path d="M4 15c2-6 4 4 6-2s3-6 5 0 3 3 5-3" />
      <path d="M5 19c3-2 5 1 8-1s4-1 6 0" />
    </>
  ),
  products: (
    <>
      <path d="M4 8l8-4 8 4v8l-8 4-8-4z" />
      <path d="M4 8l8 4 8-4M12 12v8M8 6l8 4" />
    </>
  ),
  plates: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 9h10M7 12h10M7 15h6" />
    </>
  ),
  prices: (
    <>
      <path d="M4 18l5-6 4 3 7-9" />
      <path d="M15 6h5v5" />
    </>
  ),
  filament: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M20 12h2" />
    </>
  ),
  printer: (
    <>
      <rect x="4" y="3" width="16" height="15" rx="2" />
      <path d="M4 8h16M10 8v4h4V8M12 12v2M7 18v3M17 18v3" />
    </>
  ),
  machine: (
    <>
      <path d="M12 20V6" />
      <path d="M6 11l6-6 6 6" />
      <path d="M5 20h14" />
    </>
  ),
  automation: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
    </>
  ),
  market: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  fleet: (
    <>
      <rect x="3" y="4" width="7" height="7" rx="1.5" />
      <rect x="14" y="4" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  studio: (
    <>
      <path d="M4 20l4-1 11-11-3-3L5 16z" />
      <path d="M14 7l3 3" />
    </>
  ),
  meltdown: (
    <>
      <path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z" />
      <path d="M12 21a3 3 0 0 1-3-3c0-2 3-4 3-4s3 2 3 4a3 3 0 0 1-3 3z" />
    </>
  ),
  endgame: (
    <>
      <path d="M12 3l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.8z" />
    </>
  ),
  order: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V2.5h6V4M9 10h6M9 14h6M9 18h3" />
    </>
  ),
  sell: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5V8M12 16v1.5" />
    </>
  ),
  sound: (
    <>
      <path d="M4 9v6h4l5 4V5L8 9z" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
    </>
  ),
  muted: (
    <>
      <path d="M4 9v6h4l5 4V5L8 9z" />
      <path d="M17 9l5 6M22 9l-5 6" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="17.5" cy="16" r="2.5" />
    </>
  ),
  bracket: (
    <>
      <path d="M5 4v13a3 3 0 0 0 3 3h12" />
      <path d="M5 4h4v12h11v4" />
    </>
  ),
  gearset: (
    <>
      <circle cx="9" cy="10" r="3" />
      <path d="M9 3.5v2M9 14.5v2M2.5 10h2M13.5 10h2M4.4 5.4l1.4 1.4M12.2 13.2l1.4 1.4M4.4 14.6l1.4-1.4M12.2 6.8l1.4-1.4" />
      <circle cx="17" cy="17" r="2.5" />
      <path d="M17 12.5v1.5M17 20v1.5M12.5 17h1.5M20 17h1.5" />
    </>
  ),
  agent: (
    <>
      <rect x="5" y="7" width="14" height="11" rx="3" />
      <path d="M12 7V4M9 12h.01M15 12h.01M9.5 15h5M3 11v3M21 11v3" />
    </>
  ),
  diary: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
      <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3M9 7h6M9 10.5h4" />
    </>
  ),
  design: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
};

export function Icon({
  name,
  size = 18,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className === undefined ? 'icon' : `icon ${className}`}
      style={style}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

/** Real spools hold a kilogram: the drawn one empties as stock does. */
const SPOOL_GRAMS = 1000;
export const spoolFill = (grams: number): number => Math.min(grams / SPOOL_GRAMS, 1);

/** Each material's filament colour, matching the printer cast's palette. */
const FILAMENT: Record<string, { fill: string; deep: string }> = {
  pla: { fill: '#E23673', deep: '#A8204F' },
  petg: { fill: '#1FA595', deep: '#0B6A5F' },
  resin: { fill: '#F5A23A', deep: '#C47A1E' },
  metal: { fill: '#9AA6B2', deep: '#5B6773' },
  composite: { fill: '#4C5563', deep: '#2E333B' },
};
const FALLBACK = { fill: '#B9C2BF', deep: '#7D8986' };

/** Windings drawn across the filament, as a fraction of its depth. */
const WINDINGS = [0.33, 0.66];

/**
 * A filament spool, face on: the flange, the wound filament in the material's
 * colour, and the hub. `fill` (0..1) is how much filament is left on it, so a
 * spool on the shelf shows its stock at a glance and an empty one is just the
 * reel.
 */
export function Spool({
  materialId,
  fill = 1,
  size = 28,
}: {
  materialId: string;
  fill?: number;
  size?: number;
}): ReactElement {
  const colour = FILAMENT[materialId] ?? FALLBACK;
  const hub = 5.5;
  const rim = 13.5;
  const wound = hub + (rim - 1 - hub) * Math.min(Math.max(fill, 0), 1);
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className="spool-art"
      data-material={materialId}
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="15" fill="#DCE0DE" stroke="#1C2330" strokeWidth="2" />
      {wound > hub ? (
        <>
          <circle cx="16" cy="16" r={wound} fill={colour.fill} />
          {WINDINGS.map((at) => (
            <circle
              key={at}
              cx="16"
              cy="16"
              r={hub + (wound - hub) * at}
              fill="none"
              stroke={colour.deep}
              strokeWidth="0.9"
              strokeDasharray="3 2"
            />
          ))}
          <circle cx="16" cy="16" r={wound} fill="none" stroke={colour.deep} strokeWidth="1.2" />
        </>
      ) : null}
      <circle cx="16" cy="16" r={hub} fill="#FAFAF7" stroke="#1C2330" strokeWidth="1.8" />
      <circle cx="16" cy="16" r="1.8" fill="#1C2330" />
      <path d="M16 11.5v2M16 18.5v2M11.5 16h2M18.5 16h2" stroke="#1C2330" strokeWidth="1.2" />
    </svg>
  );
}
