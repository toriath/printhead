import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'platform',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
