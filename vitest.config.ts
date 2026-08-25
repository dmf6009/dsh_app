import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration suites spawn real stub processes; give them headroom.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Protocol/process tests touch real stdio; run files sequentially to keep
    // process accounting assertions deterministic.
    fileParallelism: false
  }
});
