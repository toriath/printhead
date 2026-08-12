import type { ContentFileName, RawContent } from '@printhead/core';
import { CONTENT_FILE_NAMES } from '@printhead/core';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import type { EditorHost } from './host.js';
import { type EditableField, type PathSegment, editableGroups, setAtPath } from './inspector.js';
import { describeContent } from './schema-form.js';
import { EDITOR_CSS } from './styles.js';

/**
 * The dev Editor panel (spec §14) — a Unity-style inspector for this game.
 *
 * Three rules keep it honest:
 *
 * 1. **The forms are generated.** Every widget comes from the zod schema via
 *    `describeContent()`, so a new content file shows up here with no editor
 *    code, and a field the schema does not know about cannot be edited.
 * 2. **Edits go through the same validator as the game.** `applyContent`
 *    re-validates the whole set — cross-file references included — and keeps
 *    the last good content on failure, so a half-typed number cannot take the
 *    running simulation down.
 * 3. **It is dev-only.** The panel is behind `import.meta.env.DEV` and loaded
 *    from a dynamic import at the call site, so the production bundle never
 *    contains it.
 */
export interface EditorPanelProps {
  readonly host: EditorHost;
  /** Start open — handy for the Playwright smoke test. */
  readonly initiallyOpen?: boolean;
}

/** Warp factors offered on top of pace (spec §14). */
const WARPS = [1, 10, 100] as const;

function FieldInput({
  field,
  onChange,
}: {
  field: EditableField;
  onChange: (path: readonly PathSegment[], value: number | string | boolean) => void;
}): ReactElement {
  const testId = `field-${field.id}`;
  if (field.kind === 'boolean') {
    return (
      <input
        type="checkbox"
        data-testid={testId}
        checked={field.value === true}
        onChange={(event) => onChange(field.path, event.target.checked)}
      />
    );
  }
  if (field.kind === 'enum') {
    return (
      <select
        data-testid={testId}
        value={String(field.value)}
        onChange={(event) => onChange(field.path, event.target.value)}
      >
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === 'number') {
    return (
      <input
        type="number"
        data-testid={testId}
        value={String(field.value)}
        step={field.int === true ? 1 : 'any'}
        {...(field.min === undefined ? {} : { min: field.min })}
        {...(field.max === undefined ? {} : { max: field.max })}
        onChange={(event) => {
          const text = event.target.value.trim();
          const parsed = Number(text);
          // A half-typed box is not an edit. `Number('')` is 0, so an empty
          // field would otherwise apply a zero and reject the whole content
          // set the moment the designer selected the old value to retype it.
          if (text !== '' && Number.isFinite(parsed)) {
            onChange(field.path, parsed);
          }
        }}
      />
    );
  }
  return (
    <input
      type="text"
      data-testid={testId}
      value={String(field.value)}
      onChange={(event) => onChange(field.path, event.target.value)}
    />
  );
}

export function EditorPanel({ host, initiallyOpen = false }: EditorPanelProps): ReactElement {
  const [open, setOpen] = useState(initiallyOpen);
  const [file, setFile] = useState<ContentFileName>('pacing');
  const [raw, setRaw] = useState<RawContent>(() => host.getRawContent());
  const [status, setStatus] = useState('');
  const [, forceRender] = useState(0);

  /**
   * The panel shows live state (phase, clock, warp), so it follows the store —
   * *and* re-renders after its own controls, because pausing the loop is the
   * one action that stops the store from ever notifying it again.
   */
  const bump = useCallback(() => forceRender((tick) => tick + 1), []);
  useEffect(() => host.subscribe(bump), [host, bump]);

  const described = describeContent();
  const groups = editableGroups(described[file], raw[file]);

  const change = useCallback(
    (path: readonly PathSegment[], value: number | string | boolean) => {
      const next: RawContent = { ...raw, [file]: setAtPath(raw[file], path, value) };
      setRaw(next);
      const validation = host.applyContent(next);
      setStatus(
        validation.ok
          ? 'applied'
          : `rejected — ${validation.issues[0]?.path}: ${validation.issues[0]?.message}`,
      );
    },
    [file, host, raw],
  );

  const save = useCallback(async () => {
    setStatus('writing…');
    const result = await host.writeContent(file, raw[file]);
    setStatus(result.message);
  }, [file, host, raw]);

  const revert = useCallback(() => {
    const original = host.getRawContent();
    setRaw(original);
    host.applyContent(original);
    setStatus('reverted to the running content');
  }, [host]);

  if (!open) {
    return (
      <div className="ph-editor ph-editor--closed">
        <style>{EDITOR_CSS}</style>
        <button type="button" data-testid="editor-open" onClick={() => setOpen(true)}>
          Editor
        </button>
      </div>
    );
  }

  const state = host.getState();
  const visual = host.getVisualState();
  const phases = (raw.pacing as { phases?: { id: string; name: string }[] }).phases ?? [];

  return (
    <aside className="ph-editor" data-testid="editor" aria-label="dev editor">
      <style>{EDITOR_CSS}</style>
      <header className="ph-editor__bar">
        <strong>Editor</strong>
        <span data-testid="editor-phase">{`${visual.phaseId} · ${(visual.simTimeMs / 60000).toFixed(1)} design-min`}</span>
        <button type="button" data-testid="editor-close" onClick={() => setOpen(false)}>
          Close
        </button>
      </header>

      <section className="ph-editor__section" aria-label="time controls">
        <button
          type="button"
          data-testid="editor-pause"
          onClick={() => {
            host.setPaused(!host.isPaused());
            bump();
          }}
        >
          {host.isPaused() ? 'Resume' : 'Pause'}
        </button>
        {WARPS.map((warp) => (
          <button
            key={warp}
            type="button"
            data-testid={`editor-warp-${warp}`}
            aria-pressed={host.getTimeScale() === warp}
            onClick={() => {
              host.setTimeScale(warp);
              bump();
            }}
          >
            {`×${warp}`}
          </button>
        ))}
        <label>
          <span className="ph-editor__label">Jump to</span>
          <select
            data-testid="editor-jump"
            value={visual.phaseId}
            onChange={(event) => {
              host.jumpToPhase(event.target.value);
              bump();
            }}
          >
            {phases.map((phase) => (
              <option key={phase.id} value={phase.id}>
                {phase.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="ph-editor__section" aria-label="content inspector">
        <select
          data-testid="editor-file"
          value={file}
          onChange={(event) => setFile(event.target.value as ContentFileName)}
        >
          {CONTENT_FILE_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button type="button" data-testid="editor-write" onClick={() => void save()}>
          Write to disk
        </button>
        <button type="button" data-testid="editor-revert" onClick={revert}>
          Revert
        </button>
        <output data-testid="editor-status">{status}</output>
      </section>

      <div className="ph-editor__scroll">
        {groups.map((group) => (
          <details key={group.id} open={groups.length === 1}>
            <summary>{group.label}</summary>
            <dl className="ph-editor__fields">
              {group.fields.map((field) => (
                <div key={field.id} className="ph-editor__field">
                  <dt>{field.label}</dt>
                  <dd>
                    <FieldInput field={field} onChange={change} />
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        ))}
      </div>

      <section className="ph-editor__section" aria-label="state tools">
        <span data-testid="editor-state">
          {`parts ${state.resources.parts.toFixed(0)} · money ${state.resources.money.toFixed(0)} · scrap ${state.resources.scrap.toFixed(0)}`}
        </span>
      </section>
    </aside>
  );
}
