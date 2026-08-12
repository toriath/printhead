import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'editor',
    // The panel is React, so its tests need a DOM; the descriptor layer is
    // pure and does not care either way.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
