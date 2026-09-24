// Builds the binary the real-app E2E suite drives: release profile with the `e2e` feature
// (test hooks enabled), into target/e2e so it never replaces the shipping build.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const targetDir = fileURLToPath(new URL("../../../target/e2e", import.meta.url));
const result = spawnSync("pnpm", ["tauri", "build", "--no-bundle", "--features", "e2e"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
