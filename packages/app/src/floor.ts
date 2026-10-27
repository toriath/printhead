import { FLOOR_HEIGHT, FLOOR_WIDTH, clampToFloor, floorSpot } from '@printhead/renderer';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';

/**
 * The workshop floor: printers stand where the player puts them. Where a
 * machine stands is the player's taste, not the game's state, so it lives in
 * this browser's storage beside the mute switch and never reaches the save or
 * the simulation.
 *
 * A press that does not move is still a press (the overclock); only a drag
 * past `DRAG_PX` moves the machine, and the click that ends a drag is eaten.
 */

type Spot = { readonly x: number; readonly y: number };
type Spots = Readonly<Record<string, Spot>>;

const STORAGE_KEY = 'printhead:floor';
const DRAG_PX = 6;

function load(): Spots {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Spots) : {};
  } catch {
    return {};
  }
}

function save(spots: Spots): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(spots));
  } catch {
    // Storage blocked: the arrangement lasts for this session.
  }
}

export interface Floor {
  readonly positions: Spots;
  readonly grabbed: string | null;
  /** Wire to the stage's pointer-down. */
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** True right after a drag, so the click that ends it does not overclock. */
  readonly swallowClick: () => boolean;
}

export function useFloor(slotIds: readonly string[]): Floor {
  const [positions, setPositions] = useState<Spots>(load);
  const [grabbed, setGrabbed] = useState<string | null>(null);
  const dragged = useRef(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    const spot = (event.target as Element).closest('[data-slot-id]');
    const svg = event.currentTarget.querySelector<SVGSVGElement>('svg.printhead-workshop');
    const slotId = spot?.getAttribute('data-slot-id') ?? null;
    if (slotId === null || svg === null || event.button !== 0) {
      return;
    }
    const matrix = svg.getScreenCTM()?.inverse();
    if (matrix === undefined) {
      return;
    }
    const toFloor = (clientX: number, clientY: number): Spot => {
      const point = new DOMPoint(clientX, clientY).matrixTransform(matrix);
      return { x: point.x / FLOOR_WIDTH, y: point.y / FLOOR_HEIGHT };
    };
    const startClient = { x: event.clientX, y: event.clientY };
    const startFloor = toFloor(event.clientX, event.clientY);
    const from = clampToFloor(floorSpot(slotId, slotIds.indexOf(slotId), positions));
    dragged.current = false;
    let latest = positions;

    const move = (moved: PointerEvent): void => {
      const distance = Math.hypot(moved.clientX - startClient.x, moved.clientY - startClient.y);
      if (!dragged.current && distance < DRAG_PX) {
        return;
      }
      dragged.current = true;
      setGrabbed(slotId);
      const now = toFloor(moved.clientX, moved.clientY);
      latest = {
        ...latest,
        // Wholly on the floor, whatever the pointer does.
        [slotId]: clampToFloor({
          x: from.x + now.x - startFloor.x,
          y: from.y + now.y - startFloor.y,
        }),
      };
      setPositions(latest);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGrabbed(null);
      if (dragged.current) {
        save(latest);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const swallowClick = (): boolean => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  };

  return { positions, grabbed, onPointerDown, swallowClick };
}
