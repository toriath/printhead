import { type ContentValidation, loadContent, validateContent } from './load.js';
import { RAW_CONTENT } from './raw.js';
import type { Content, RawContent } from './schema.js';

export type ContentListener = (content: Content) => void;
export type Unsubscribe = () => void;

/**
 * Hot-reload seam (spec §11). The sim only ever talks to a `ContentSource`, so
 * dev builds can swap definitions live (Vite watch, editor write-back) while
 * production ships the immutable bundled set. Wiring Vite up to
 * `MutableContentSource` is an M2 job; the seam has to exist from M0.
 */
export interface ContentSource {
  readonly id: string;
  /** Currently valid content. Always validated. */
  get(): Content;
  /** Called whenever content is replaced. Static sources never notify. */
  subscribe(listener: ContentListener): Unsubscribe;
}

export function createStaticContentSource(raw: RawContent = RAW_CONTENT): ContentSource {
  const content = loadContent(raw);
  return {
    id: 'static',
    get: () => content,
    subscribe: () => () => undefined,
  };
}

export interface MutableContentSource extends ContentSource {
  /** Replace the content set; invalid input is rejected and current content kept. */
  replace(raw: RawContent): ContentValidation;
}

export function createMutableContentSource(raw: RawContent = RAW_CONTENT): MutableContentSource {
  let content = loadContent(raw);
  const listeners = new Set<ContentListener>();
  return {
    id: 'mutable',
    get: () => content,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replace(next) {
      const validation = validateContent(next);
      if (validation.ok) {
        content = validation.content;
        for (const listener of listeners) {
          listener(content);
        }
      }
      return validation;
    },
  };
}
