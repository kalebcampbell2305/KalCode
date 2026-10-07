import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import "./runners/windows/gate-worker-probe.test.mjs";

// Include the platform module in the normal tooling gate; never installs services or changes accounts.
if (process.platform === "win32") {
  test("GitHub Node hook shape starts PowerShell with process-only policy and preserves exit codes", () => {
    const root = mkdtempSync(join(tmpdir(), "kalcode-js-hook-"));
    try {
      writeFileSync(
        join(root, "gate-worker-hook.ps1"),
        "param([string]$Phase)\nWrite-Output ($Phase + '|' + (Get-ExecutionPolicy -Scope Process))\nif ($Phase -eq 'After') { exit 17 }\nexit 0\n",
      );
      for (const [name, phase, code] of [
        ["before", "Before", 0],
        ["after", "After", 17],
      ]) {
        const hook = join(root, `${name}.js`);
        copyFileSync(new URL("./runners/windows/gate-worker-job-hook.js", import.meta.url), hook);
        const result = spawnSync(process.execPath, [hook], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10_000,
        });
        assert.equal(result.status, code, result.stderr || result.error?.message);
        assert.equal(result.stdout.trim(), `${phase}|Bypass`);
      }
    } finally {
      assert.equal(dirname(resolve(root)), resolve(tmpdir()));
      assert.ok(basename(root).startsWith("kalcode-js-hook-"));
      rmSync(root, { recursive: true, force: true });
    }
  });
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
  test("Gate leases: own-slot previous job replaced, other slots kept, pre-boot stale, After removes only its own", () => {
    // Temp lease directory and injected process lookups only; the real pool and processes are untouched.
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        fileURLToPath(new URL("./runners/windows/test-gate-worker-leases.ps1", import.meta.url)),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    assert.match(result.stdout, /PASS: gate leases/);
  });
}
