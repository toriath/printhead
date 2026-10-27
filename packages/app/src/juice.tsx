import type { ActionRejectedReason, Content, DomainEvent } from '@printhead/core';
import type { FaceId } from '@printhead/renderer';
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from 'react';
import { formatAmount, formatMoney } from './format.js';
import type { GameStore } from './store.js';

/**
 * Juice (spec §1: "rendering is decorative"). The simulation already says what
 * happened through domain events (spec §15, Observer); this turns them into
 * feedback a player feels — a number that pops off the bay, a gold burst for a
 * Perfect print, a shake for spaghetti, a fanfare for a new layer — and into the
 * short-lived faces the printers pull. None of it feeds back into the game.
 *
 * Timers here are wall-clock and presentational only; the reducer never sees
 * them, so determinism is untouched.
 */

export type PopupTone = 'parts' | 'products' | 'perfect' | 'fail' | 'boost' | 'order';

export interface Popup {
  readonly id: number;
  readonly slotIndex: number;
  readonly text: string;
  readonly tone: PopupTone;
}

export interface Banner {
  readonly id: number;
  readonly eyebrow: string;
  readonly title: string;
}

/** One line of the workshop log: what just happened, in words. */
export interface LogEntry {
  readonly id: number;
  readonly text: string;
  readonly tone: PopupTone | 'layer' | 'agent';
}

export interface Juice {
  readonly popups: readonly Popup[];
  /** The last few things worth reading about, newest first. */
  readonly log: readonly LogEntry[];
  readonly flourishes: Readonly<Record<string, FaceId>>;
  readonly banner: Banner | null;
  /** Increments on every failure; the stage keys its shake animation on it. */
  readonly shake: number;
}

const POPUP_MS = 1400;
const HAPPY_MS = 1600;
const FAIL_MS = 2600;
const BANNER_MS = 3200;
/** At most this many pop-ups on screen; the oldest make way. */
const MAX_POPUPS = 12;
/** Why the workshop said no, in words a player can act on. */
const REFUSALS: Partial<Record<ActionRejectedReason, string>> = {
  'insufficient-resources': 'Not enough to pay for that yet.',
  'slot-busy': 'That bay is busy right now.',
  'slot-idle': 'That bay has nothing to work on.',
  'slot-full': 'That bay holds all the printers it can.',
  'not-ready': 'Not ready yet: it is still cooling down.',
  locked: 'That is not unlocked yet.',
  'phase-gated': 'That opens on a later layer.',
  'not-worth-it': 'A melt-down would not pay enough plates yet.',
  'max-level': 'Already at its top level.',
  'already-owned': 'The studio already owns that design.',
  'missing-prerequisite': 'Something else has to come first.',
  'no-recycler': 'You need the scrap recycler for that.',
  'slots-not-committed': 'Every bay has to be staffed for the final print.',
  'nothing-to-do': 'Nothing to do there right now.',
};

/** An agent speaks up at most this often. */
const AGENT_QUIET_MS = 40_000;

/** The log keeps this many lines. */
const MAX_LOG = 6;

/**
 * The layers of the print: every phase but the post-game sandbox, which is
 * what is left when the print is done rather than a layer of it.
 */
export function printLayers(content: Content): readonly { id: string; name: string }[] {
  return content.pacing.phases.slice(0, -1);
}

/** The name a phase advance is announced with, numbered as a layer of the print. */
function layerBanner(content: Content, toPhaseId: string, id: number): Banner {
  const layers = printLayers(content);
  const index = layers.findIndex((phase) => phase.id === toPhaseId);
  if (index < 0) {
    return { id, eyebrow: 'The print is done', title: 'Sandbox' };
  }
  return {
    id,
    eyebrow: `Layer ${index + 1}`,
    title: layers[index]?.name ?? toPhaseId,
  };
}

export function useJuice(store: GameStore): Juice {
  const [popups, setPopups] = useState<readonly Popup[]>([]);
  const [flourishes, setFlourishes] = useState<Readonly<Record<string, FaceId>>>({});
  const [banner, setBanner] = useState<Banner | null>(null);
  const [shake, setShake] = useState(0);
  const [log, setLog] = useState<readonly LogEntry[]>([]);
  const nextLine = useRef(0);
  const lastPrice = useRef('');
  const nextId = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const later = (ms: number, run: () => void): void => {
      timers.current.push(setTimeout(run, ms));
    };
    const slotIndex = (slotId: string): number =>
      Math.max(
        store.getVisualState().slots.findIndex((slot) => slot.slotId === slotId),
        0,
      );
    const pop = (slotId: string, text: string, tone: PopupTone): void => {
      nextId.current += 1;
      const popup = { id: nextId.current, slotIndex: slotIndex(slotId), text, tone };
      setPopups((current) => [...current, popup].slice(-MAX_POPUPS));
      later(POPUP_MS, () => setPopups((current) => current.filter((p) => p.id !== popup.id)));
    };
    const note = (text: string, tone: LogEntry['tone']): void => {
      nextId.current += 1;
      const entry = { id: nextId.current, text, tone };
      setLog((current) => [entry, ...current].slice(0, MAX_LOG));
    };
    /*
     * Agents talk about what they do: a line from their persona, now and then,
     * when the thing they were hired for happens on their watch.
     */
    const spoke = new Map<string, number>();
    const speak = (behavior: string): void => {
      const state = store.getState();
      const def = store
        .getContent()
        .automation.find(
          (candidate) =>
            candidate.behavior === behavior &&
            candidate.persona !== undefined &&
            (state.automation[candidate.id]?.level ?? 0) > 0 &&
            state.automation[candidate.id]?.enabled === true,
        );
      const persona = def?.persona;
      const now = performance.now();
      if (
        def === undefined ||
        persona === undefined ||
        now - (spoke.get(def.id) ?? -AGENT_QUIET_MS) < AGENT_QUIET_MS
      ) {
        return;
      }
      spoke.set(def.id, now);
      nextLine.current += 1;
      const line = persona.lines[nextLine.current % persona.lines.length] ?? '';
      note(`${persona.name}: ${line}`, 'agent');
    };
    lastPrice.current = store.getState().shop.priceLevelId;
    const unwatch = store.subscribe(() => {
      const priceLevelId = store.getState().shop.priceLevelId;
      if (priceLevelId !== lastPrice.current) {
        lastPrice.current = priceLevelId;
        speak('run-shop');
      }
    });
    const client = (clientId: string): string =>
      store.getContent().commissions.clients.find((c) => c.id === clientId)?.name ?? clientId;
    const react = (slotId: string, face: FaceId, ms: number): void => {
      setFlourishes((current) => ({ ...current, [slotId]: face }));
      later(ms, () =>
        setFlourishes((current) => {
          if (current[slotId] !== face) {
            return current;
          }
          const { [slotId]: _gone, ...rest } = current;
          return rest;
        }),
      );
    };

    const unsubscribe = store.onEvent((event: DomainEvent) => {
      switch (event.type) {
        case 'PRINT_COMPLETED': {
          if (event.produced > 0) {
            const unit = event.pool === 'products' ? 'products' : 'parts';
            pop(
              event.slotId,
              event.perfect
                ? `PERFECT +${formatAmount(event.produced)}`
                : `+${formatAmount(event.produced)} ${unit}`,
              event.perfect ? 'perfect' : event.pool,
            );
          }
          if (event.perfect) {
            note(`Perfect print: +${formatAmount(event.produced)} ${event.pool}`, 'perfect');
            react(event.slotId, 'wow', HAPPY_MS);
          } else if (event.failed === 0) {
            react(event.slotId, 'happy', HAPPY_MS);
          }
          break;
        }
        case 'PRINT_FAILED':
          pop(event.slotId, `Spaghetti −${Math.round(event.scrapGrams)} g`, 'fail');
          note(`A print failed: ${Math.round(event.scrapGrams)} g of scrap`, 'fail');
          react(event.slotId, 'fail', FAIL_MS);
          setShake((n) => n + 1);
          break;
        case 'COMMISSION_COMPLETED': {
          const first = store.getVisualState().slots[0]?.slotId ?? '';
          pop(first, `ORDER DONE +${formatMoney(event.reward)}`, 'order');
          note(`${client(event.clientId)} paid ${formatMoney(event.reward)} for an order`, 'order');
          break;
        }
        case 'COMMISSION_OFFERED':
          note(`${client(event.clientId)} posted an order`, 'order');
          break;
        case 'COMMISSION_EXPIRED':
          note('An order ran out of time', 'fail');
          break;
        case 'SLOT_OVERCLOCKED':
          pop(event.slotId, 'OVERCLOCK', 'boost');
          break;
        case 'PHASE_ADVANCED': {
          nextId.current += 1;
          const next = layerBanner(store.getContent(), event.toPhaseId, nextId.current);
          setBanner(next);
          note(`New layer: ${next.title}`, 'layer');
          later(BANNER_MS, () =>
            setBanner((current) => (current?.id === next.id ? null : current)),
          );
          break;
        }
        case 'PIECE_ATTACHED': {
          const piece = store
            .getContent()
            .start.assemblyPieces.find((candidate) => candidate.id === event.pieceId);
          note(
            `${piece?.name ?? event.pieceId} clicked into place (${event.attachedCount}/${event.totalPieces})`,
            'boost',
          );
          break;
        }
        case 'ASSEMBLY_COMPLETED':
          note('It is alive.', 'layer');
          break;
        case 'COMMISSION_ANSWERED':
          if (event.accepted) {
            speak('answer-proposals');
          }
          break;
        case 'ACTION_REJECTED':
          note(REFUSALS[event.reason] ?? `Can't do that (${event.reason}).`, 'fail');
          break;
        default:
          break;
      }
    });
    return () => {
      unsubscribe();
      unwatch();
      for (const timer of timers.current) {
        clearTimeout(timer);
      }
      timers.current = [];
    };
  }, [store]);

  return { popups, log, flourishes, banner, shake };
}

/** The pop-ups, laid over the workshop, one column per bay. */
export function PopupLayer({
  popups,
  bays,
  anchorOf,
}: {
  popups: readonly Popup[];
  bays: number;
  /** Where a bay's printer stands, in px within the layer; else bays share the width. */
  anchorOf?: (slotIndex: number) => { readonly left: number; readonly top: number } | null;
}): ReactElement {
  return (
    <div className="juice" aria-hidden="true">
      {popups.map((popup) => {
        const anchor = anchorOf?.(popup.slotIndex) ?? null;
        return (
          <span
            key={popup.id}
            className={`juice__pop juice__pop--${popup.tone}`}
            style={
              anchor === null
                ? { left: `${((popup.slotIndex + 0.5) / Math.max(bays, 1)) * 100}%` }
                : { left: anchor.left, top: anchor.top }
            }
          >
            {popup.text}
          </span>
        );
      })}
    </div>
  );
}

export function LayerBanner({ banner }: { banner: Banner | null }): ReactElement | null {
  if (banner === null) {
    return null;
  }
  return (
    <output key={banner.id} className="layer-banner" data-testid="layer-banner">
      <span className="layer-banner__eyebrow">{banner.eyebrow}</span>
      <span className="layer-banner__title">{banner.title}</span>
    </output>
  );
}

/**
 * The phase as a stack of layers (design system: PhaseTrack). Only the layer
 * being printed and the one after it are named; the rest are a count, so the
 * arc keeps a few surprises (Schell's Lens of Curiosity).
 */
export function LayerTrack({
  content,
  phaseId,
  progress = 0,
}: {
  content: Content;
  phaseId: string;
  /** 0..1 — how far the layer being printed has got; it fills, wordlessly. */
  progress?: number;
}): ReactElement {
  const layers = printLayers(content);
  const current = layers.findIndex((phase) => phase.id === phaseId);
  const done = current < 0 ? layers.length : current;
  // Only the layers already printed are drawn: the stack grows as the game
  // does, and how tall it will get stays a surprise.
  return (
    <div className="layer-track">
      <div className="layer-track__stack" aria-hidden="true">
        {layers.slice(0, done + 1).map((layer, index) => (
          <span
            key={layer.id}
            className={index < done ? 'layer-track__layer is-done' : 'layer-track__layer is-now'}
            style={index === done ? ({ '--fill': progress } as CSSProperties) : undefined}
          />
        ))}
      </div>
      <div className="layer-track__text">
        <span className="layer-track__count">
          {current < 0 ? 'Print complete' : `Layer ${done + 1}`}
        </span>
      </div>
    </div>
  );
}

/** The workshop log: a quiet column of what just happened. */
export function WorkshopLog({ log }: { log: readonly LogEntry[] }): ReactElement {
  return (
    <ol className="log" aria-label="workshop log" aria-live="polite" data-testid="log">
      {log.length === 0 ? (
        <li className="log__entry log__entry--empty">The workshop is quiet.</li>
      ) : null}
      {log.map((entry) => (
        <li key={entry.id} className={`log__entry log__entry--${entry.tone}`}>
          {entry.text}
        </li>
      ))}
    </ol>
  );
}
