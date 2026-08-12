/**
 * A very small SVG chart writer for the balance report (spec §12.5).
 *
 * Two rules shape everything here. **One scale per chart**: the resource curves
 * are drawn as small multiples rather than one plot with five y-axes, because
 * Parts and Money differ by three orders of magnitude and overlaying them would
 * be a lie with a legend on it. And **colour is never the only encoding**: each
 * bar carries its own number and an OK/OVER word, so the red/green status pair
 * still reads for a colour-blind reviewer or a black-and-white printout.
 *
 * Each chart is a standalone `.svg` file with its own palette, stepped for both
 * light and dark surfaces, so it renders on GitHub either way.
 */

export interface Series {
  readonly label: string;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

export interface BarRow {
  readonly label: string;
  readonly value: number;
  /** Reference value the bar is judged against (the budget). */
  readonly target: number;
  readonly min: number;
  readonly max: number;
  readonly ok: boolean;
  /** Shown at the end of the bar; the number *and* the verdict. */
  readonly note: string;
}

const PALETTE = `
  <style>
    .surface { fill: #fcfcfb; }
    .ink { fill: #0b0b0b; }
    .ink-2 { fill: #52514e; }
    .grid { stroke: #dcdcd8; stroke-width: 1; }
    .axis { stroke: #b4b3ae; stroke-width: 1; }
    .line { fill: none; stroke: #2a78d6; stroke-width: 2; stroke-linejoin: round; }
    .band { fill: #2a78d6; opacity: 0.12; }
    .ok { fill: #008300; }
    .over { fill: #e34948; }
    text { font-family: ui-sans-serif, system-ui, sans-serif; }
    @media (prefers-color-scheme: dark) {
      .surface { fill: #1a1a19; }
      .ink { fill: #ffffff; }
      .ink-2 { fill: #c3c2b7; }
      .grid { stroke: #33332f; }
      .axis { stroke: #55554f; }
      .line { stroke: #3987e5; }
      .band { fill: #3987e5; opacity: 0.18; }
      .over { fill: #e66767; }
    }
  </style>`;

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const round = (value: number): string => (Math.round(value * 100) / 100).toString();

function document(width: number, height: number, body: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `,
    `viewBox="0 0 ${width} ${height}" role="img">`,
    PALETTE,
    `<rect class="surface" width="${width}" height="${height}" rx="6"/>`,
    body,
    '</svg>',
  ].join('');
}

const LEFT = 132;
const RIGHT = 150;
const TOP = 34;
const ROW = 26;
const BAR = 12;

/**
 * Horizontal bars against a tolerance band — the phase timeline and the
 * wait-wall table. The band is the ±tolerance window from `pacing.json`, so a
 * reader sees not just the number but how much slack it had.
 */
export function barChart(title: string, rows: readonly BarRow[]): string {
  const width = 760;
  const height = TOP + rows.length * ROW + 30;
  const plot = width - LEFT - RIGHT;
  const scale = Math.max(...rows.map((row) => Math.max(row.value, row.max)), 1);
  const x = (value: number): number => LEFT + (value / scale) * plot;

  const body = [
    `<text class="ink" x="16" y="22" font-size="13" font-weight="600">${escapeText(title)}</text>`,
    `<line class="axis" x1="${LEFT}" y1="${TOP - 6}" x2="${LEFT}" y2="${TOP + rows.length * ROW}"/>`,
    ...rows.flatMap((row, index) => {
      const y = TOP + index * ROW;
      const mid = y + BAR / 2;
      return [
        `<text class="ink-2" x="${LEFT - 10}" y="${mid + 4}" font-size="11" text-anchor="end">${escapeText(row.label)}</text>`,
        `<rect class="band" x="${round(x(row.min))}" y="${y - 2}" width="${round(Math.max(x(row.max) - x(row.min), 1))}" height="${BAR + 4}" rx="3"/>`,
        `<rect class="${row.ok ? 'ok' : 'over'}" x="${LEFT}" y="${y}" width="${round(Math.max(x(row.value) - LEFT, 2))}" height="${BAR}" rx="4"/>`,
        `<line class="axis" x1="${round(x(row.target))}" y1="${y - 4}" x2="${round(x(row.target))}" y2="${y + BAR + 4}"/>`,
        `<text class="ink" x="${width - RIGHT + 12}" y="${mid + 4}" font-size="11">${escapeText(row.note)}</text>`,
      ];
    }),
    `<text class="ink-2" x="${LEFT}" y="${height - 10}" font-size="10">design minutes — bar: actual · tick: budget · band: tolerance window</text>`,
  ].join('');
  return document(width, height, body);
}

/**
 * One line, one scale, one title that names the series — so no legend, and no
 * temptation to overlay a second measure on a second axis.
 */
export function lineChart(title: string, unit: string, series: Series): string {
  const width = 380;
  const height = 170;
  const left = 46;
  const right = 12;
  const top = 28;
  const bottom = 28;
  const plotW = width - left - right;
  const plotH = height - top - bottom;

  const xs = series.points.map((point) => point.x);
  const ys = series.points.map((point) => point.y);
  const maxX = Math.max(...xs, 1);
  const maxY = Math.max(...ys, 1);
  const px = (value: number): number => left + (value / maxX) * plotW;
  const py = (value: number): number => top + plotH - (value / maxY) * plotH;

  const path = series.points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${round(px(point.x))} ${round(py(point.y))}`)
    .join(' ');

  const gridLines = [0, 0.5, 1].map((fraction) => {
    const y = top + plotH - fraction * plotH;
    return [
      `<line class="grid" x1="${left}" y1="${round(y)}" x2="${width - right}" y2="${round(y)}"/>`,
      `<text class="ink-2" x="${left - 6}" y="${round(y + 3)}" font-size="9" text-anchor="end">${round(maxY * fraction)}</text>`,
    ].join('');
  });

  const body = [
    `<text class="ink" x="12" y="18" font-size="12" font-weight="600">${escapeText(title)}</text>`,
    ...gridLines,
    `<path class="line" d="${path}"/>`,
    `<text class="ink-2" x="${left}" y="${height - 8}" font-size="9">0</text>`,
    `<text class="ink-2" x="${width - right}" y="${height - 8}" font-size="9" text-anchor="end">${round(maxX)} design-min</text>`,
    `<text class="ink-2" x="12" y="${height - 8}" font-size="9">${escapeText(unit)}</text>`,
  ].join('');
  return document(width, height, body);
}
