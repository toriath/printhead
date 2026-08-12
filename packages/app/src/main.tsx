import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createGameStore } from './store.js';

/**
 * Shell entry point. The rAF pump feeds wall-clock time to the store; the
 * engine converts it to fixed 100 ms ticks at the configured pace (spec §8).
 */
const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root is missing from index.html');
}

const store = createGameStore();

createRoot(container).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);

let previousMs: number | null = null;
const pump = (timestampMs: number): void => {
  if (previousMs !== null) {
    store.advanceWallClock(timestampMs - previousMs);
  }
  previousMs = timestampMs;
  requestAnimationFrame(pump);
};
requestAnimationFrame(pump);
