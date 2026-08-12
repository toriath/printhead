import type { ContentValidation, MutableContentSource, RawContent } from '@printhead/core';

/**
 * Content hot-reload, client half (spec §11: "Vite watch → sim swaps defs
 * live"). The dev server watches `packages/core/content/*.json` and pushes the
 * whole raw set over the HMR socket; here it is validated and swapped into the
 * running simulation without a reload, so a balance tweak is visible in the
 * game a second after it is saved.
 *
 * Invalid content is *rejected and kept out*: `MutableContentSource` holds the
 * last good set, so a half-typed JSON file cannot take the game down.
 */
export const CONTENT_HMR_EVENT = 'printhead:content';

/** The slice of `import.meta.hot` this needs — injected so it can be tested. */
export interface HotChannel {
  on(event: string, callback: (payload: unknown) => void): void;
}

export interface ContentHotReloadOptions {
  readonly hot: HotChannel | undefined;
  readonly source: MutableContentSource;
  readonly onApplied?: (validation: ContentValidation) => void;
}

export function connectContentHotReload(options: ContentHotReloadOptions): void {
  const { hot, source } = options;
  if (hot === undefined) {
    return;
  }
  hot.on(CONTENT_HMR_EVENT, (payload: unknown) => {
    const validation = source.replace(payload as RawContent);
    options.onApplied?.(validation);
    if (!validation.ok) {
      console.warn(
        `[printhead] content update rejected, keeping the last good set:\n${validation.issues
          .map((issue) => `  - ${issue.path}: ${issue.message}`)
          .join('\n')}`,
      );
    }
  });
}
