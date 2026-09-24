import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Integration tests start workerd and run wrangler; give them room on slow CI runners.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
