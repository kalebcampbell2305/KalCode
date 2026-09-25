import { defineConfig, devices } from "@playwright/test";

/**
 * Component test for DiffView in a real browser: axe (WCAG 2.2 AA, both themes, both layouts,
 * including contrast), keyboard navigation and virtualization. Runs a standalone Vite harness;
 * no desktop shell file is involved. Port: KALCODE_UI_TEST_PORT (Z6a uses 1443).
 */
const port = Number(process.env.KALCODE_UI_TEST_PORT ?? 1443);

export default defineConfig({
  testDir: ".",
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1200, height: 800 } } }],
  webServer: {
    command: `pnpm exec vite --config tests/diffview/vite.config.ts --port ${port}`,
    cwd: "../..",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
