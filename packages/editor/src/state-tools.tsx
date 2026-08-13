import { type ReactElement, useCallback, useState } from 'react';
import type { EditorHost } from './host.js';

/**
 * The editor's **state tools** and **balance view** (spec §14).
 *
 * Everything here reaches the game through `EditorHost`, so the panel still
 * knows nothing about the store, the clock or the server — and the whole thing
 * stays drivable by a fake host in tests.
 */
export interface StateToolsProps {
  readonly host: EditorHost;
  /** Called after anything that changes the game, so the panel re-reads it. */
  readonly onChanged: () => void;
}

/** Balances a cheat can hand out. Read from the ledger, not listed here. */
type Grantable = 'parts' | 'money' | 'scrap' | 'products' | 'plates' | 'designs';

const GRANT_STEPS = [100, 10_000, 1_000_000] as const;

/**
 * A GameState tree view: `<details>` for anything with children, one line for
 * anything without. Recursive and shape-agnostic, so a field added to
 * `GameState` shows up here the same day it is added.
 */
export function StateNode({
  label,
  value,
  depth = 0,
  path = label,
}: { label: string; value: unknown; depth?: number; path?: string }): ReactElement {
  const isBranch = typeof value === 'object' && value !== null;
  if (!isBranch) {
    return (
      <div className="ph-editor__tree-leaf" data-testid={`tree-${path}`}>
        <span className="ph-editor__label">{label}</span>
        <span>{typeof value === 'number' ? formatNumber(value) : String(value)}</span>
      </div>
    );
  }
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value as Record<string, unknown>);
  return (
    <details className="ph-editor__tree" open={depth === 0} data-testid={`tree-${path}`}>
      <summary>{`${label} (${entries.length})`}</summary>
      {entries.map(([key, child]) => (
        <StateNode key={key} label={key} value={child} depth={depth + 1} path={`${path}.${key}`} />
      ))}
    </details>
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/**
 * A sparkline of one series (spec §14: "live resource-curve sparklines — the
 * human twin of the bot reports"). Scaled to its own maximum, because the
 * question a sparkline answers is "what shape is this?", not "how does Money
 * compare with Parts?".
 */
export function Sparkline({
  label,
  points,
}: { label: string; points: readonly number[] }): ReactElement {
  const width = 120;
  const height = 24;
  const peak = Math.max(...points, 1);
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const path = points
    .map(
      (value, index) =>
        `${(index * step).toFixed(1)},${(height - (value / peak) * height).toFixed(1)}`,
    )
    .join(' ');
  return (
    <div className="ph-editor__spark" data-testid={`spark-${label}`} data-peak={peak}>
      <span className="ph-editor__label">{label}</span>
      <svg
        role="img"
        aria-label={`${label} over time`}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
      >
        <polyline points={path} fill="none" stroke="currentColor" strokeWidth={1} />
      </svg>
      <span>{formatNumber(points.at(-1) ?? 0)}</span>
    </div>
  );
}

export interface BalanceViewProps {
  readonly host: EditorHost;
  /** Sampled series, newest last — the panel owns the ring buffer. */
  readonly series: Readonly<Record<string, readonly number[]>>;
}

/**
 * The phase timer against its §6 budget, plus the sparklines. The budget comes
 * out of the running content, so a designer who edits `pacing.json` in the
 * panel above sees this bar move immediately.
 */
export function BalanceView({ host, series }: BalanceViewProps): ReactElement {
  const state = host.getState();
  const raw = host.getRawContent();
  const phases =
    (raw.pacing as { phases?: { id: string; budgetDesignMinutes: number }[] }).phases ?? [];
  const budget = phases.find((phase) => phase.id === state.phaseId)?.budgetDesignMinutes ?? 0;
  const elapsed = (state.simTimeMs - state.phaseEnteredAtMs) / 60_000;
  const over = budget > 0 && elapsed > budget;
  return (
    <section className="ph-editor__section" aria-label="balance view">
      <div data-testid="editor-phase-timer" data-over-budget={over}>
        {`${state.phaseId}: ${elapsed.toFixed(1)} / ${budget.toFixed(0)} design-min`}
      </div>
      {Object.entries(series).map(([label, points]) => (
        <Sparkline key={label} label={label} points={points} />
      ))}
    </section>
  );
}

export function StateTools({ host, onChanged }: StateToolsProps): ReactElement {
  const [seed, setSeed] = useState(() => String(host.getState().rng.seed));
  const [grant, setGrant] = useState<Grantable>('money');
  const [transfer, setTransfer] = useState('');
  const [status, setStatus] = useState('');

  const state = host.getState();

  const applySeed = useCallback(() => {
    const text = seed.trim();
    const parsed = Number(text);
    // An empty box is not a seed. `Number('')` is 0, and a number input hands
    // back `''` for anything it cannot parse, so without this "nope" would
    // silently re-seed the run to zero.
    if (text === '' || !Number.isFinite(parsed)) {
      setStatus('seed must be a number');
      return;
    }
    host.setSeed(parsed);
    setStatus(`seed ${parsed}, stream rewound`);
    onChanged();
  }, [host, onChanged, seed]);

  return (
    <>
      <section className="ph-editor__section" aria-label="state tools">
        <label>
          <span className="ph-editor__label">Seed</span>
          <input
            type="number"
            data-testid="editor-seed"
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
          />
        </label>
        <button type="button" data-testid="editor-seed-apply" onClick={applySeed}>
          Set
        </button>

        <select
          data-testid="editor-grant-kind"
          value={grant}
          onChange={(event) => setGrant(event.target.value as Grantable)}
        >
          {Object.keys(state.resources).map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
        {GRANT_STEPS.map((amount) => (
          <button
            key={amount}
            type="button"
            data-testid={`editor-grant-${amount}`}
            onClick={() => {
              host.grantResource(grant, amount);
              setStatus(`granted ${amount} ${grant}`);
              onChanged();
            }}
          >
            {`+${amount.toLocaleString('en-GB')}`}
          </button>
        ))}

        <button
          type="button"
          data-testid="editor-export"
          onClick={() => {
            setTransfer(host.exportSave());
            setStatus('save exported below');
          }}
        >
          Export save
        </button>
        <button
          type="button"
          data-testid="editor-import"
          onClick={() => {
            const result = host.importSave(transfer);
            setStatus(result.message);
            onChanged();
          }}
        >
          Import save
        </button>
        <textarea
          data-testid="editor-save-json"
          aria-label="save json"
          value={transfer}
          onChange={(event) => setTransfer(event.target.value)}
        />
        <output data-testid="editor-state-status">{status}</output>
      </section>

      <section className="ph-editor__section" aria-label="action log">
        <ol className="ph-editor__log" data-testid="editor-action-log">
          {[...host.getActionLog()].reverse().map((entry, index) => (
            <li
              // The log is append-only and rendered newest-first, so position
              // from the end is a stable identity for an entry.
              key={`${entry.simTimeMs}-${entry.type}-${index}`}
            >
              {`${(entry.simTimeMs / 1000).toFixed(1)}s ${entry.type} ${entry.detail}`}
            </li>
          ))}
        </ol>
      </section>

      <section className="ph-editor__section" aria-label="game state">
        <StateNode label="GameState" value={state} />
      </section>
    </>
  );
}
