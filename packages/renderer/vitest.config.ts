import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'renderer',
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
  },
});
