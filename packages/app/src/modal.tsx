import { type ReactElement, type ReactNode, useEffect, useRef } from 'react';

/**
 * A modal for the decisions that cannot be taken back (the melt-down, the
 * fork). It holds focus on its first button, closes on Escape or a click on
 * the backdrop, and renders nothing while closed.
 */
export interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
}

export function Modal({ open, title, onClose, children, testId }: ModalProps): ReactElement | null {
  const card = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    card.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) {
    return null;
  }
  return (
    <div className="modal" data-testid={testId}>
      <button type="button" className="modal__backdrop" aria-label="Close" onClick={onClose} />
      {/* biome-ignore lint/a11y/useSemanticElements: a native <dialog> needs showModal() from an effect; this one is rendered open and manages its own focus and Escape */}
      <div className="modal__card" role="dialog" aria-modal="true" aria-label={title} ref={card}>
        <h2 className="modal__title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
