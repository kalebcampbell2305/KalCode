import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against the real, compiled KalCode desktop app. Each test launches the
 * release executable with an isolated data folder and drives its WebView2 over the Chrome
 * DevTools Protocol. Windows only (WebView2); build first with `pnpm tauri build --no-bundle`.
 */
export default defineConfig({
  testDir: ".",
  workers: 1,
  timeout: 120_000,
  retries: 0,
  forbidOnly: true,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { trace: "retain-on-failure" },
});
