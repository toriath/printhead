import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'platform',
    // The lifecycle adapter listens to document visibility, so the facade's
    // web implementations are tested against a real DOM rather than a stub.
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
