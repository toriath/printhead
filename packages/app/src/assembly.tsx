import { type Content, type VisualState, attachPiece } from '@printhead/core';
import { CHARACTER_CSS, Character } from '@printhead/renderer';
import {
  type CSSProperties,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { formatCountdown } from './format.js';
import * as sfx from './sfx.js';
import type { GameStore } from './store.js';

/**
 * The assembly bench (spec §6 phase 0). Printer #1 is built by hand: each
 * piece comes off the bench into a tray, and the player drags it onto the
 * half-built machine, where a ghost of it shows where it goes. The drop is the
 * same `ATTACH_PIECE` action the old button sent, so the reducer still decides
 * order and timing; the bench only decides what the hand gets to hold. For
 * keyboards and the test suite, a small "Attach" button (and the `A` key)
 * does the same thing.
 */

export interface AssemblyBenchProps {
  readonly store: GameStore;
  readonly visual: VisualState;
  readonly content: Content;
}

interface Drag {
  readonly pieceId: string;
  readonly x: number;
  readonly y: number;
  readonly over: boolean;
}

/** How long the "click!" of a fastened piece stays on screen. */
const SNAP_MS = 700;
/** Screws to tighten before a seated piece is fastened. */
const SCREWS = 2;
/** The piece that is switched on rather than screwed down. */
const POWER_PIECE = 'controller';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Where a seated piece's screws go: both on its biggest shape (a frame's base,
 * a gantry's rod), a fifth of the way in from each end of its long side, so a
 * screw always lands on metal and never in the air between two posts.
 */
function screwSpots(
  box: Box,
  shapes: readonly Box[],
  pieceId: string,
): readonly { x: number; y: number }[] {
  const host = [...shapes].sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? box;
  const cx = host.x + host.w / 2;
  const cy = host.y + host.h / 2;
  // The controller is switched on where its face will light up.
  if (pieceId === POWER_PIECE) {
    return [{ x: cx, y: cy }];
  }
  return host.w >= host.h
    ? [
        { x: host.x + host.w * 0.2, y: cy },
        { x: host.x + host.w * 0.8, y: cy },
      ]
    : [
        { x: cx, y: host.y + host.h * 0.2 },
        { x: cx, y: host.y + host.h * 0.8 },
      ];
}

/** Padding around a piece's own bounds in its tray thumbnail. */
const THUMB_PAD = 6;
const ARTWORK = 200;

/** One piece on its own, cropped to its bounds once the browser can measure it. */
function PieceThumb({ pieceId }: { pieceId: string }): ReactElement {
  const group = useRef<SVGGElement | null>(null);
  const [box, setBox] = useState(`0 0 ${ARTWORK} ${ARTWORK}`);
  useLayoutEffect(() => {
    const bounds = group.current?.getBBox?.();
    if (bounds !== undefined && bounds.width > 0 && bounds.height > 0) {
      const side = Math.max(bounds.width, bounds.height) + THUMB_PAD * 2;
      const x = bounds.x + bounds.width / 2 - side / 2;
      const y = bounds.y + bounds.height / 2 - side / 2;
      setBox(`${x} ${y} ${side} ${side}`);
    }
  }, []);
  return (
    <svg className="piece__art pc-char" viewBox={box} aria-hidden="true">
      <g ref={group}>
        <Character
          kind="mk1"
          face="idle"
          progress={0}
          parts={[pieceId]}
          printing={false}
          phaseOffset={0}
        />
      </g>
    </svg>
  );
}

export function AssemblyBench({ store, visual, content }: AssemblyBenchProps): ReactElement {
  const { assembly } = visual;
  const pieces = content.start.assemblyPieces;
  const attached = assembly.attachedPieceIds;
  const nextId = assembly.nextPieceId;
  const nextName = assembly.nextPieceName ?? nextId ?? '';
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snap, setSnap] = useState(0);
  // A dropped piece sits loose on the printer until its screws are turned.
  const [seated, setSeated] = useState<string | null>(null);
  const [turned, setTurned] = useState<readonly number[]>([]);
  const [box, setBox] = useState<Box | null>(null);
  const [shapes, setShapes] = useState<readonly Box[]>([]);
  const loose = useRef<SVGGElement | null>(null);
  useLayoutEffect(() => {
    if (seated === null) {
      setBox(null);
      return;
    }
    const bounds = loose.current?.getBBox?.();
    const parts = [
      ...(loose.current?.querySelectorAll<SVGGraphicsElement>(
        'rect, path, circle, ellipse, polygon',
      ) ?? []),
    ]
      .map((shape) => shape.getBBox?.())
      .filter((b): b is DOMRect => b !== undefined && b.width > 0 && b.height > 0)
      .map((b) => ({ x: b.x, y: b.y, w: b.width, h: b.height }));
    setShapes(parts);
    setBox(
      bounds !== undefined && bounds.width > 0
        ? { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height }
        : { x: ARTWORK / 4, y: ARTWORK / 4, w: ARTWORK / 2, h: ARTWORK / 2 },
    );
  }, [seated]);
  const target = useRef<HTMLDivElement | null>(null);
  // The bench's progress bar needs the length of the wait it is counting down.
  const longest = useRef<{ id: string | null; ms: number }>({ id: null, ms: 0 });
  if (longest.current.id !== nextId || assembly.cooldownMs > longest.current.ms) {
    longest.current = { id: nextId, ms: assembly.cooldownMs };
  }
  const benchFill =
    longest.current.ms > 0 ? 1 - assembly.cooldownMs / longest.current.ms : assembly.ready ? 1 : 0;

  const attach = (): void => {
    if (nextId === null) {
      return;
    }
    store.dispatch(attachPiece(nextId));
    setSeated(null);
    setTurned([]);
    setSnap((n) => n + 1);
  };

  const spots = seated === null || box === null ? [] : screwSpots(box, shapes, seated);
  const turn = (index: number): void => {
    if (turned.includes(index)) {
      return;
    }
    const next = [...turned, index];
    sfx.click();
    setTurned(next);
    if (next.length >= spots.length) {
      attach();
    }
  };

  const overTarget = (x: number, y: number): boolean => {
    const rect = target.current?.getBoundingClientRect();
    return (
      rect !== undefined && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    );
  };

  const onDown = (event: ReactPointerEvent<HTMLButtonElement>, pieceId: string): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ pieceId, x: event.clientX, y: event.clientY, over: false });
  };
  const onMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (drag === null) {
      return;
    }
    setDrag({
      ...drag,
      x: event.clientX,
      y: event.clientY,
      over: overTarget(event.clientX, event.clientY),
    });
  };
  const onUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (drag !== null && overTarget(event.clientX, event.clientY)) {
      setSeated(drag.pieceId);
      setTurned([]);
      // The piece lands with a thunk and the machine takes it with a ring.
      sfx.stamp();
      setSnap((n) => n + 1);
    }
    setDrag(null);
  };

  const controller = attached.includes('controller');
  return (
    <section className="bench" aria-label="assembly bench" data-testid="assembly-bench">
      <div
        ref={target}
        className={[
          'bench__printer',
          drag === null ? '' : 'is-dragging',
          drag?.over === true ? 'is-over' : '',
        ].join(' ')}
      >
        <div className="bench__rig">
          {/* Two identical animations, alternated, replay the snap on every
            piece without remounting the printer. */}
          <svg
            className={
              snap === 0 ? 'bench__svg' : `bench__svg ${snap % 2 === 0 ? 'is-snap-a' : 'is-snap-b'}`
            }
            viewBox={`0 0 ${ARTWORK} ${ARTWORK}`}
            role="img"
            aria-label={`Something half built: ${attached.length} pieces fitted`}
          >
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant stylesheet, never user input */}
            <style dangerouslySetInnerHTML={{ __html: CHARACTER_CSS }} />
            {nextId === null || seated !== null ? null : (
              <g className="bench__ghost">
                <Character
                  kind="mk1"
                  face="idle"
                  progress={0}
                  parts={[nextId]}
                  printing={false}
                  phaseOffset={0}
                />
              </g>
            )}
            <g data-testid="bench-printer">
              <Character
                kind="mk1"
                face={controller ? 'wow' : 'idle'}
                progress={0}
                parts={attached}
                printing={false}
                phaseOffset={0}
              />
            </g>
            {seated === null ? null : (
              <g className="bench__loose" ref={loose}>
                <Character
                  kind="mk1"
                  face="idle"
                  progress={0}
                  parts={[seated]}
                  printing={false}
                  phaseOffset={0}
                />
              </g>
            )}
          </svg>
          {spots.map((spot, index) => {
            const power = seated === POWER_PIECE;
            const done = turned.includes(index);
            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: a piece's screws are a fixed, ordered set
                key={index}
                type="button"
                className={[power ? 'bench__power' : 'bench__screw', done ? 'is-turned' : ''].join(
                  ' ',
                )}
                data-testid={power ? 'power-on' : `screw-${index}`}
                style={{
                  left: `${(spot.x / ARTWORK) * 100}%`,
                  top: `${(spot.y / ARTWORK) * 100}%`,
                }}
                aria-label={power ? 'Power on' : `Tighten screw ${index + 1}`}
                disabled={done}
                onClick={() => turn(index)}
              >
                {power ? '⏻' : null}
              </button>
            );
          })}
        </div>
        {snap === 0 ? null : (
          <span
            key={snap}
            className="bench__click"
            aria-hidden="true"
            style={{ animationDuration: `${SNAP_MS}ms` }}
          >
            click!
          </span>
        )}
        <p className="bench__caption">
          {seated !== null
            ? seated === POWER_PIECE
              ? 'Press the power button'
              : `Tighten the screws. ${turned.length}/${spots.length || SCREWS}`
            : drag !== null
              ? drag.over
                ? 'Let go.'
                : `Where does the ${nextName.toLowerCase()} go?`
              : nextId === null
                ? '…'
                : attached.length === 0
                  ? `Drag the ${nextName.toLowerCase()} onto the mat.`
                  : assembly.ready
                    ? `The ${nextName.toLowerCase()} goes on next.`
                    : 'Wait for it…'}
        </p>
      </div>

      <div className="bench__tray">
        <div className="bench__head">
          <span className="field__label">Pieces</span>
          <span className="bench__count">{`${attached.length} / ${assembly.totalPieces}`}</span>
        </div>
        <ol className="bench__pieces">
          {pieces.map((piece) => {
            const done = attached.includes(piece.id);
            const next = piece.id === nextId;
            const grabbable = next && assembly.ready && seated === null;
            const lifted = drag?.pieceId === piece.id;
            const state = done
              ? 'is-done'
              : next
                ? grabbable
                  ? 'is-ready'
                  : 'is-baking'
                : 'is-later';
            return (
              <li key={piece.id} className={`piece ${state}${lifted ? ' is-lifted' : ''}`}>
                <button
                  type="button"
                  className="piece__card"
                  disabled={!grabbable}
                  aria-label={
                    done || next
                      ? grabbable
                        ? `Drag the ${piece.name} into place`
                        : piece.name
                      : 'An unknown piece'
                  }
                  data-piece={piece.id}
                  onPointerDown={grabbable ? (event) => onDown(event, piece.id) : undefined}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={() => setDrag(null)}
                >
                  {/* Pieces not yet reached stay unknown: what this is
                      becoming is the intro's one surprise. */}
                  {done || next ? (
                    <PieceThumb pieceId={piece.id} />
                  ) : (
                    <span className="piece__art piece__art--unknown" aria-hidden="true">
                      ?
                    </span>
                  )}
                  <span className="piece__name">{done || next ? piece.name : '???'}</span>
                  <span className="piece__state">
                    {done
                      ? 'fitted'
                      : piece.id === seated
                        ? 'fasten it'
                        : grabbable
                          ? 'drag me'
                          : next
                            ? formatCountdown(assembly.cooldownMs)
                            : ''}
                  </span>
                  {next && !assembly.ready ? (
                    <span className="piece__bake" style={{ width: `${benchFill * 100}%` }} />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
        {nextId === null ? null : (
          <button
            type="button"
            className="bench__attach"
            data-testid="attach"
            data-key="A"
            disabled={!assembly.ready}
            onClick={attach}
          >
            {assembly.ready
              ? `Attach ${nextName}`
              : `${nextName} — ${formatCountdown(assembly.cooldownMs)}`}
          </button>
        )}
      </div>

      {drag === null ? null : (
        <div
          className={drag.over ? 'piece-ghost is-over' : 'piece-ghost'}
          style={{ left: drag.x, top: drag.y }}
          aria-hidden="true"
        >
          <PieceThumb pieceId={drag.pieceId} />
        </div>
      )}
    </section>
  );
}

/** The machine's first look around, then its walk to the floor. */
const AWAKEN_HOLD_MS = 1500;
const AWAKEN_MS = 2600;

/**
 * The reveal: the finished machine, huge, opens its eyes; then it shrinks into
 * the workshop that is fading in around it.
 */
export function Awakening({ onDone }: { onDone: () => void }): ReactElement {
  const done = useRef(onDone);
  done.current = onDone;
  const figure = useRef<SVGGElement | null>(null);
  const [flight, setFlight] = useState<CSSProperties | null>(null);
  useEffect(() => {
    // After its first look around, the machine walks to where it will stand:
    // the very printer on the workshop floor, not a stand-in that fades away.
    const fly = setTimeout(() => {
      const from = figure.current?.getBoundingClientRect();
      const to = document
        .querySelector('.stage [data-lead] [data-testid="printer-figure"]')
        ?.getBoundingClientRect();
      if (from === undefined || to === undefined || from.width === 0) {
        return;
      }
      const scale = to.width / from.width;
      setFlight({
        transform: `translate(${to.left + to.width / 2 - (from.left + from.width / 2)}px, ${
          to.top + to.height / 2 - (from.top + from.height / 2)
        }px) scale(${scale})`,
      });
    }, AWAKEN_HOLD_MS);
    const finish = setTimeout(() => done.current(), AWAKEN_MS);
    return () => {
      clearTimeout(fly);
      clearTimeout(finish);
    };
  }, []);
  return (
    <div className={flight === null ? 'awaken' : 'awaken is-flying'} aria-hidden="true">
      <svg
        className="awaken__svg pc-char"
        viewBox={`0 0 ${ARTWORK} ${ARTWORK}`}
        style={flight ?? undefined}
      >
        <title>It wakes up</title>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant stylesheet, never user input */}
        <style dangerouslySetInnerHTML={{ __html: CHARACTER_CSS }} />
        <g ref={figure}>
          <Character kind="mk1" face="wow" progress={0} printing={false} phaseOffset={0} />
        </g>
      </svg>
      <p className="awaken__line">Oh. Hello.</p>
    </div>
  );
}
