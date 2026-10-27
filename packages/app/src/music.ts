import { audioGraph } from './sfx.js';

/**
 * Background music, generated rather than recorded: a slow lo-fi loop of
 * seventh chords on soft pads, a round bass, a sparse plucked melody on the
 * pentatonic and a brushed hi-hat. The melody is drawn afresh every bar, so
 * the loop never quite repeats and never gets in the way.
 *
 * It shares the sound effects' audio graph (and so their master mute), with
 * its own switch on top. Presentation only, like everything audible.
 */

const MUSIC_KEY = 'printhead:music';
const BPM = 70;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
/** How far ahead bars are scheduled; the timer only has to be roughly on time. */
const LOOKAHEAD_S = 0.4;
const VOLUME = 0.55;

/** I–vi–IV–V in seventh chords, as semitones above A2. */
const PROGRESSION: readonly (readonly number[])[] = [
  [3, 7, 10, 14], // Cmaj7-ish over C
  [0, 3, 7, 10], // Am7
  [8, 12, 15, 19], // Fmaj7
  [10, 14, 17, 20], // G7
];
const ROOTS = [3, 0, 8, 10];
const PENTATONIC = [0, 3, 5, 7, 10, 12, 15, 17];
const A2 = 110;

let enabled = readEnabled();
let bus: GainNode | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let nextBarAt = 0;
let bar = 0;
let seed = 1;
const listeners = new Set<(on: boolean) => void>();

function readEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUSIC_KEY) !== '0';
  } catch {
    return true;
  }
}

/** A tiny LCG: the melody only has to *sound* random. */
function random(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

const hz = (semitones: number): number => A2 * 2 ** (semitones / 12);

function voice(
  context: AudioContext,
  out: AudioNode,
  frequency: number,
  at: number,
  length: number,
  { wave = 'triangle' as OscillatorType, volume = 0.1, attack = 0.02, cutoff = 1800 } = {},
): void {
  const osc = context.createOscillator();
  const filter = context.createBiquadFilter();
  const env = context.createGain();
  osc.type = wave;
  osc.frequency.value = frequency;
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  env.gain.setValueAtTime(0.0001, at);
  env.gain.exponentialRampToValueAtTime(volume, at + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(filter).connect(env).connect(out);
  osc.start(at);
  osc.stop(at + length + 0.05);
}

function hat(context: AudioContext, out: AudioNode, at: number, volume: number): void {
  const length = 0.05;
  const buffer = context.createBuffer(
    1,
    Math.ceil(context.sampleRate * length),
    context.sampleRate,
  );
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = random() * 2 - 1;
  }
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const env = context.createGain();
  source.buffer = buffer;
  filter.type = 'highpass';
  filter.frequency.value = 7000;
  env.gain.setValueAtTime(volume, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + length);
  source.connect(filter).connect(env).connect(out);
  source.start(at);
}

function scheduleBar(context: AudioContext, out: AudioNode, at: number): void {
  const chord = PROGRESSION[bar % PROGRESSION.length] ?? [];
  const root = ROOTS[bar % ROOTS.length] ?? 0;
  // Pads: the whole chord, swelling in and out over the bar.
  for (const note of chord) {
    voice(context, out, hz(note + 12), at, BAR * 1.05, {
      volume: 0.035,
      attack: BAR * 0.35,
      cutoff: 900,
    });
  }
  // Bass: root on one, fifth on three.
  voice(context, out, hz(root - 12), at, BEAT * 1.8, { wave: 'sine', volume: 0.16, cutoff: 400 });
  voice(context, out, hz(root - 5), at + BEAT * 2, BEAT * 1.6, {
    wave: 'sine',
    volume: 0.12,
    cutoff: 400,
  });
  // Melody: a few plucked eighths, most of them rests.
  for (let step = 0; step < 8; step += 1) {
    if (random() < 0.32) {
      const note = PENTATONIC[Math.floor(random() * PENTATONIC.length)] ?? 0;
      voice(context, out, hz(root + note + 24), at + step * (BEAT / 2), BEAT * 0.9, {
        volume: 0.05,
        attack: 0.005,
        cutoff: 2600,
      });
    }
  }
  // A lazy, swung hi-hat.
  for (let step = 0; step < 8; step += 1) {
    const swing = step % 2 === 1 ? BEAT * 0.08 : 0;
    hat(context, out, at + step * (BEAT / 2) + swing, step % 2 === 0 ? 0.035 : 0.02);
  }
  bar += 1;
}

function pump(): void {
  const graph = audioGraph();
  if (graph === null || bus === null) {
    return;
  }
  while (nextBarAt < graph.context.currentTime + LOOKAHEAD_S + BAR) {
    scheduleBar(graph.context, bus, nextBarAt);
    nextBarAt += BAR;
  }
}

/** Start the loop if it is wanted and audio is unlocked; safe to call often. */
export function startMusic(): void {
  const graph = audioGraph();
  if (!enabled || graph === null || timer !== null) {
    return;
  }
  bus = graph.context.createGain();
  bus.gain.value = 0;
  bus.gain.linearRampToValueAtTime(VOLUME, graph.context.currentTime + 3);
  bus.connect(graph.master);
  nextBarAt = graph.context.currentTime + 0.1;
  pump();
  timer = setInterval(pump, (LOOKAHEAD_S * 1000) / 2);
}

export function stopMusic(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  const graph = audioGraph();
  if (bus !== null && graph !== null) {
    const fading = bus;
    fading.gain.cancelScheduledValues(graph.context.currentTime);
    fading.gain.setValueAtTime(fading.gain.value, graph.context.currentTime);
    fading.gain.linearRampToValueAtTime(0, graph.context.currentTime + 1);
    setTimeout(() => fading.disconnect(), 1200);
  }
  bus = null;
}

export function isMusicOn(): boolean {
  return enabled;
}

export function setMusic(on: boolean): void {
  enabled = on;
  try {
    globalThis.localStorage?.setItem(MUSIC_KEY, on ? '1' : '0');
  } catch {
    // Storage blocked: the choice lasts for this session.
  }
  if (on) {
    startMusic();
  } else {
    stopMusic();
  }
  for (const listener of listeners) {
    listener(on);
  }
}

export function onMusicChange(listener: (on: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
