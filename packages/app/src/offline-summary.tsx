import type { OfflineSummary } from '@printhead/core';
import type { ReactElement } from 'react';
import { formatAmount, formatDuration, formatMoney } from './format.js';

/**
 * "Welcome back" (spec §7.4). The numbers here are not a separate offline
 * economy — they are the difference the *same* reducer produced while replaying
 * the time away in chunks, which is why the screen can be this literal.
 */
export interface OfflineSummaryProps {
  readonly summary: OfflineSummary;
  readonly onDismiss: () => void;
}

export function OfflineSummaryScreen({ summary, onDismiss }: OfflineSummaryProps): ReactElement {
  const capped = summary.skippedWallMs > 0;
  return (
    <dialog className="offline" open aria-modal="true" aria-labelledby="offline-title">
      <div className="offline__panel" data-testid="offline-summary">
        <h2 id="offline-title">Welcome back</h2>
        <p data-testid="offline-away">
          {`The workshop ran for ${formatDuration(summary.appliedWallMs)}.`}
        </p>
        {capped ? (
          <p className="offline__capped" data-testid="offline-capped">
            {`Offline progress is capped at ${summary.cappedHours} h — ${formatDuration(
              summary.skippedWallMs,
            )} was not simulated.`}
          </p>
        ) : null}
        <dl className="offline__gains">
          <div>
            <dt>Parts printed</dt>
            <dd data-testid="offline-parts">{formatAmount(summary.gains.partsProduced)}</dd>
          </div>
          <div>
            <dt>Prints completed</dt>
            <dd data-testid="offline-prints">{formatAmount(summary.gains.printsCompleted)}</dd>
          </div>
          <div>
            <dt>Money earned</dt>
            <dd data-testid="offline-money">{formatMoney(summary.gains.money)}</dd>
          </div>
        </dl>
        {summary.fromPhaseId === summary.toPhaseId ? null : (
          <p data-testid="offline-phase">
            {`You moved from ${summary.fromPhaseId} to ${summary.toPhaseId}.`}
          </p>
        )}
        <button type="button" data-testid="offline-dismiss" onClick={onDismiss}>
          Back to work
        </button>
      </div>
    </dialog>
  );
}
