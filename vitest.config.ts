import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // DBを共有するため直列実行する
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
