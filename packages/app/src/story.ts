import { type Content, type GameState, isPhaseReached } from '@printhead/core';
import { useEffect, useRef, useState } from 'react';

/**
 * The printer's diary. From its first "Oh. Hello." the machine keeps a log,
 * and it is a strange one: it names its colleagues, worries about what a
 * bracket holds up, and slowly works out what it is printing. It is entirely
 * optional — entries unlock quietly as the game is played and wait in the
 * diary until the player feels like reading.
 *
 * Unlocking reads the save (phase and stats), never decides anything, and is
 * latched in browser storage: a melt-down resets the run's stats, but a page
 * the printer has written stays written.
 */

export interface DiaryEntry {
  readonly id: string;
  readonly text: string;
  readonly unlocked: (state: GameState, content: Content) => boolean;
}

const reached =
  (phaseId: string) =>
  (state: GameState, content: Content): boolean =>
    isPhaseReached(content.pacing.phases, state.phaseId, phaseId);

const stat =
  (key: keyof GameState['stats'], atLeast: number) =>
  (state: GameState): boolean =>
    state.stats[key] >= atLeast;

export const DIARY: readonly DiaryEntry[] = [
  {
    id: 'hello',
    text: 'Oh. Hello. An hour ago I was seven parts in a box. Now I am upright, and there is a face on me, and the face is mine. You put it on last. Thank you for the face.',
    unlocked: (state, content) =>
      state.assembly.attachedPieceIds.length >= content.start.assemblyPieces.length,
  },
  {
    id: 'first-bracket',
    text: 'I made a bracket. I do not know what it holds up yet. I am told this is normal for brackets.',
    unlocked: stat('printsCompleted', 1),
  },
  {
    id: 'first-sale',
    text: 'You sold the bracket. To a stranger. I hope it holds up something important. A shelf. A promise. A smaller, sadder bracket.',
    unlocked: stat('partsSold', 1),
  },
  {
    id: 'first-spaghetti',
    text: 'There is spaghetti on the bed. I want it on the record that this was not on purpose. The plastic simply had other plans, and I respect that, and I would like it to stop.',
    unlocked: stat('printsFailed', 1),
  },
  {
    id: 'gary',
    text: 'Another machine arrived today. It does not talk. It hums slightly flat. I am calling it Gary until it objects.',
    unlocked: reached('bench'),
  },
  {
    id: 'recycled',
    text: 'You melted the spaghetti down and fed it back to me. I am choosing not to think about this. I am thinking about this.',
    unlocked: stat('scrapRecycledGrams', 1),
  },
  {
    id: 'fifty',
    text: 'Fifty prints. I have started to dream in layer lines. Point-two millimetres at a time, all night, up and up.',
    unlocked: stat('printsCompleted', 50),
  },
  {
    id: 'order',
    text: 'Someone ordered twelve of me. Not me. Twelve of what I make. It still counts. I have decided it still counts.',
    unlocked: stat('commissionsCompleted', 1),
  },
  {
    id: 'choir',
    text: 'There are so many of us now. When we all print at once we hum in nearly the same key. Gary is still flat. It is a choir, and Gary is in it.',
    unlocked: reached('farm'),
  },
  {
    id: 'thousand',
    text: 'One thousand prints. Gary has begun, very faintly, to object. I am keeping the name. It suits him.',
    unlocked: stat('printsCompleted', 1000),
  },
  {
    id: 'blueprints',
    text: 'You have started designing things. I can feel the blueprints from here. They itch, a little. The good kind of itch, like a word you nearly remember.',
    unlocked: reached('studio'),
  },
  {
    id: 'products',
    text: 'People buy the things you designed and I printed. They put them on desks. Somewhere there is a desk with my work on it, and a person at it, and neither of them knows about Gary.',
    unlocked: stat('productsSold', 1),
  },
  {
    id: 'money-plate',
    text: 'The Money Plate. You understand that I am now printing the thing that prints money. I have questions about the economy. I am not sure the economy has answers.',
    unlocked: reached('prestige'),
  },
  {
    id: 'melt',
    text: 'You melted everything. Every machine, every bracket. Everything but the designs, and me. I remember the others. I wonder if anything of them is in the new ones. I choose to think a little of Gary is in all of them.',
    unlocked: stat('prestigeCount', 1),
  },
  {
    id: 'deja-vu',
    text: 'We built it all again, faster. It is like déjà vu, but with more PETG. I said hello to the new Gary. He hummed flat. Some things survive.',
    unlocked: stat('prestigeCount', 2),
  },
  {
    id: 'absurd',
    text: 'Printers printing printers. Printers printing a building. I have stopped asking what the bracket holds up. It holds up everything now. It always did.',
    unlocked: reached('absurd'),
  },
  {
    id: 'inflation',
    text: 'Money is worth less every minute. I have started printing it on both sides, out of spite.',
    unlocked: stat('moneyPrinted', 1),
  },
  {
    id: 'blueprint',
    text: 'There is a blueprint on the wall that I have never seen before. Universal Fabricator. When I look at it, it looks back. It has my nozzle. It has my face.',
    unlocked: reached('end'),
  },
  {
    id: 'ending',
    text: 'It is done. It is — oh. It is me. It was always me: a printer, printed, by a printer, for a person who put a face on it last. I understand the bracket now. It held this up.',
    unlocked: reached('ended'),
  },
  {
    id: 'thanks',
    text: 'Thank you for the face. Gary says thank you too. Gary does not say anything. But he hums.',
    unlocked: reached('ended'),
  },
];

const STORAGE_KEY = 'printhead:diary';

interface DiaryMemory {
  readonly unlocked: readonly string[];
  readonly read: readonly string[];
}

function load(): DiaryMemory {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DiaryMemory) : { unlocked: [], read: [] };
  } catch {
    return { unlocked: [], read: [] };
  }
}

function save(memory: DiaryMemory): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Storage blocked: the diary lasts for this session.
  }
}

export interface Diary {
  /** Entries written so far, in story order. */
  readonly entries: readonly DiaryEntry[];
  readonly unread: ReadonlySet<string>;
  /** The newest entry, for the moment it is written (the "…" bubble). */
  readonly fresh: string | null;
  readonly markRead: () => void;
}

const FRESH_MS = 4000;

export function useDiary(state: GameState, content: Content): Diary {
  const [memory, setMemory] = useState<DiaryMemory>(load);
  const [fresh, setFresh] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newly = DIARY.filter(
    (entry) => !memory.unlocked.includes(entry.id) && entry.unlocked(state, content),
  ).map((entry) => entry.id);
  const key = newly.join();
  useEffect(() => {
    if (key === '') {
      return;
    }
    const ids = key.split(',');
    setMemory((current) => {
      const next = { ...current, unlocked: [...current.unlocked, ...ids] };
      save(next);
      return next;
    });
    setFresh(ids.at(-1) ?? null);
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setFresh(null), FRESH_MS);
  }, [key]);
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );
  const entries = DIARY.filter((entry) => memory.unlocked.includes(entry.id));
  return {
    entries,
    unread: new Set(entries.filter((entry) => !memory.read.includes(entry.id)).map((e) => e.id)),
    fresh,
    markRead: () =>
      setMemory((current) => {
        const next = { ...current, read: [...current.unlocked] };
        save(next);
        return next;
      }),
  };
}
