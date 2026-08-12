import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'editor',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
