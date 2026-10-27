import { useEffect } from 'react';

/**
 * Keyboard shortcuts for the desktop shell. A key never dispatches anything
 * itself: it clicks the button that already offers the move, so a shortcut can
 * only do what the screen would let the mouse do, and a disabled button stays
 * disabled. Each button names its key in `data-key`, which the stylesheet
 * shows as a keycap.
 */
export const SHORTCUTS: Readonly<Record<string, string>> = {
  a: 'attach',
  l: 'configure',
  p: 'print',
  o: 'overclock',
  s: 'sell',
  f: 'buy-filament',
  b: 'buy-printer',
};

const TYPING = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

function press(selector: string): void {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (button !== null && !button.disabled) {
    button.click();
  }
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (target !== null && (TYPING.has(target.tagName) || target.isContentEditable)) ||
        document.querySelector('.modal') !== null
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (/^[1-4]$/.test(key)) {
        press(`[data-testid="bay-tab-${key}"]`);
        return;
      }
      const id = SHORTCUTS[key];
      if (id !== undefined) {
        event.preventDefault();
        press(`[data-testid="${id}"]`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
