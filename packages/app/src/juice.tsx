import type { Content, DomainEvent } from '@printhead/core';
import type { FaceId } from '@printhead/renderer';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { formatAmount } from './format.js';
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

export type PopupTone = 'parts' | 'products' | 'perfect' | 'fail' | 'boost';

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

export interface Juice {
  readonly popups: readonly Popup[];
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
    eyebrow: `Layer ${index + 1} of ${layers.length}`,
    title: layers[index]?.name ?? toPhaseId,
  };
}

export function useJuice(store: GameStore): Juice {
  const [popups, setPopups] = useState<readonly Popup[]>([]);
  const [flourishes, setFlourishes] = useState<Readonly<Record<string, FaceId>>>({});
  const [banner, setBanner] = useState<Banner | null>(null);
  const [shake, setShake] = useState(0);
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
            react(event.slotId, 'wow', HAPPY_MS);
          } else if (event.failed === 0) {
            react(event.slotId, 'happy', HAPPY_MS);
          }
          break;
        }
        case 'PRINT_FAILED':
          pop(event.slotId, `Spaghetti −${Math.round(event.scrapGrams)} g`, 'fail');
          react(event.slotId, 'fail', FAIL_MS);
          setShake((n) => n + 1);
          break;
        case 'SLOT_OVERCLOCKED':
          pop(event.slotId, 'OVERCLOCK', 'boost');
          break;
        case 'PHASE_ADVANCED': {
          nextId.current += 1;
          const next = layerBanner(store.getContent(), event.toPhaseId, nextId.current);
          setBanner(next);
          later(BANNER_MS, () =>
            setBanner((current) => (current?.id === next.id ? null : current)),
          );
          break;
        }
        default:
          break;
      }
    });
    return () => {
      unsubscribe();
      for (const timer of timers.current) {
        clearTimeout(timer);
      }
      timers.current = [];
    };
  }, [store]);

  return { popups, flourishes, banner, shake };
}

/** The pop-ups, laid over the workshop, one column per bay. */
export function PopupLayer({
  popups,
  bays,
}: {
  popups: readonly Popup[];
  bays: number;
}): ReactElement {
  return (
    <div className="juice" aria-hidden="true">
      {popups.map((popup) => (
        <span
          key={popup.id}
          className={`juice__pop juice__pop--${popup.tone}`}
          style={{ left: `${((popup.slotIndex + 0.5) / Math.max(bays, 1)) * 100}%` }}
        >
          {popup.text}
        </span>
      ))}
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
}: { content: Content; phaseId: string }): ReactElement {
  const layers = printLayers(content);
  const current = layers.findIndex((phase) => phase.id === phaseId);
  const done = current < 0 ? layers.length : current;
  const next = layers[done + 1];
  return (
    <div className="layer-track">
      <div className="layer-track__stack" aria-hidden="true">
        {layers.map((layer, index) => (
          <span
            key={layer.id}
            className={
              index < done
                ? 'layer-track__layer is-done'
                : index === done
                  ? 'layer-track__layer is-now'
                  : 'layer-track__layer'
            }
          />
        ))}
      </div>
      <div className="layer-track__text">
        <span className="layer-track__count">
          {current < 0 ? 'Print complete' : `Layer ${done + 1} of ${layers.length}`}
        </span>
        {next === undefined ? null : (
          <span className="layer-track__next">{`Next: ${next.name}`}</span>
        )}
      </div>
    </div>
  );
}
