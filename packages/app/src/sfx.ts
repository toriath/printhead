/**
 * Sound, synthesised. No samples ship with the game: every effect is a few
 * oscillators shaped by an envelope, so the whole soundboard is this file.
 *
 * The casino trick (Vampire Survivors learned it from slot machines): gains
 * that arrive in quick succession climb a scale, so a good streak *sounds*
 * like it is building to something. `combo()` tracks the streak; `coin()`
 * plays the next note up.
 *
 * Presentation only. Nothing here reaches the simulation, and with no Web
 * Audio (tests, old browsers) every call is a silent no-op.
 */

const MUTE_KEY = 'printhead:muted';
/** A major pentatonic, two octaves: streaks climb it and never sound wrong. */
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const BASE_HZ = 660;
/** Gains closer together than this keep a streak going. */
const STREAK_MS = 900;
const MASTER = 0.18;

type Wave = OscillatorType;

let context: AudioContext | null = null;
let master: GainNode | null = null;
let muted = readMuted();
let streak = 0;
let lastGainAt = 0;
const listeners = new Set<(muted: boolean) => void>();

function readMuted(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Audio may only start after a gesture; the shell calls this on the first one. */
export function unlockAudio(): void {
  const Ctor =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) {
    return;
  }
  if (context === null) {
    context = new Ctor();
    master = context.createGain();
    master.gain.value = muted ? 0 : MASTER;
    master.connect(context.destination);
  }
  if (context.state === 'suspended') {
    void context.resume();
  }
}

/** The shared audio graph, once a gesture has unlocked it (for the music). */
export function audioGraph(): { context: AudioContext; master: GainNode } | null {
  return context === null || master === null ? null : { context, master };
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  try {
    globalThis.localStorage?.setItem(MUTE_KEY, next ? '1' : '0');
  } catch {
    // Storage blocked: the choice lasts for this session only.
  }
  if (master !== null) {
    master.gain.value = next ? 0 : MASTER;
  }
  for (const listener of listeners) {
    listener(next);
  }
}

export function onMuteChange(listener: (muted: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tone(
  hz: number,
  { at = 0, length = 0.12, wave = 'triangle' as Wave, volume = 1, slideTo = hz } = {},
): void {
  if (context === null || master === null || muted) {
    return;
  }
  const start = context.currentTime + at;
  const osc = context.createOscillator();
  const env = context.createGain();
  osc.type = wave;
  osc.frequency.setValueAtTime(hz, start);
  if (slideTo !== hz) {
    osc.frequency.exponentialRampToValueAtTime(slideTo, start + length);
  }
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(volume, start + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(env).connect(master);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

const note = (step: number): number => BASE_HZ * 2 ** (step / 12);

/** Advance the streak and return its length; a pause resets it. */
export function combo(nowMs: number): number {
  streak = nowMs - lastGainAt < STREAK_MS ? Math.min(streak + 1, SCALE.length - 1) : 0;
  lastGainAt = nowMs;
  return streak;
}

/** One coin: a bright two-note blip, pitched by the streak. */
export function coin(level: number, at = 0): void {
  const step = SCALE[Math.min(level, SCALE.length - 1)] ?? 0;
  tone(note(step), { at, length: 0.07, wave: 'square', volume: 0.35 });
  tone(note(step + 7), { at: at + 0.05, length: 0.12, wave: 'square', volume: 0.3 });
}

/** The register: money spent. */
export function kaching(): void {
  tone(1320, { length: 0.05, wave: 'square', volume: 0.3 });
  tone(1760, { at: 0.06, length: 0.2, wave: 'triangle', volume: 0.5 });
}

/** A Perfect print: a rising arpeggio and a shimmer on top. */
export function jackpot(): void {
  [0, 4, 7, 12, 16, 19, 24].forEach((step, index) => {
    tone(note(step - 12), { at: index * 0.06, length: 0.18, wave: 'square', volume: 0.35 });
  });
  tone(note(24), { at: 0.42, length: 0.6, wave: 'triangle', volume: 0.4 });
}

/** The commission reel ticking past a number. */
export function reelTick(index: number): void {
  tone(900 + (index % 3) * 60, { length: 0.03, wave: 'square', volume: 0.18 });
}

/** A screw turned, a piece seated. */
export function click(): void {
  tone(220, { length: 0.05, wave: 'square', volume: 0.4, slideTo: 140 });
  tone(1800, { at: 0.01, length: 0.03, wave: 'triangle', volume: 0.2 });
}

/** The machine wakes. */
export function powerOn(): void {
  tone(196, { length: 0.5, wave: 'sawtooth', volume: 0.2, slideTo: 392 });
  [0, 7, 12, 19].forEach((step, index) => {
    tone(note(step - 5), { at: 0.35 + index * 0.09, length: 0.3, wave: 'triangle', volume: 0.4 });
  });
}

/** Spaghetti. */
export function thud(): void {
  tone(160, { length: 0.25, wave: 'sawtooth', volume: 0.35, slideTo: 55 });
}

/** Something new to find: a soft, high twinkle. */
export function discover(): void {
  [19, 24, 28].forEach((step, index) => {
    tone(note(step), { at: index * 0.07, length: 0.25, wave: 'triangle', volume: 0.22 });
  });
}

/** A bay ran dry: a falling "uh-oh". */
export function starve(): void {
  tone(note(-5), { length: 0.18, wave: 'triangle', volume: 0.45 });
  tone(note(-10), { at: 0.2, length: 0.4, wave: 'triangle', volume: 0.45, slideTo: note(-12) });
}

/** Overclock: a rising whoosh. */
export function whoosh(): void {
  tone(300, { length: 0.35, wave: 'sawtooth', volume: 0.15, slideTo: 1400 });
}

/** A new layer: a little fanfare. */
export function fanfare(): void {
  [0, 4, 7, 12].forEach((step, index) => {
    tone(note(step - 7), { at: index * 0.12, length: 0.22, wave: 'square', volume: 0.3 });
  });
  tone(note(5), { at: 0.5, length: 0.7, wave: 'triangle', volume: 0.4 });
}
