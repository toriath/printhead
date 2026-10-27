/**
 * The printer cast (Printhead design system: Cast, Faces, Assembly).
 *
 * Every printer is drawn on a 200 × 200 grid as a list of flat shapes with a
 * 3 px outline; its controller's LCD is its face, drawn as an 11 × 5 pixel
 * grid. This module is geometry only — plain data, no React — so the renderer
 * can draw it, a test can count its parts, and the STL generator (spec §20) can
 * one day read the same silhouettes.
 */

export type CharacterKind = 'mk1' | 'mk2' | 'mk3' | 'amber' | 'goliath' | 'mint' | 'fabricator';

export type FaceId =
  | 'idle'
  | 'focus'
  | 'happy'
  | 'worried'
  | 'fail'
  | 'sleep'
  | 'wow'
  | 'money'
  | 'starry'
  | 'off';

export interface Shape {
  readonly tag: 'rect' | 'circle' | 'ellipse' | 'path';
  readonly className: string;
  readonly attrs: Readonly<Record<string, string | number>>;
  /** The assembly piece this shape belongs to (Mk1), so the intro can be checked. */
  readonly part?: string;
  /** Marks the object growing on the bed, for the renderer's tests and styles. */
  readonly print?: 'parts' | 'products';
}

/** Mark shapes as belonging to one assembly piece. */
const piece = (part: string, shapes: readonly Shape[]): Shape[] =>
  shapes.map((shape) => ({ ...shape, part }));

export interface CharacterOptions {
  readonly face: FaceId;
  /** Parts, or a Product from a Design: Products come off the bed gold. */
  readonly output?: 'parts' | 'products';
  /** 0..1 — how tall the print on the bed has grown. */
  readonly progress: number;
  /** Mk1 only: the assembly pieces attached so far, or everything. */
  readonly parts: ReadonlySet<string> | 'all';
  /** What is on the bed (`bracket`, `gearset`…): its silhouette is what grows. */
  readonly object?: string | null;
  /** The filament it is printed in, which colours it. */
  readonly material?: string | null;
}

/** A bracket's foot, in artwork units: printed first, then the leg rises from it. */
const BRACKET_FOOT = 7;
/** A gear's teeth along whichever layer is being printed. */
const GEAR_TOOTH = 3;
const GEAR_PITCH = 6;

/**
 * The silhouette of what is being printed, cut off at the current height: the
 * object grows layer by layer rather than as a block. Unknown objects (a
 * player's Design) print as a plain block — a Product is gilded anyway.
 */
function silhouette(
  object: string | null | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  const bottom = y + h;
  if (object === 'bracket' && h > BRACKET_FOOT) {
    const leg = Math.round(w * 0.35);
    return `M${x} ${bottom}V${y}h${leg}V${bottom - BRACKET_FOOT}H${x + w}V${bottom}z`;
  }
  if (object === 'gearset' && h > GEAR_TOOTH) {
    let top = `M${x} ${bottom}V${y + GEAR_TOOTH}`;
    for (let tx = x; tx < x + w; tx += GEAR_PITCH) {
      const end = Math.min(tx + GEAR_PITCH, x + w);
      const mid = Math.min(tx + GEAR_PITCH / 2, end);
      top += `H${tx + 1}V${y}H${mid}V${y + GEAR_TOOTH}H${end}`;
    }
    return `${top}V${bottom}z`;
  }
  return `M${x} ${y}h${w}v${h}h${-w}z`;
}

export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface CharacterDrawing {
  readonly shapes: readonly Shape[];
  /** Where the LCD sits; `null` while it has not been attached yet. */
  readonly screen: ScreenRect | null;
  /** Shapes that ride on the toolhead and sweep while printing. */
  readonly carriage: readonly Shape[];
}

const O = 'pc-o ';

const rect = (x: number, y: number, w: number, h: number, rx: number, cls: string): Shape => ({
  tag: 'rect',
  className: cls,
  attrs: { x, y, width: w, height: h, rx },
});
const rotated = (shape: Shape, transform: string): Shape => ({
  ...shape,
  attrs: { ...shape.attrs, transform },
});
const circ = (cx: number, cy: number, r: number, cls: string): Shape => ({
  tag: 'circle',
  className: cls,
  attrs: { cx, cy, r },
});
const ell = (cx: number, cy: number, rx: number, ry: number, cls: string): Shape => ({
  tag: 'ellipse',
  className: cls,
  attrs: { cx, cy, rx, ry },
});
const path = (d: string, cls: string): Shape => ({ tag: 'path', className: cls, attrs: { d } });

const shadow = (rx: number): Shape => ell(100, 188, rx, 6, 'pc-shadow');

function spool(cx: number, cy: number, r: number, fill: string, deep: string): Shape[] {
  return [
    circ(cx, cy, r, O + fill),
    { tag: 'circle', className: deep, attrs: { cx, cy, r: r - 5, fill: 'none' } },
    circ(cx, cy, r * 0.38, `${O}pc-shell`),
    circ(cx, cy, r * 0.12, 'pc-ink'),
  ];
}

/** An object growing on a bed, with its layer lines. */
function printed(
  x: number,
  bedY: number,
  w: number,
  maxH: number,
  progress: number,
  cls: string,
  lineCls = 'pc-layer',
): Shape[] {
  const h = Math.round(maxH * Math.max(0, Math.min(1, progress)));
  if (h < 3) {
    return [];
  }
  const out: Shape[] = [{ ...rect(x, bedY - h, w, h, 3, O + cls), print: 'parts' }];
  for (let ly = bedY - 5; ly > bedY - h + 2; ly -= 5) {
    out.push(path(`M${x + 3} ${ly}h${w - 6}`, lineCls));
  }
  return out;
}

const has = (parts: CharacterOptions['parts'], id: string): boolean =>
  parts === 'all' || parts.has(id);

function mk1(o: CharacterOptions): CharacterDrawing {
  const p = o.parts;
  const s: Shape[] = [shadow(70)];
  const carriage: Shape[] = [];
  if (has(p, 'frame')) {
    s.push(
      ...piece('frame', [
        rect(42, 174, 18, 9, 3, `${O}pc-ink`),
        rect(140, 174, 18, 9, 3, `${O}pc-ink`),
      ]),
    );
  }
  if (has(p, 'spool-holder')) {
    s.push(
      ...piece('spool-holder', [
        path('M154 46h22', `${O}pc-none`),
        ...spool(176, 66, 19, 'pc-pla', 'pc-winding'),
      ]),
    );
  }
  if (has(p, 'frame')) {
    s.push(
      ...piece('frame', [
        rect(40, 42, 12, 110, 3, `${O}pc-acrylic`),
        rect(148, 42, 12, 110, 3, `${O}pc-acrylic`),
        rect(36, 38, 128, 12, 4, `${O}pc-acrylic`),
        rect(30, 148, 140, 30, 9, `${O}pc-shell`),
        path('M44 158h14M44 164h14M44 170h14', 'pc-thin'),
        circ(152, 163, 7, `${O}pc-pla`),
        circ(152, 163, 2, 'pc-ink'),
        // The strip of masking tape holding the left upright together.
        rotated(rect(35, 104, 22, 8, 2, `${O}pc-masking`), 'rotate(-14 46 108)'),
      ]),
    );
  }
  if (has(p, 'bed')) {
    s.push(
      ...piece('bed', [
        rect(50, 136, 100, 12, 3, `${O}pc-tape`),
        path('M75 138v8M100 138v8M125 138v8', 'pc-seam'),
        ...printed(84, 136, 32, 22, o.progress, 'pc-pla'),
      ]),
    );
  }
  if (has(p, 'gantry')) {
    s.push(...piece('gantry', [rect(46, 88, 108, 8, 4, `${O}pc-alu`)]));
  }
  if (has(p, 'spool-holder') && has(p, 'extruder')) {
    s.push(...piece('spool-holder', [path('M176 85C178 104 140 60 112 74', 'pc-filament')]));
  }
  if (has(p, 'extruder')) {
    carriage.push(
      ...piece('extruder', [
        rect(82, 70, 36, 32, 8, `${O}pc-pla`),
        circ(100, 86, 9, `${O}pc-shell`),
        path('M100 79v14M93 86h14', 'pc-thin'),
      ]),
    );
  }
  if (has(p, 'hotend')) {
    carriage.push(
      ...piece('hotend', [
        rect(92, 102, 16, 6, 1.5, `${O}pc-alu`),
        path('M95 108h10l-3 7h-4z', `${O}pc-brass`),
      ]),
    );
  }
  const tail: Shape[] = [];
  let screen: ScreenRect | null = null;
  if (has(p, 'controller')) {
    tail.push(
      ...piece('controller', [
        path('M136 28q16 4 13 18', 'pc-thin'),
        rect(62, 6, 76, 40, 12, `${O}pc-shell`),
      ]),
    );
    screen = { x: 70, y: 13, w: 60, h: 26 };
  }
  return { shapes: [...s, ...tail], screen, carriage };
}

function mk2(o: CharacterOptions): CharacterDrawing {
  return {
    shapes: [
      shadow(78),
      rect(34, 174, 20, 9, 3, `${O}pc-ink`),
      rect(146, 174, 20, 9, 3, `${O}pc-ink`),
      path('M38 46h-14', `${O}pc-none`),
      ...spool(22, 68, 18, 'pc-petg-c', 'pc-winding-petg'),
      rect(38, 44, 14, 108, 2, `${O}pc-alu`),
      rect(148, 44, 14, 108, 2, `${O}pc-alu`),
      path('M45 50v96M155 50v96', 'pc-groove'),
      rect(34, 38, 132, 14, 3, `${O}pc-alu`),
      rect(24, 146, 152, 32, 10, `${O}pc-shell`),
      rect(130, 154, 34, 16, 4, `${O}pc-shade`),
      path('M38 158h18M38 166h18', 'pc-thin'),
      rect(44, 132, 112, 12, 3, `${O}pc-heat`),
      path('M58 126q3 -4 0 -8t0 -8M142 126q3 -4 0 -8t0 -8', 'pc-shimmer'),
      ...printed(80, 132, 40, 28, o.progress, 'pc-petg-c', 'pc-layer-petg'),
      rect(44, 86, 112, 10, 4, `${O}pc-alu`),
      path('M22 86C24 100 60 58 90 70', 'pc-filament-petg'),
      rect(58, 4, 84, 42, 12, `${O}pc-shell`),
      path('M58 18v-2a12 12 0 0 1 12 -12h60a12 12 0 0 1 12 12v2z', `${O}pc-alu`),
    ],
    carriage: [
      rect(78, 66, 44, 36, 9, `${O}pc-pla`),
      circ(92, 84, 8, `${O}pc-shell`),
      circ(110, 84, 8, `${O}pc-shell`),
      path('M92 78v12M86 84h12M110 78v12M104 84h12', 'pc-thin'),
      rect(92, 102, 16, 7, 1.5, `${O}pc-alu`),
      path('M95 109h10l-3 7h-4z', `${O}pc-steel`),
    ],
    screen: { x: 66, y: 17, w: 68, h: 24 },
  };
}

function mk3(o: CharacterOptions): CharacterDrawing {
  return {
    shapes: [
      shadow(80),
      rect(36, 176, 22, 8, 3, `${O}pc-ink`),
      rect(142, 176, 22, 8, 3, `${O}pc-ink`),
      rect(78, 6, 44, 16, 3, `${O}pc-pla`),
      path('M84 8v12M116 8v12', 'pc-winding'),
      rect(72, 4, 8, 20, 2, `${O}pc-shell`),
      rect(120, 4, 8, 20, 2, `${O}pc-shell`),
      rect(24, 22, 152, 158, 16, `${O}pc-steel`),
      rect(36, 62, 128, 98, 8, `${O}pc-plate-in`),
      rect(44, 134, 112, 10, 3, `${O}pc-gold`),
      path('M54 139h1M70 138h1M88 140h1M110 138h1M132 140h1M146 138h1', 'pc-speckle'),
      ...printed(78, 134, 44, 36, o.progress, 'pc-pla'),
      rect(42, 78, 116, 8, 3, `${O}pc-alu`),
    ],
    carriage: [
      circ(100, 120, 11, 'pc-glow'),
      rect(84, 70, 32, 30, 7, `${O}pc-steel`),
      circ(100, 84, 8, `${O}pc-shade`),
      rect(118, 88, 6, 12, 2, `${O}pc-blueprint-c`),
      rect(93, 100, 14, 5, 1.5, `${O}pc-alu`),
      path('M95 105h10l-3 7h-4z', `${O}pc-hot`),
    ],
    screen: { x: 58, y: 30, w: 84, h: 26 },
  };
}

/** Mk3's glass, handle and reflections go over its carriage. */
const MK3_FRONT: readonly Shape[] = [
  rect(36, 62, 128, 98, 8, `${O}pc-glass ph-enclosure`),
  path('M60 70l-16 26M76 70l-26 42', 'pc-reflect'),
  rect(84, 164, 32, 8, 4, `${O}pc-shade`),
];

function amber(o: CharacterOptions): CharacterDrawing {
  const drop = 20 + Math.round(30 * Math.max(0, Math.min(1, o.progress)));
  return {
    shapes: [
      shadow(64),
      rect(48, 174, 16, 9, 3, `${O}pc-ink`),
      rect(136, 174, 16, 9, 3, `${O}pc-ink`),
      rect(96, 34, 8, 96, 2, `${O}pc-alu`),
      rect(68, 60, 64, 9, 2, `${O}pc-alu`),
      { ...rect(86, 69, 28, drop, 3, `${O}pc-resin-print`), print: 'parts' },
      path('M89 75h22M89 80h22M89 85h22', 'pc-layer-resin'),
      rect(60, 122, 80, 18, 4, `${O}pc-steel`),
      path('M66 128h68', 'pc-liquid'),
      path('M52 140V60a30 30 0 0 1 30 -30h36a30 30 0 0 1 30 30v80z', `${O}pc-amber`),
      path('M64 64a18 18 0 0 1 16 -20', 'pc-reflect'),
      rect(88, 22, 24, 9, 4, `${O}pc-shell`),
      rect(36, 138, 128, 40, 12, `${O}pc-shell`),
    ],
    carriage: [],
    screen: { x: 60, y: 145, w: 80, h: 26 },
  };
}

function goliath(o: CharacterOptions): CharacterDrawing {
  return {
    shapes: [
      shadow(92),
      rect(16, 178, 28, 9, 3, `${O}pc-ink`),
      rect(156, 178, 28, 9, 3, `${O}pc-ink`),
      ...spool(20, 22, 14, 'pc-pla', 'pc-winding'),
      ...spool(180, 22, 14, 'pc-petg-c', 'pc-winding-petg'),
      rect(10, 38, 22, 128, 4, `${O}pc-steel`),
      rect(168, 38, 22, 128, 4, `${O}pc-steel`),
      path(
        'M21 56v0M21 80v0M21 104v0M21 128v0M21 150v0M179 56v0M179 80v0M179 104v0M179 128v0M179 150v0',
        'pc-rivet',
      ),
      rect(4, 34, 192, 16, 5, `${O}pc-steel`),
      rect(4, 158, 192, 26, 9, `${O}pc-shell`),
      path('M16 168h20M16 175h20', 'pc-thin'),
      rect(150, 164, 36, 14, 4, `${O}pc-shade`),
      rect(30, 144, 140, 14, 3, `${O}pc-heat`),
      ...printed(56, 144, 88, 34, o.progress, 'pc-pla'),
      rect(28, 90, 144, 13, 5, `${O}pc-alu`),
      rect(50, 0, 100, 40, 12, `${O}pc-shell`),
    ],
    carriage: [
      rect(66, 68, 68, 44, 11, `${O}pc-pla`),
      circ(86, 90, 11, `${O}pc-shell`),
      circ(114, 90, 11, `${O}pc-shell`),
      path('M86 81v18M77 90h18M114 81v18M105 90h18', 'pc-thin'),
      rect(88, 112, 24, 8, 2, `${O}pc-alu`),
      path('M92 120h16l-4 10h-8z', `${O}pc-brass`),
    ],
    screen: { x: 58, y: 6, w: 84, h: 28 },
  };
}

function mint(o: CharacterOptions): CharacterDrawing {
  const bills: Shape[] = [];
  const n = 1 + Math.round(4 * Math.max(0, Math.min(1, o.progress)));
  for (let i = 0; i < n; i += 1) {
    bills.push(
      rect(70 + (i % 2) * 4, 128 - i * 7, 60, 8, 1.5, `${O}pc-money`),
      circ(100 + (i % 2) * 4, 132 - i * 7, 2.2, 'pc-ink'),
    );
  }
  return {
    shapes: [
      shadow(74),
      rect(38, 174, 18, 9, 3, `${O}pc-ink`),
      rect(144, 174, 18, 9, 3, `${O}pc-ink`),
      path('M154 46h22', `${O}pc-none`),
      ...spool(176, 66, 19, 'pc-brass', 'pc-winding-gold'),
      rect(40, 42, 12, 110, 3, `${O}pc-steel`),
      rect(148, 42, 12, 110, 3, `${O}pc-steel`),
      rect(36, 38, 128, 12, 4, `${O}pc-steel`),
      rect(28, 148, 144, 30, 9, `${O}pc-shell`),
      circ(152, 163, 7, `${O}pc-brass`),
      path('M42 158h14M42 164h14M42 170h14', 'pc-thin'),
      rect(48, 136, 104, 12, 3, `${O}pc-gold`),
      ...bills,
      rect(46, 86, 108, 8, 4, `${O}pc-alu`),
      path('M176 85C178 104 140 60 112 74', 'pc-filament-gold'),
      rect(62, 4, 76, 40, 12, `${O}pc-shell`),
    ],
    carriage: [
      rect(82, 66, 36, 34, 8, `${O}pc-brass`),
      circ(100, 83, 9, `${O}pc-shell`),
      path('M100 76v14M93 83h14', 'pc-thin'),
      rect(90, 100, 20, 8, 2, `${O}pc-steel`),
    ],
    screen: { x: 70, y: 11, w: 60, h: 26 },
  };
}

function fabricator(o: CharacterOptions): CharacterDrawing {
  const mats = ['pc-pla', 'pc-petg-c', 'pc-resin-c', 'pc-steel', 'pc-carbon'];
  const layers = Math.round(5 * Math.max(0, Math.min(1, o.progress)));
  const stack: Shape[] = [];
  for (let i = 0; i < layers; i += 1) {
    stack.push(rect(72 + i * 2, 150 - i * 8, 56 - i * 4, 9, 3, O + (mats[i] ?? 'pc-pla')));
  }
  const ey = 104 - layers * 4;
  return {
    shapes: [
      shadow(90),
      rect(94, 30, 12, 112, 3, `${O}pc-carbon-back`),
      ell(100, 34, 86, 14, 'pc-halo'),
      rect(20, 30, 18, 142, 4, `${O}pc-carbon`),
      rect(162, 30, 18, 142, 4, `${O}pc-carbon`),
      rect(14, 160, 172, 24, 9, `${O}pc-shell`),
      rect(24, 166, 40, 12, 4, `${O}pc-shade`),
      ell(100, 160, 66, 11, `${O}pc-gold`),
      ...stack,
      path(`M38 64L90 ${ey}M38 72L90 ${ey + 8}M162 64L110 ${ey}M162 72L110 ${ey + 8}`, 'pc-arm'),
      rect(30, 58, 14, 20, 3, `${O}pc-alu`),
      rect(156, 58, 14, 20, 3, `${O}pc-alu`),
      circ(100, ey + 18, 10, 'pc-glow'),
      path(`M86 ${ey}h28l6 8 -6 8h-28l-6 -8z`, `${O}pc-steel`),
      path(`M96 ${ey + 16}h8l-2 6h-4z`, `${O}pc-hot`),
      path('M70 6h60l10 18 -10 18h-60l-10 -18z', `${O}pc-shell`),
    ],
    carriage: [],
    screen: { x: 72, y: 12, w: 56, h: 24 },
  };
}

const DRAW: Record<CharacterKind, (o: CharacterOptions) => CharacterDrawing> = {
  mk1,
  mk2,
  mk3,
  amber,
  goliath,
  mint,
  fabricator,
};

/** Draw a character. Mk3's glass is appended after its carriage by the renderer. */
export function drawCharacter(kind: CharacterKind, options: CharacterOptions): CharacterDrawing {
  const raw = DRAW[kind](options);
  // The block on the bed becomes the real thing, in the real filament.
  const sculpt = (shape: Shape): Shape => {
    if (shape.print === undefined || shape.tag !== 'rect') {
      return shape;
    }
    const { x, y, width, height } = shape.attrs as Record<string, number>;
    return {
      ...shape,
      tag: 'path',
      attrs: { d: silhouette(options.object, x ?? 0, y ?? 0, width ?? 0, height ?? 0) },
      className:
        options.material === undefined || options.material === null
          ? shape.className
          : `${O}pc-mat pc-mat-${options.material}`,
    };
  };
  const drawing = { ...raw, shapes: raw.shapes.map(sculpt) };
  if (options.output !== 'products') {
    return drawing;
  }
  // A Product is not a Part: the studio bay's print comes off the bed gold.
  const gild = (shape: Shape): Shape =>
    shape.print === undefined
      ? shape
      : { ...shape, className: `${O}pc-print-product ph-print--product`, print: 'products' };
  return { ...drawing, shapes: drawing.shapes.map(gild) };
}

export const FRONT_SHAPES: Partial<Record<CharacterKind, readonly Shape[]>> = { mk3: MK3_FRONT };

// --- faces ------------------------------------------------------------------

/** 11 × 5 pixel grids. `#` is a lit pixel. */
export const FACE_GRIDS: Readonly<Record<FaceId, readonly string[]>> = {
  idle: ['...........', '..##...##..', '..##...##..', '..##...##..', '...........'],
  focus: ['...........', '.###...###.', '..##...##..', '..##...##..', '...........'],
  happy: ['...........', '..#.....#..', '.#.#...#.#.', '#...#.#...#', '...........'],
  worried: ['..........#', '..##...##.#', '..##...##..', '...........', '..#.#.#.#..'],
  fail: ['...........', '.#.#...#.#.', '..#.....#..', '.#.#...#.#.', '...........'],
  sleep: ['.......###.', '........#..', '.......###.', '...........', '.###...###.'],
  wow: ['.###...###.', '.#.#...#.#.', '.###...###.', '...........', '....###....'],
  money: ['.###...###.', '.#.....#...', '.###...###.', '...#.....#.', '.###...###.'],
  starry: ['..#.....#..', '.###...###.', '..#.....#..', '...........', '...#####...'],
  off: ['...........', '...........', '...........', '...........', '...........'],
};

export const BLINK_GRID: readonly string[] = [
  '...........',
  '...........',
  '...........',
  '.###...###.',
  '...........',
];

/** The lit pixels of a face as one path, in a 60 × 26 LCD box. */
export function facePath(grid: readonly string[]): string {
  const size = 4.4;
  const ox = (60 - size * 11) / 2;
  const oy = (26 - size * 5) / 2;
  let d = '';
  grid.forEach((row, r) => {
    for (let c = 0; c < row.length; c += 1) {
      if (row.charAt(c) === '#') {
        d += `M${+(ox + c * size).toFixed(1)} ${+(oy + r * size).toFixed(1)}h3.9v3.9h-3.9z`;
      }
    }
  });
  return d;
}
