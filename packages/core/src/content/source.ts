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
  /**
   * The *raw* documents behind the validated set. The editor (spec §14) edits
   * JSON, not the parsed model: a zod schema may coerce or strip, so writing
   * the parsed form back to disk would slowly rewrite the content files into
   * something their author never typed.
   */
  raw(): RawContent;
  /** Replace the content set; invalid input is rejected and current content kept. */
  replace(raw: RawContent): ContentValidation;
}

export function createMutableContentSource(raw: RawContent = RAW_CONTENT): MutableContentSource {
  let content = loadContent(raw);
  let current = raw;
  const listeners = new Set<ContentListener>();
  return {
    id: 'mutable',
    get: () => content,
    raw: () => current,
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
        current = next;
        for (const listener of listeners) {
          listener(content);
        }
      }
      return validation;
    },
  };
}
