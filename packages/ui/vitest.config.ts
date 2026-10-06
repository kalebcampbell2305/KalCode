import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { lowerLocalPriority } from "../../tooling/local-priority.mjs";

// Local runs yield the CPU to the gate (tooling/local-priority.mjs); CI is unchanged.
lowerLocalPriority();

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: { modules: { classNameStrategy: "non-scoped" } },
    // jsdom + axe renders can exceed vitest's 5 s default on a slower gate machine (the second-PC gate
    // timed out DesignSystem/DiffView/DropdownMenu at 5 s); a real hang still fails.
    testTimeout: 30_000,
  },
});
