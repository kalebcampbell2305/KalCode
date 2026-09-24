import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against the production build served by `wrangler dev` — the real Worker, static
 * assets binding, local D1 (migrated) and the local rate limiter — on its own port and with its
 * own persisted state, so it never touches a developer's running preview.
 */
const PORT = 8788;
export const E2E_PERSIST_DIR = ".wrangler/e2e-state";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: [
      "pnpm build",
      `pnpm exec wrangler d1 migrations apply kalcode-web --local --persist-to ${E2E_PERSIST_DIR}`,
      `pnpm exec wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to ${E2E_PERSIST_DIR} --show-interactive-dev-session=false`,
    ].join(" && "),
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
