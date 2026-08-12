import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'stl',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
