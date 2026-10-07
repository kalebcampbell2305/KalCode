import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const lockScript = fileURLToPath(new URL("../.github/scripts/pc2-machine-lock.ps1", import.meta.url));
const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
const windows = { skip: process.platform !== "win32" };
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function lockRoot() {
  const root = mkdtempSync(join(tmpdir(), "kc-pc2-lock-"));
  roots.push(root);
  return root;
}

/** A process that takes the lock, reports it, and holds it until `release-<name>` appears. */
function holder(dir, name, mode, { timeoutMinutes = 1 } = {}) {
  const release = join(dir, `release-${name}`);
  const script = `$ErrorActionPreference = 'Stop'
. '${lockScript.replaceAll("'", "''")}'
$lock = Enter-Pc2MachineLock -Mode ${mode} -Directory '${dir.replaceAll("'", "''")}' -TimeoutMinutes ${timeoutMinutes} -PollMilliseconds 100
[Console]::Out.WriteLine("ACQUIRED ${name}"); [Console]::Out.Flush()
while (-not (Test-Path -LiteralPath '${release.replaceAll("'", "''")}')) { Start-Sleep -Milliseconds 50 }
Exit-Pc2MachineLock $lock`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    err += chunk;
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    acquired: async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (out.includes(`ACQUIRED ${name}`)) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return out.includes(`ACQUIRED ${name}`);
    },
    release: () => writeFileSync(release, ""),
    kill: () => child.kill(),
    exited,
    output: () => out + err,
  };
}

test("the second PC's gate halves and update proof take the machine lock", () => {
  const gate = workflow("gate.yml");
  const pc2 = gate.split("\n  pc2:")[1].split("\n  macos:")[0];
  assert.match(
    pc2,
    /\. \.github\/scripts\/pc2-machine-lock\.ps1\n\s+\$lock = Enter-Pc2MachineLock -Mode Shared -TimeoutMinutes 60/,
  );
  assert.match(pc2, /finally \{\n\s+Exit-Pc2MachineLock \$lock/);
  const qa = workflow("desktop-update-verify.yml");
  assert.match(qa, /\$lock = Enter-Pc2MachineLock -Mode Exclusive -TimeoutMinutes 75/);
  assert.match(qa, /timeout-minutes: 120/);
  assert.match(qa, /sparse-checkout: \.github\/scripts/, "the proof's checkout includes the lock script");
});

test(
  "both gate runners share the lock; the update proof waits for them and then excludes new gate halves",
  windows,
  async () => {
    const dir = lockRoot();
    const a = holder(dir, "gate-a", "Shared");
    const b = holder(dir, "gate-b", "Shared");
    assert.equal(await a.acquired(15_000), true, a.output());
    assert.equal(await b.acquired(15_000), true, "two gate halves hold it at once");

    const proof = holder(dir, "proof", "Exclusive");
    assert.equal(await proof.acquired(1_500), false, "the proof waits for in-flight gate halves");
    // The proof has priority: once it waits, a new gate half queues behind it.
    const late = holder(dir, "gate-late", "Shared");
    a.release();
    b.release();
    assert.equal(await proof.acquired(15_000), true, `the proof runs once the gate halves end: ${proof.output()}`);
    assert.equal(await late.acquired(1_500), false, "no gate half starts while the proof runs");
    proof.release();
    assert.equal(await late.acquired(15_000), true, "the waiting gate half starts once the proof ends");
    late.release();
    for (const h of [a, b, proof, late]) assert.equal(await h.exited, 0, h.output());
  },
);

test("a holder that dies releases the lock with it", windows, async () => {
  const dir = lockRoot();
  const doomed = holder(dir, "doomed", "Exclusive");
  assert.equal(await doomed.acquired(15_000), true, doomed.output());
  doomed.kill(); // a cancelled or killed job: no finally, no release file
  await doomed.exited;
  const next = holder(dir, "next", "Shared");
  assert.equal(await next.acquired(15_000), true, `a killed holder leaves no stale lock: ${next.output()}`);
  next.release();
  await next.exited;
});

test("waiting is bounded and says what holds the lock", windows, async () => {
  const dir = lockRoot();
  const gateHalf = holder(dir, "busy", "Shared");
  assert.equal(await gateHalf.acquired(15_000), true, gateHalf.output());
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `. '${lockScript}'; try { Enter-Pc2MachineLock -Mode Exclusive -Directory '${dir}' -TimeoutMinutes 0 -PollMilliseconds 50 | Out-Null; 'acquired' } catch { $_.Exception.Message }`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.match(result.stdout, /still held by gate halves after 0 minutes/);
  // The timed-out proof released its priority claim, so a new gate half is not stuck behind it.
  const after = holder(dir, "after", "Shared");
  assert.equal(await after.acquired(15_000), true, after.output());
  gateHalf.release();
  after.release();
  await Promise.all([gateHalf.exited, after.exited]);
});

test("a PC without the lock folder warns and runs unlocked, as before", windows, () => {
  const missing = join(lockRoot(), "not-created");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `. '${lockScript}'; $l = Enter-Pc2MachineLock -Mode Shared -Directory '${missing}'; if ($null -eq $l) { 'unlocked' }`,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /::warning::The second PC's machine lock folder .* is missing; running without the lock\./,
  );
  assert.match(result.stdout, /unlocked/);
  assert.equal(existsSync(missing), false, "it never creates the folder (that needs the elevated setup)");
});
