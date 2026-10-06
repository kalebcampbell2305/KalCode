import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { lowerLocalPriority } from "../../tooling/local-priority.mjs";

// Local test runs (vitest sets VITEST) yield the CPU to the gate; the dev server keeps its priority.
if (process.env.VITEST) lowerLocalPriority();

/**
 * The app runs with Object.prototype frozen (`freezePrototype` in tauri.conf.json). xterm.js
 * assigns `toString` on a plain namespace object, which throws when the prototype's `toString` is
 * read-only (the "override mistake"). Define the property instead. Fails loudly if xterm.js
 * changes, so an upgrade can't silently reintroduce a blank window.
 */
function xtermFrozenPrototype(): Plugin {
  return {
    name: "kalcode:xterm-frozen-prototype",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]@xterm[\\/]xterm[\\/]lib[\\/]xterm\.mjs$/.test(id.split("?")[0] ?? id)) return null;
      const pattern = /([\w$]+)\.toString=([\w$]+)/g;
      const found = code.match(pattern)?.length ?? 0;
      if (found !== 1) this.error(`expected one toString assignment in xterm.mjs, found ${found}`);
      return {
        code: code.replace(pattern, 'Object.defineProperty($1,"toString",{value:$2,writable:!0,configurable:!0})'),
        map: null,
      };
    },
  };
}

/** UI-test builds freeze Object.prototype like the desktop app, so tests run under the same rules. */
function freezePrototypeInTests(enabled: boolean): Plugin {
  return {
    name: "kalcode:freeze-prototype-in-tests",
    transformIndexHtml: () =>
      enabled ? [{ tag: "script", children: "Object.freeze(Object.prototype);", injectTo: "head-prepend" }] : [],
  };
}

// The in-memory IPC transport is only compiled into the `ui-test` mode build used by
// Playwright UI tests. Production and dev builds always talk to the native runtime.
// Worktrees running tests in parallel pick distinct ports via KALCODE_UI_TEST_PORT.
const uiTestPort = Number(process.env.KALCODE_UI_TEST_PORT ?? 1421);

export default defineConfig(({ mode }) => ({
  plugins: [react(), xtermFrozenPrototype(), freezePrototypeInTests(mode === "ui-test")],
  // Pre-bundled dependencies skip plugin transforms; xterm.js must pass through the fix above.
  optimizeDeps: { exclude: ["@xterm/xterm"] },
  clearScreen: false,
  define: {
    __KALCODE_MEMORY_TRANSPORT__: JSON.stringify(mode === "ui-test"),
  },
  server: {
    port: mode === "ui-test" ? uiTestPort : 1420,
    strictPort: true,
    host: "127.0.0.1",
    // Generated Playwright reports may be written while another isolated suite is running.
    // Watching them reloads every ui-test page mid-action and resets in-memory navigation.
    watch: { ignored: ["**/src-tauri/**", "**/test-results*/**", "**/playwright-report*/**"] },
  },
  build: {
    target: "es2022",
    sourcemap: mode !== "production",
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tests/readiness/*.test.tsx"],
    // Stable-shell integration tests mount the whole app; the self-hosted gate shares its PC with
    // release builds, where 5 s per test isn't enough headroom. Real failures still fail.
    testTimeout: 15_000,
    css: { modules: { classNameStrategy: "non-scoped" } },
  },
}));
