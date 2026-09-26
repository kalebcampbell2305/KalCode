import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.KALCODE_UI_TEST_PORT ?? 15565);
export default defineConfig({
  testDir: ".",
  outputDir: "../../test-results/widgets",
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec vite --config tests/widgets/vite.config.ts --port ${port}`,
    cwd: "../..",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
