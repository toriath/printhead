import { Workshop } from '@printhead/renderer';
import { useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type { GameStore } from './store.js';

export interface AppProps {
  readonly store: GameStore;
}

export function useVisualState(store: GameStore) {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getVisualState(),
  );
}

export function App({ store }: AppProps): ReactElement {
  const visual = useVisualState(store);
  return (
    <main>
      <header>
        <h1>PRINTHEAD</h1>
        <p data-testid="phase">{visual.phaseId}</p>
      </header>
      <Workshop visual={visual} />
    </main>
  );
}
