import { type VisualState, buyAutomation, setAutomation } from '@printhead/core';
import type { ReactElement } from 'react';
import { price } from './afford.js';
import { contentOf, describeAutomation } from './describe.js';
import { formatAmount } from './format.js';
import type { GameStore } from './store.js';

/**
 * The staff. Agents are automations with a name, a job title and opinions:
 * a sales agent who runs the shop front, an account manager who takes clients
 * on. They do what the player could do by hand — the point is the player no
 * longer has to — and they talk about it in the workshop log.
 */
export interface AgentsPanelProps {
  readonly store: GameStore;
  readonly visual: VisualState;
}

/** A face on the badge: the agent's screen, its eyes a little different each. */
function Portrait({ name, on }: { name: string; on: boolean }): ReactElement {
  const tilt = (name.charCodeAt(0) % 3) - 1;
  return (
    <svg
      className={on ? 'agent__face is-on' : 'agent__face'}
      viewBox="0 0 40 40"
      aria-hidden="true"
    >
      <rect x="4" y="8" width="32" height="26" rx="8" className="agent__head" />
      <path d="M20 8V3" className="agent__antenna" />
      <circle cx="20" cy="3" r="2" className="agent__bulb" />
      <rect x="9" y="13" width="22" height="13" rx="3" className="agent__screen" />
      <rect x={13} y={16 + tilt} width="3" height="5" className="agent__eye" />
      <rect x={24} y={16 - tilt} width="3" height="5" className="agent__eye" />
    </svg>
  );
}

export function AgentsPanel({ store, visual }: AgentsPanelProps): ReactElement | null {
  const agents = visual.automation.filter(
    (row) => row.agent !== null && (row.available || row.installed),
  );
  if (agents.length === 0) {
    return null;
  }
  return (
    <section className="panel" aria-label="agents" data-testid="agents">
      <h2>Agents</h2>
      <ul className="agents">
        {agents.map((row) => {
          const agent = row.agent;
          if (agent === null) {
            return null;
          }
          const working = row.installed && row.enabled;
          return (
            <li key={row.automationId} className={working ? 'agent is-working' : 'agent'}>
              <Portrait name={agent.name} on={working} />
              <div className="agent__who">
                <span className="agent__name">{agent.name}</span>
                <span className="agent__role">{agent.role}</span>
                <span className="panel__desc">
                  {describeAutomation(contentOf(store), row.automationId)}
                </span>
              </div>
              {row.installed ? (
                <button
                  type="button"
                  data-testid={`toggle-${row.automationId}`}
                  onClick={() =>
                    store.dispatch(setAutomation(row.automationId, { enabled: !row.enabled }))
                  }
                >
                  {row.enabled ? 'On duty' : 'Off duty'}
                </button>
              ) : (
                <button
                  type="button"
                  data-testid={`hire-${row.automationId}`}
                  disabled={!row.affordable}
                  {...price(visual, row.cost, row.costResource)}
                  onClick={() => store.dispatch(buyAutomation(row.automationId))}
                >
                  {`Hire · ${formatAmount(row.cost)} ${row.costResource}`}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
