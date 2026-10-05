import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import "./runners/windows/gate-worker-probe.test.mjs";

// Include the platform module in the normal tooling gate; never installs services or changes accounts.
if (process.platform === "win32") {
  test("Windows worker plans, isolated ports and resource admission", () => {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(new URL("./runners/windows/test-gate-worker-pool.ps1", import.meta.url)),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /PASS: worker plans/);
  });
}
