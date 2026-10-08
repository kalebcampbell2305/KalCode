// Builds the binary the real-app E2E suite drives: release profile with the `e2e` test hooks and
// the same on-device speech engine as production, into target/e2e so it never replaces the
// shipping build.
// Also builds, into the same folder, the `kalcode-hook` helper provider panes run (it ships next
// to the KalCode executable) and the fake provider CLI the pane tests use (test support only;
// no AI service is contacted).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { guardHeavyWork } from "../../../tooling/disk-hygiene.mjs";
import { lowerLocalPriority } from "../../../tooling/local-priority.mjs";

lowerLocalPriority();
guardHeavyWork("E2E build");
const targetDir = fileURLToPath(new URL("../../../target/e2e", import.meta.url));
const env = { ...process.env, CARGO_TARGET_DIR: targetDir };
const shell = process.platform === "win32";
const helperInventory = JSON.parse(readFileSync(new URL("./e2e-helpers.json", import.meta.url), "utf8"));

const app = spawnSync("pnpm", ["tauri", "build", "--no-bundle", "--features", "e2e,kalvoice-whisper"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env,
  stdio: "inherit",
  shell,
  windowsHide: true,
});
if (app.status !== 0) process.exit(app.status ?? 1);

const helpers = spawnSync(
  "cargo",
  ["build", "--release", ...helperInventory.flatMap((helper) => ["-p", helper.package, "--bin", helper.bin])],
  { cwd: fileURLToPath(new URL("../../..", import.meta.url)), env, stdio: "inherit", shell, windowsHide: true },
);
if (helpers.status !== 0) process.exit(helpers.status ?? 1);

const platformFilename = process.platform === "win32" ? "windows" : "other";
const missingHelpers = helperInventory
  .map((helper) => helper.filename[platformFilename])
  .filter((filename) => !existsSync(new URL(`../../../target/e2e/release/${filename}`, import.meta.url)));
if (missingHelpers.length > 0) {
  console.error(`E2E helper build completed without required siblings: ${missingHelpers.join(", ")}`);
  process.exit(1);
}
