import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The in-memory IPC transport is only compiled into the `ui-test` mode build used by
// Playwright UI tests. Production and dev builds always talk to the native runtime.
// Worktrees running tests in parallel pick distinct ports via KALCODE_UI_TEST_PORT.
const uiTestPort = Number(process.env.KALCODE_UI_TEST_PORT ?? 1421);

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  clearScreen: false,
  define: {
    __KALCODE_MEMORY_TRANSPORT__: JSON.stringify(mode === "ui-test"),
  },
  server: {
    port: mode === "ui-test" ? uiTestPort : 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    sourcemap: mode !== "production",
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
}));
