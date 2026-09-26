import { defineConfig } from "vitest/config";

// Owner-scoped reproduction suite. Failures are release findings, not production repairs.
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["tests/readiness/*.test.tsx"],
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
});
