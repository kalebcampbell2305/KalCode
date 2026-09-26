import { defineConfig } from "vitest/config";

// Explicit component regression gate; the default desktop suite only includes src tests.
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["tests/readiness/terminal-replay-fencing.test.tsx"],
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
});
