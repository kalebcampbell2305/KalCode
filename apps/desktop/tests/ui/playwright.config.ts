import { defineConfig, devices } from "@playwright/test";

/**
 * UI tests run the desktop frontend in a browser against the in-memory transport
 * (`vite --mode ui-test`). They verify behaviour, keyboard flows, accessibility and visuals.
 * The real-app end-to-end suite lives in tests/e2e.
 */
const port = Number(process.env.KALCODE_UI_TEST_PORT ?? 1421);

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    viewport: { width: 1360, height: 860 },
    // Animations off: stable screenshots and axe never samples mid-transition colors.
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 } } }],
  webServer: {
    command: "pnpm exec vite --mode ui-test",
    cwd: "../..",
    url: `http://127.0.0.1:${port}`,
    // Never reuse: another worktree's server on this port would test the wrong code.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
