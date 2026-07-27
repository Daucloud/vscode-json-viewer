import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/unit/**/*.test.tsx', 'test/integration/**/*.test.ts'],
    coverage: { reporter: ['text', 'json-summary'] },
    testTimeout: 20_000,
  },
});
