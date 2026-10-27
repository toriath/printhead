import type { DomainEvent } from '@printhead/core';
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from 'react';
import { formatMoney } from './format.js';
import { Icon } from './icons.js';
import { isMusicOn, onMusicChange, setMusic } from './music.js';
import * as sfx from './sfx.js';
import type { GameStore } from './store.js';

/**
 * The casino layer. Money should *feel* like money: it flies, it rattles, it
 * counts up, and a lucky print lights the room. Borrowed shamelessly from the
 * slot-machine playbook Vampire Survivors runs on — escalating coin pitch,
 * overflowing showers, a reel that spins before it pays.
 *
 * Every bit of it is driven by domain events and wall-clock animation; none of
 * it touches the simulation.
 */

interface Coin {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly delay: number;
  readonly spin: number;
  /** A coin flying to the money, or a printed part flying to the pile. */
  readonly skin: 'coin' | 'part';
}

/** A number that rises off the counter it just changed. */
interface Float {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

/** Sparks off the button that just bought something. */
interface Burst {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/** Where on screen an effect happens: always at the thing that caused it. */
interface Spot {
  readonly x: number;
  readonly y: number;
}

interface Reel {
  readonly id: number;
  readonly reward: number;
  readonly client: string;
  /** Over the order board, where the order was. */
  readonly at: Spot;
}

/** The melt-down, over the floor it melts. */
interface Melt {
  readonly id: number;
  readonly plates: number;
  readonly run: number;
  readonly box: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

interface Jackpot {
  readonly id: number;
  /** On the printer that rolled the Perfect. */
  readonly at: Spot;
}

export interface Casino {
  /** Gains in a row, each within `STREAK_WINDOW_MS` of the last (0 when cold). */
  readonly streak: number;
  readonly melt: Melt | null;
  readonly coins: readonly Coin[];
  readonly floats: readonly Float[];
  readonly bursts: readonly Burst[];
  readonly jackpot: Jackpot | null;
  readonly reel: Reel | null;
}

const COIN_FLIGHT_MS = 900;
/** Frames to wait for a counter that is only now being revealed. */
const SHOWER_RETRIES = 6;
/** The highest step on the coin scale a streak climbs to. */
const STREAK_PITCH_MAX = 10;
/** How long a refused button shakes its head. */
const REFUSE_MS = 420;
const FLOAT_MS = 1100;
/** Gains this close together keep a streak going. */
const STREAK_WINDOW_MS = 8000;
/** Streak lengths that set off a fanfare. */
const STREAK_MILESTONES = [5, 10, 20, 50];
/** The melt-down's moment on the floor, from first glow to the plate. */
const MELT_MS = 4200;
const MAX_FLOATS = 6;
const BURST_MS = 700;
const MAX_BURSTS = 4;
/** A purchase sparks where the player pressed, if they pressed just now. */
const PRESS_RECENT_MS = 600;
const FLING_EVERY_MS = 450;
const MAX_PARTS_PER_FLING = 3;
/** Sparks per burst, spread evenly round the circle. */
const SPARKS = 10;
const SPARK_REACH_PX = 46;
const MAX_COINS = 60;
const JACKPOT_MS = 1400;
const REEL_SPIN_MS = 1100;
const REEL_HOLD_MS = 1300;
/** Perfect prints closer together than this share one jackpot. */
const JACKPOT_COOLDOWN_MS = 2500;

/** More money, more coins — logarithmically, so a fortune still fits on screen. */
export function coinsFor(money: number): number {
  return Math.max(3, Math.min(24, Math.round(3 + Math.log10(Math.max(money, 1)) * 3)));
}

function centre(selector: string): { x: number; y: number } | null {
  const element = document.querySelector(selector);
  if (element === null) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  // A hidden element (not revealed yet) has no box and no place on screen.
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function useCasino(store: GameStore): Casino {
  const [coins, setCoins] = useState<readonly Coin[]>([]);
  const [jackpot, setJackpot] = useState<Jackpot | null>(null);
  const [melt, setMelt] = useState<Melt | null>(null);
  const [streak, setStreak] = useState(0);
  const streakTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streakCount = useRef(0);
  const [floats, setFloats] = useState<readonly Float[]>([]);
  const [bursts, setBursts] = useState<readonly Burst[]>([]);
  // Where the player last pressed: a purchase sparks from the button it was.
  const lastPress = useRef<{ x: number; y: number; at: number } | null>(null);
  // At most one part flight per bay per beat, however big its crew.
  const lastFling = useRef(new Map<string, number>());
  const [reel, setReel] = useState<Reel | null>(null);
  const nextId = useRef(0);
  const lastJackpot = useRef(-JACKPOT_COOLDOWN_MS);
  const queue = useRef<Reel[]>([]);
  const reelBusy = useRef(false);
  reelBusy.current = reel !== null;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const later = (ms: number, run: () => void): void => {
      timers.current.push(setTimeout(run, ms));
    };
    const onPress = (event: PointerEvent): void => {
      lastPress.current = { x: event.clientX, y: event.clientY, at: performance.now() };
    };
    window.addEventListener('pointerdown', onPress, true);
    const float = (at: { x: number; y: number }, text: string): void => {
      nextId.current += 1;
      const entry = { id: nextId.current, x: at.x, y: at.y, text };
      setFloats((current) => [...current, entry].slice(-MAX_FLOATS));
      later(FLOAT_MS, () => setFloats((current) => current.filter((f) => f.id !== entry.id)));
    };
    const burst = (): void => {
      const press = lastPress.current;
      if (press === null || performance.now() - press.at > PRESS_RECENT_MS) {
        return;
      }
      nextId.current += 1;
      const entry = { id: nextId.current, x: press.x, y: press.y };
      setBursts((current) => [...current, entry].slice(-MAX_BURSTS));
      later(BURST_MS, () => setBursts((current) => current.filter((b) => b.id !== entry.id)));
    };
    /** Printed parts arc from the printer onto the pile. */
    const fling = (slotId: string, count: number): void => {
      const now = performance.now();
      if (now - (lastFling.current.get(slotId) ?? 0) < FLING_EVERY_MS) {
        return;
      }
      lastFling.current.set(slotId, now);
      const start = centre(`[data-slot-id="${slotId}"][data-lead]`);
      const end = centre('[data-pile]') ?? centre('[data-testid="parts"]');
      if (start === null || end === null) {
        return;
      }
      const batch: Coin[] = [];
      for (let i = 0; i < Math.min(count, MAX_PARTS_PER_FLING); i += 1) {
        nextId.current += 1;
        batch.push({
          id: nextId.current,
          x: start.x,
          y: start.y,
          dx: end.x - start.x + (i - 1) * 8,
          dy: end.y - start.y,
          delay: i * 60,
          spin: 200 + i * 90,
          skin: 'part',
        });
      }
      setCoins((current) => [...current, ...batch].slice(-MAX_COINS));
      const ids = new Set(batch.map((c) => c.id));
      later(COIN_FLIGHT_MS + batch.length * 60 + 100, () =>
        setCoins((current) => current.filter((c) => !ids.has(c.id))),
      );
    };
    const shower = (from: string, money: number, attempt = 0): void => {
      const start = centre(from) ?? centre('.center');
      const end = centre('[data-casino="money"]');
      // The first sale is also the moment the money counter appears: until
      // it is laid out it has no position, and coins aimed at it would fly
      // to the corner of the screen. Wait a frame or two for it.
      if (end === null) {
        if (attempt < SHOWER_RETRIES) {
          const from_ = start;
          requestAnimationFrame(() =>
            from_ === null ? undefined : showerFrom(from_, money, attempt + 1),
          );
        }
        return;
      }
      if (start === null) {
        return;
      }
      launch(start, end, money);
    };
    const showerFrom = (start: Spot, money: number, attempt: number): void => {
      const end = centre('[data-casino="money"]');
      if (end === null) {
        if (attempt < SHOWER_RETRIES) {
          requestAnimationFrame(() => showerFrom(start, money, attempt + 1));
        }
        return;
      }
      launch(start, end, money);
    };
    const launch = (start: Spot, end: Spot, money: number): void => {
      const count = coinsFor(money);
      // The coins climb the scale with the visible streak, so the sound and
      // the 🔥 pill always tell the same story.
      const level = Math.min(streakCount.current, STREAK_PITCH_MAX);
      const batch: Coin[] = [];
      for (let i = 0; i < count; i += 1) {
        nextId.current += 1;
        const spread = (i / Math.max(count - 1, 1) - 0.5) * 80;
        batch.push({
          id: nextId.current,
          x: start.x + spread,
          y: start.y,
          dx: end.x - start.x - spread,
          dy: end.y - start.y,
          delay: i * 35,
          spin: (i % 2 === 0 ? 1 : -1) * (360 + i * 40),
          skin: 'coin',
        });
        // Each coin that lands rattles a little higher than the last.
        sfx.coin(level + Math.floor(i / 3), (COIN_FLIGHT_MS * 0.8 + i * 35) / 1000);
      }
      setCoins((current) => [...current, ...batch].slice(-MAX_COINS));
      const ids = new Set(batch.map((c) => c.id));
      later(COIN_FLIGHT_MS + count * 35 + 100, () =>
        setCoins((current) => current.filter((c) => !ids.has(c.id))),
      );
      later(COIN_FLIGHT_MS, () => {
        const target = document.querySelector('[data-casino="money"]');
        target?.classList.remove('is-bump');
        // Reflow so the bump replays on every shower.
        void (target as HTMLElement | null)?.offsetWidth;
        target?.classList.add('is-bump');
        float(end, `+${formatMoney(money)}`);
      });
    };
    const playReel = (next: Reel): void => {
      setReel(next);
      for (let i = 0; i < REEL_SPIN_MS / 60; i += 1) {
        later(i * 60, () => sfx.reelTick(i));
      }
      later(REEL_SPIN_MS, () => {
        sfx.kaching();
        shower('.reel', next.reward);
      });
      later(REEL_SPIN_MS + REEL_HOLD_MS, () => {
        const waiting = queue.current.shift();
        if (waiting === undefined) {
          setReel(null);
        } else {
          playReel(waiting);
        }
      });
    };

    const clients = (): readonly { id: string; name: string }[] =>
      store.getContent().commissions.clients;
    /** A gain keeps the streak alive; a quiet spell lets it go cold. */
    const gain = (): void => {
      // Counted in a ref so the fanfare fires once, outside any state updater.
      streakCount.current += 1;
      const next = streakCount.current;
      setStreak(next);
      if (STREAK_MILESTONES.includes(next)) {
        sfx.fanfare();
        later(0, () => {
          const pill = centre('[data-testid="streak"]');
          if (pill !== null) {
            lastPress.current = { x: pill.x, y: pill.y, at: performance.now() };
            burst();
          }
        });
      }
      if (streakTimer.current !== null) {
        clearTimeout(streakTimer.current);
      }
      streakTimer.current = setTimeout(() => {
        streakCount.current = 0;
        setStreak(0);
      }, STREAK_WINDOW_MS);
    };
    const unsubscribe = store.onEvent((event: DomainEvent) => {
      if (
        event.type === 'PART_SOLD' ||
        event.type === 'PRODUCT_SOLD' ||
        event.type === 'CUSTOMER_SERVED' ||
        event.type === 'COMMISSION_COMPLETED' ||
        (event.type === 'PRINT_COMPLETED' && event.perfect)
      ) {
        gain();
      }
      switch (event.type) {
        case 'PART_SOLD':
        case 'PRODUCT_SOLD':
          if (event.money > 0) {
            // The coins rise out of the pile being sold, or the button if
            // there is no pile to see.
            shower(
              document.querySelector('[data-pile]') === null
                ? '[data-testid="sell"]'
                : '[data-pile]',
              event.money,
            );
          }
          break;
        case 'PRINT_COMPLETED':
          if (event.produced > 0 && !event.perfect) {
            fling(event.slotId, event.produced);
          }
          if (event.perfect) {
            const now = performance.now();
            if (now - lastJackpot.current > JACKPOT_COOLDOWN_MS) {
              lastJackpot.current = now;
              sfx.jackpot();
              nextId.current += 1;
              const burst = {
                id: nextId.current,
                at: centre(`[data-slot-id="${event.slotId}"][data-lead]`) ??
                  centre('.stage') ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 },
              };
              setJackpot(burst);
              later(JACKPOT_MS, () =>
                setJackpot((current) => (current?.id === burst.id ? null : current)),
              );
            }
          }
          break;
        case 'PRINT_FAILED':
          sfx.thud();
          break;
        case 'ACTION_REJECTED': {
          // A refusal answers the button that asked: it shakes its head.
          sfx.sigh();
          const press = lastPress.current;
          if (press !== null && performance.now() - press.at < PRESS_RECENT_MS) {
            const button = document.elementFromPoint(press.x, press.y)?.closest('button');
            if (button !== null && button !== undefined) {
              button.classList.remove('is-refused');
              void (button as HTMLElement).offsetWidth;
              button.classList.add('is-refused');
              later(REFUSE_MS, () => button.classList.remove('is-refused'));
            }
          }
          break;
        }
        case 'PRESTIGED': {
          const stage = document.querySelector('.stage')?.getBoundingClientRect();
          if (stage === undefined || stage.width === 0) {
            break;
          }
          nextId.current += 1;
          const entry = {
            id: nextId.current,
            plates: event.platesAwarded,
            run: event.runNumber,
            box: { left: stage.left, top: stage.top, width: stage.width, height: stage.height },
          };
          sfx.meltdown();
          setMelt(entry);
          later(MELT_MS, () => setMelt((current) => (current?.id === entry.id ? null : current)));
          break;
        }
        case 'CUSTOMER_SERVED':
          sfx.bell();
          shower('[data-testid="shop"]', event.money);
          break;
        case 'CUSTOMER_LEFT':
          sfx.sigh();
          break;
        case 'COMMISSION_OFFERED':
          sfx.knock();
          break;
        case 'COMMISSION_ANSWERED':
          if (event.accepted) {
            sfx.stamp();
            burst();
          }
          break;
        case 'COMMISSION_COMPLETED': {
          nextId.current += 1;
          const entry = {
            id: nextId.current,
            reward: event.reward,
            client: clients().find((c) => c.id === event.clientId)?.name ?? '',
            at: centre('[data-testid="commissions"]') ??
              centre('.stage') ?? { x: window.innerWidth / 2, y: window.innerHeight / 3 },
          };
          if (queue.current.length === 0 && reelBusy.current === false) {
            playReel(entry);
          } else {
            queue.current.push(entry);
          }
          break;
        }
        case 'PRINTER_BUILT':
        case 'UPGRADE_INSTALLED':
        case 'AUTOMATION_INSTALLED':
        case 'SLOT_UNLOCKED':
        case 'FILAMENT_PURCHASED':
          sfx.kaching();
          burst();
          break;
        case 'SLOT_OVERCLOCKED':
          sfx.whoosh();
          break;
        case 'PIECE_ATTACHED':
          sfx.click();
          break;
        case 'ASSEMBLY_COMPLETED':
          sfx.powerOn();
          break;
        case 'PHASE_ADVANCED':
          sfx.fanfare();
          break;
        default:
          break;
      }
    });
    return () => {
      window.removeEventListener('pointerdown', onPress, true);
      unsubscribe();
      for (const timer of timers.current) {
        clearTimeout(timer);
      }
      timers.current = [];
    };
  }, [store]);

  return { streak, melt, coins, floats, bursts, jackpot, reel };
}

export function CasinoLayer({ casino }: { casino: Casino }): ReactElement {
  return (
    <div className="casino" aria-hidden="true">
      {casino.coins.map((c) => (
        <span
          key={c.id}
          className={c.skin === 'part' ? 'coin coin--part' : 'coin'}
          style={
            {
              left: c.x,
              top: c.y,
              '--dx': `${c.dx}px`,
              '--dy': `${c.dy}px`,
              '--spin': `${c.spin}deg`,
              animationDelay: `${c.delay}ms`,
              animationDuration: `${COIN_FLIGHT_MS}ms`,
            } as CSSProperties
          }
        >
          <span
            className="coin__face"
            style={{ animationDelay: `${c.delay}ms`, animationDuration: `${COIN_FLIGHT_MS}ms` }}
          />
        </span>
      ))}
      {casino.floats.map((f) => (
        <span key={f.id} className="float" style={{ left: f.x, top: f.y }}>
          {f.text}
        </span>
      ))}
      {casino.bursts.map((b) => (
        <span key={b.id} className="burst" style={{ left: b.x, top: b.y }}>
          {Array.from({ length: SPARKS }, (_unused, index) => {
            const angle = (index / SPARKS) * Math.PI * 2;
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: sparks are interchangeable
                key={index}
                className="burst__spark"
                style={
                  {
                    '--sx': `${Math.cos(angle) * SPARK_REACH_PX}px`,
                    '--sy': `${Math.sin(angle) * SPARK_REACH_PX}px`,
                  } as CSSProperties
                }
              />
            );
          })}
        </span>
      ))}
      {casino.jackpot === null ? null : (
        <div
          key={casino.jackpot.id}
          className="jackpot"
          style={{
            left: casino.jackpot.at.x,
            top: casino.jackpot.at.y,
            animationDuration: `${JACKPOT_MS}ms`,
          }}
        >
          <span className="jackpot__glow" />
          <span className="jackpot__rays" />
          <span className="jackpot__word">PERFECT!</span>
        </div>
      )}
      {casino.reel === null ? null : <ReelCard key={casino.reel.id} reel={casino.reel} />}
      {casino.melt === null ? null : <MeltCard key={casino.melt.id} melt={casino.melt} />}
    </div>
  );
}

/** The commission payout: a number that spins like a slot reel, then lands. */
function ReelCard({ reel }: { reel: Reel }): ReactElement {
  const [shown, setShown] = useState(0);
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    const started = performance.now();
    let frame = 0;
    const spin = (): void => {
      const t = (performance.now() - started) / REEL_SPIN_MS;
      if (t >= 1) {
        setShown(reel.reward);
        setLanded(true);
        return;
      }
      // Wild early, settling late: the classic reel slow-down.
      const jitter = (1 - t) * reel.reward * 1.5;
      setShown(Math.max(0, reel.reward * t + jitter * Math.sin(t * 90)));
      frame = requestAnimationFrame(spin);
    };
    frame = requestAnimationFrame(spin);
    return () => cancelAnimationFrame(frame);
  }, [reel]);
  return (
    <div className={landed ? 'reel is-landed' : 'reel'} style={{ left: reel.at.x, top: reel.at.y }}>
      <span className="reel__eyebrow">{`Order delivered${reel.client ? ` · ${reel.client}` : ''}`}</span>
      <span className="reel__value">{formatMoney(Math.round(shown))}</span>
    </div>
  );
}

/**
 * Money that counts up rather than jumping. The real number stays in the
 * document for tools and screen readers; this is the show.
 */
export function RollingMoney({ value }: { value: number }): ReactElement {
  const [shown, setShown] = useState(value);
  const target = useRef(value);
  target.current = value;
  useEffect(() => {
    let frame = 0;
    const step = (): void => {
      setShown((current) => {
        const gap = target.current - current;
        // Spending drops at once; earning rolls up.
        if (gap <= 0 || Math.abs(gap) < 0.01) {
          return target.current;
        }
        return current + Math.max(gap * 0.18, 0.01);
      });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <span className="money-roll" data-casino="money" aria-hidden="true">
      {formatMoney(Number.isInteger(value) && value - shown < 1 ? value : shown)}
    </span>
  );
}

/** The one switch for sound, in the top bar. */
export function MuteToggle(): ReactElement {
  const [muted, setMutedState] = useState(sfx.isMuted());
  useEffect(() => sfx.onMuteChange(setMutedState), []);
  return (
    <button
      type="button"
      className="mute"
      data-testid="mute"
      aria-pressed={muted}
      aria-label={muted ? 'Sound off' : 'Sound on'}
      onClick={() => {
        sfx.unlockAudio();
        sfx.setMuted(!muted);
      }}
    >
      <Icon name={muted ? 'muted' : 'sound'} />
    </button>
  );
}

/** The music switch, beside the sound one. */
export function MusicToggle(): ReactElement {
  const [on, setOn] = useState(isMusicOn());
  useEffect(() => onMusicChange(setOn), []);
  return (
    <button
      type="button"
      className={on ? 'mute' : 'mute is-off'}
      data-testid="music"
      aria-pressed={on}
      aria-label={on ? 'Music on' : 'Music off'}
      onClick={() => {
        sfx.unlockAudio();
        setMusic(!on);
      }}
    >
      <Icon name="music" />
    </button>
  );
}

/**
 * The melt-down, staged on the floor it melts: the room glows red, a molten
 * pool rises, and out of it a plate is struck — its count spinning up like the
 * order reel before it lands.
 */
function MeltCard({ melt }: { melt: Melt }): ReactElement {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const started = performance.now();
    let frame = 0;
    const spin = (): void => {
      const t = Math.min((performance.now() - started - MELT_COUNT_DELAY_MS) / MELT_COUNT_MS, 1);
      setShown(t <= 0 ? 0 : melt.plates * (1 - (1 - t) ** 3));
      if (t < 1) {
        frame = requestAnimationFrame(spin);
      }
    };
    frame = requestAnimationFrame(spin);
    return () => cancelAnimationFrame(frame);
  }, [melt]);
  return (
    <div
      className="melt"
      style={{
        left: melt.box.left,
        top: melt.box.top,
        width: melt.box.width,
        height: melt.box.height,
        animationDuration: `${MELT_MS}ms`,
      }}
    >
      <span className="melt__pool" />
      <span className="melt__plate">
        <span className="melt__count">{`+${shown.toFixed(shown < 10 ? 1 : 0)}`}</span>
        <span className="melt__unit">plates</span>
      </span>
      <span className="melt__line">{`Melt-down. Run ${melt.run} begins.`}</span>
    </div>
  );
}

/** The plate count waits for the pool, then spins up. */
const MELT_COUNT_DELAY_MS = 1200;
const MELT_COUNT_MS = 1600;

/** The hot streak, beside the money it is making: it flames up as it grows. */
export function StreakPill({ streak }: { streak: number }): ReactElement | null {
  if (streak < STREAK_SHOW_FROM) {
    return null;
  }
  const heat = Math.min(streak / STREAK_HOTTEST, 1);
  return (
    <span
      key={streak}
      className="streak"
      data-testid="streak"
      style={{ '--heat': heat } as CSSProperties}
      title="Gains in a row"
    >
      <span className="streak__flame" aria-hidden="true">
        🔥
      </span>
      {`×${streak}`}
    </span>
  );
}

const STREAK_SHOW_FROM = 2;
/** The pill is at its hottest from this many in a row. */
const STREAK_HOTTEST = 20;
