// Builds the binary the real-app E2E suite drives: release profile with the `e2e` feature
// (test hooks enabled), into target/e2e so it never replaces the shipping build.
// Also builds, into the same folder, the `kalcode-hook` helper provider panes run (it ships next
// to the KalCode executable) and the fake provider CLI the pane tests use (test support only;
// no AI service is contacted).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const targetDir = fileURLToPath(new URL("../../../target/e2e", import.meta.url));
const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
const shell = process.platform === "win32";

const app = spawnSync("pnpm", ["tauri", "build", "--no-bundle", "--features", "e2e"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env,
  stdio: "inherit",
  shell,
});
if (app.status !== 0) process.exit(app.status ?? 1);

const helpers = spawnSync(
  "cargo",
  [
    "build",
    "--release",
    "-p",
    "kalcode-hook-bridge",
    "--bin",
    "kalcode-hook",
    "-p",
    "kalcode-providers",
    "--bin",
    "kalcode-fake-provider",
  ],
  { cwd: fileURLToPath(new URL("../../..", import.meta.url)), env, stdio: "inherit", shell },
);
process.exit(helpers.status ?? 1);
