// Machine-wide locks for checks that must never overlap on one PC, even across gate jobs.
//
// The build PC's share of a gate runs as two jobs on two pool workers (gate.yml's main/native matrix).
// Both browser-driven desktop suites, desktop-ui (Playwright against the frontend) and
// desktop-native-e2e (the real app's WebView2), are sensitive to a saturated machine: run together,
// a debounced ConPTY resize missed a fixed wait (gate 37413248990). A check named here takes the lock
// for its whole run, so one waits for the other while the jobs' other checks (rust, the frontend unit
// suite) still run in parallel.
//
// The lock is an exclusive Windows file handle held by a small PowerShell process: whatever ends that
// process (release, the gate finishing, a crash, a killed job) releases it, so there is never a stale
// lock to clean up. The directory is the pool's shared heavy-token folder, which every gate worker
// account can write (tooling/runners/windows/install-gate-pool-hooks.ps1).
import { spawn } from "node:child_process";
import { join } from "node:path";

export const MACHINE_LOCKED_GATES = Object.freeze({
  "desktop-ui": "browser",
  "desktop-native-e2e": "browser",
});

const HOLDER = `
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddMilliseconds([double]$env:KALCODE_LOCK_TIMEOUT_MS)
while ($true) {
  try { $handle = [IO.File]::Open($env:KALCODE_LOCK_PATH, 'OpenOrCreate', 'ReadWrite', 'None'); break }
  catch [IO.IOException] {
    if ([DateTime]::UtcNow -ge $deadline) { [Console]::Out.WriteLine('TIMEOUT'); exit 3 }
    Start-Sleep -Milliseconds 250
  }
}
[Console]::Out.WriteLine('ACQUIRED'); [Console]::Out.Flush()
[void][Console]::In.ReadToEnd()
$handle.Dispose()
`;

/**
 * Waits for the named machine-wide lock in `dir` and resolves to its release function. Rejects after
 * `timeoutMs`. Windows only (the gate pool); elsewhere it is a no-op.
 */
export function acquireMachineLock(dir, name, { timeoutMs = 60 * 60_000, platform = process.platform } = {}) {
  if (platform !== "win32") return Promise.resolve(() => {});
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return Promise.reject(new Error(`invalid machine lock name: ${name}`));
  return new Promise((resolve, reject) => {
    const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", HOLDER], {
      env: { ...process.env, KALCODE_LOCK_PATH: join(dir, `${name}.lock`), KALCODE_LOCK_TIMEOUT_MS: String(timeoutMs) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    let settled = false;
    const release = () => {
      holder.stdin.on("error", () => {});
      holder.stdin.end();
    };
    holder.stdin.on("error", () => {});
    holder.stdout.setEncoding("utf8").on("data", (chunk) => {
      out += chunk;
      if (!settled && out.includes("ACQUIRED")) {
        settled = true;
        resolve(release);
      }
    });
    holder.stderr.setEncoding("utf8").on("data", (chunk) => {
      err += chunk;
    });
    holder.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(new Error(`machine lock ${name}: ${error.message}`));
      }
    });
    holder.on("close", (code) => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          out.includes("TIMEOUT")
            ? `machine lock ${name}: still held by another gate after ${Math.round(timeoutMs / 1000)} s`
            : `machine lock ${name}: holder exited ${code}${err.trim() ? ` (${err.trim().split("\n")[0]})` : ""}`,
        ),
      );
    });
  });
}
