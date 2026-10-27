import { type ReactElement, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './icons.js';
import { markSeen, useNew } from './seen.js';

/**
 * The sidebar's tabs. Every panel already decides for itself whether its
 * mechanic is unlocked (it renders nothing until then), so the tab bar does
 * not repeat those rules: it renders every panel, measures which ones produced
 * anything, and offers a tab for exactly those. The badge counts what can be
 * done in a panel right now — its enabled buttons — so a tab with something
 * affordable says so without being opened.
 */
export interface PanelTab {
  readonly id: string;
  readonly label: string;
  readonly icon?: IconName;
  readonly content: ReactNode;
}

interface TabState {
  readonly available: readonly string[];
  readonly badges: Readonly<Record<string, number>>;
}

export function PanelTabs({
  tabs,
  onAvailable,
}: {
  tabs: readonly PanelTab[];
  /** Told how many tabs have anything to show, so the shell can fold the column away. */
  onAvailable?: (count: number) => void;
}): ReactElement {
  const [active, setActive] = useState<string | null>(null);
  const [measured, setMeasured] = useState<TabState>({ available: [], badges: {} });
  const holders = useRef<Record<string, HTMLDivElement | null>>({});

  useLayoutEffect(() => {
    const available: string[] = [];
    const badges: Record<string, number> = {};
    for (const tab of tabs) {
      const holder = holders.current[tab.id];
      if (holder !== null && holder !== undefined && holder.childElementCount > 0) {
        available.push(tab.id);
        badges[tab.id] = holder.querySelectorAll('button:not(:disabled)').length;
      }
    }
    const same =
      available.join() === measured.available.join() &&
      available.every((id) => badges[id] === measured.badges[id]);
    if (!same) {
      setMeasured({ available, badges });
      onAvailable?.(available.length);
    }
  });

  const fresh = useNew(measured.available.map((id) => `tab:${id}`));
  const current =
    active !== null && measured.available.includes(active)
      ? active
      : (measured.available[0] ?? null);

  return (
    <div className="tabs">
      <div className="tabs__bar" role="tablist" aria-label="Workshop panels">
        {tabs
          .filter((tab) => measured.available.includes(tab.id))
          .map((tab) => {
            const badge = measured.badges[tab.id] ?? 0;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === current}
                className={fresh.has(`tab:${tab.id}`) ? 'tabs__tab is-new' : 'tabs__tab'}
                data-testid={`tab-${tab.id}`}
                onClick={() => {
                  setActive(tab.id);
                  markSeen(`tab:${tab.id}`);
                }}
              >
                {tab.icon === undefined ? null : <Icon name={tab.icon} size={15} />}
                {tab.label}
                {badge > 0 ? <span className="tabs__badge">{badge}</span> : null}
              </button>
            );
          })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          ref={(element) => {
            holders.current[tab.id] = element;
          }}
          className="tabs__panel"
          role="tabpanel"
          hidden={tab.id !== current}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
