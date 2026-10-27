import { useEffect, useRef, useState } from 'react';
import * as sfx from './sfx.js';

/**
 * Discovery. Every newly revealed tab, material or object wears a sparkle
 * until the player touches it, and its first appearance chimes. What the
 * player has seen is their own history, not game state, so it lives in this
 * browser's storage — a fresh save on an old browser does not re-sparkle
 * things the player already knows.
 */

const STORAGE_KEY = 'printhead:seen';

function load(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

let seen = load();
const listeners = new Set<() => void>();

function persist(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...seen]));
  } catch {
    // Storage blocked: discoveries last for this session.
  }
}

export function markSeen(id: string): void {
  if (seen.has(id)) {
    return;
  }
  seen = new Set(seen).add(id);
  persist();
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Which of `ids` are new to this player, re-rendering when one is seen, and
 * chiming the first time a new one shows up in this session.
 */
export function useNew(ids: readonly string[]): ReadonlySet<string> {
  const [, bump] = useState(0);
  const chimed = useRef(new Set<string>());
  useEffect(() => {
    const listener = (): void => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const fresh = ids.filter((id) => !seen.has(id));
  const key = fresh.join();
  useEffect(() => {
    const unheard = (key === '' ? [] : key.split(',')).filter((id) => !chimed.current.has(id));
    if (unheard.length > 0) {
      for (const id of unheard) {
        chimed.current.add(id);
      }
      sfx.discover();
    }
  }, [key]);
  return new Set(fresh);
}
