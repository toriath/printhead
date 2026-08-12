import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'balance',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
