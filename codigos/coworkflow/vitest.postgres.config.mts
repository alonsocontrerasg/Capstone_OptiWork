import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["tests/rls/postgres.test.mjs"], environment: "node", fileParallelism: false,
  hookTimeout: 60000, testTimeout: 15000,
} });
