import { defineConfig, devices } from "@playwright/test";

/**
 * UI tests run the desktop frontend in a browser against the in-memory transport
 * (`vite --mode ui-test`). They verify behaviour, keyboard flows, accessibility and visuals.
 * The real-app end-to-end suite lives in tests/e2e.
 */
const port = Number(process.env.KALCODE_UI_TEST_PORT ?? 1421);
const gateWorkers = process.env.KALCODE_UI_TEST_WORKERS;
if (gateWorkers !== undefined && !/^[1-4]$/.test(gateWorkers)) {
  throw new Error("KALCODE_UI_TEST_WORKERS must be between 1 and 4");
}

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  ...(gateWorkers === undefined ? {} : { workers: Number(gateWorkers) }),
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The self-hosted gate runs this suite fully parallel on a slower machine, where a full-page
  // axe scan takes 15-30 s and some UI waits exceed 5 s. Give CI a realistic budget instead of
  // failing on time (the gate also fails on flaky retries). No assertion changes.
  ...(process.env.CI ? { timeout: 60_000, expect: { timeout: 10_000 } } : {}),
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
