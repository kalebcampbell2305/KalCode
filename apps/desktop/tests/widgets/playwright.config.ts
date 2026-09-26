import { defineConfig, devices } from "@playwright/test";

const port = 15565;
export default defineConfig({
  testDir: ".",
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec vite --config tests/widgets/vite.config.ts --port ${port}`,
    cwd: "../..",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
