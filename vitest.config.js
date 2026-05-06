import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    setupFiles: ["./tests/setup.js"],
    include: ["tests/**/*.test.js"],
  },
});
