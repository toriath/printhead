import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Icon } from './icons.js';
import type { Diary } from './story.js';

/** Milliseconds per character as an unread page writes itself out. */
const TYPE_MS = 22;

/** One page, typing itself out if the player has not read it yet. */
function Page({
  text,
  typing,
  onDone,
}: { text: string; typing: boolean; onDone: () => void }): ReactElement {
  const [shown, setShown] = useState(typing ? 0 : text.length);
  // The game re-renders every tick; the typing must not restart with it.
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!typing) {
      setShown(text.length);
      return undefined;
    }
    const timer = setInterval(() => {
      setShown((n) => {
        if (n >= text.length) {
          clearInterval(timer);
          done.current();
          return n;
        }
        return n + 1;
      });
    }, TYPE_MS);
    return () => clearInterval(timer);
  }, [text, typing]);
  return (
    <p className={shown < text.length ? 'diary__page is-typing' : 'diary__page'}>
      {text.slice(0, shown)}
    </p>
  );
}

/** The top-bar button: a book with a count of unread pages. */
export function DiaryButton({
  diary,
  onOpen,
}: { diary: Diary; onOpen: () => void }): ReactElement | null {
  if (diary.entries.length === 0) {
    return null;
  }
  const unread = diary.unread.size;
  return (
    <button
      type="button"
      className={unread > 0 ? 'mute diary-button has-unread' : 'mute diary-button'}
      data-testid="diary-open"
      aria-label={unread > 0 ? `The printer's diary, ${unread} unread` : "The printer's diary"}
      onClick={onOpen}
    >
      <Icon name="diary" />
      {unread > 0 ? <span className="tabs__badge">{unread}</span> : null}
    </button>
  );
}

/**
 * The diary itself, a drawer from the right. Unread pages write themselves
 * out one after another; read ones are simply there. Closing it marks
 * everything read. Nothing in the game waits for it.
 */
export function DiaryDrawer({
  diary,
  onClose,
}: { diary: Diary; onClose: () => void }): ReactElement {
  const [unread] = useState(() => [...diary.unread]);
  const [typing, setTyping] = useState(0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="diary" data-testid="diary">
      <button
        type="button"
        className="diary__backdrop"
        aria-label="Close the diary"
        onClick={onClose}
      />
      <aside className="diary__book" aria-label="The printer's diary">
        <header className="diary__head">
          <h2>The printer's diary</h2>
          <button type="button" className="mute" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="diary__pages">
          {diary.entries.map((entry) => {
            const order = unread.indexOf(entry.id);
            if (order > typing) {
              return null;
            }
            return (
              <Page
                key={entry.id}
                text={entry.text}
                typing={order === typing}
                onDone={() => setTyping((n) => (n === order ? n + 1 : n))}
              />
            );
          })}
        </div>
      </aside>
    </div>
  );
}
