import { defineConfig, devices } from "@playwright/test";

/**
 * E2E runs against the production build served by `wrangler dev` — the real Worker, static
 * assets binding, local D1 (migrated) and the local rate limiter — on its own port and with its
 * own persisted state, so it never touches a developer's running preview.
 *
 * Several people (or agents) can run it side by side in one checkout by giving each run its own
 * port, state folder and build folder:
 *   KALCODE_E2E_PORT=4423 KALCODE_E2E_PERSIST=.wrangler/e2e-pages KALCODE_E2E_OUT_DIR=.wrangler/e2e-dist pnpm test:e2e
 */
const PORT = Number(process.env.KALCODE_E2E_PORT ?? 8788);
export const E2E_PERSIST_DIR = process.env.KALCODE_E2E_PERSIST ?? ".wrangler/e2e-state";
const OUT_DIR = process.env.KALCODE_E2E_OUT_DIR;
const INSPECTOR_PORT = process.env.KALCODE_E2E_INSPECTOR_PORT;
/** Set to 1 to serve an existing build in OUT_DIR (or dist) instead of building first. */
const SKIP_BUILD = process.env.KALCODE_E2E_SKIP_BUILD === "1";

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
      SKIP_BUILD ? "" : OUT_DIR ? `pnpm exec astro build --outDir ${OUT_DIR}` : "pnpm build",
      `pnpm exec wrangler d1 migrations apply kalcode-web --local --persist-to ${E2E_PERSIST_DIR}`,
      [
        `pnpm exec wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to ${E2E_PERSIST_DIR}`,
        OUT_DIR ? `--assets ${OUT_DIR}` : "",
        INSPECTOR_PORT ? `--inspector-port ${INSPECTOR_PORT}` : "",
        "--show-interactive-dev-session=false",
      ]
        .filter(Boolean)
        .join(" "),
    ]
      .filter(Boolean)
      .join(" && "),
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
