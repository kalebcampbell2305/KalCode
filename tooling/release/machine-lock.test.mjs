import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runGates } from "./lifecycle/gate.mjs";
import { acquireMachineLock, MACHINE_LOCKED_GATES } from "./lifecycle/machine-lock.mjs";

const dir = mkdtempSync(join(tmpdir(), "kc-machine-lock-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
const windows = { skip: process.platform !== "win32" };
const settledWithin = (promise, ms) =>
  Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), ms))]);

test("the browser-driven desktop suites share one machine-wide lock", () => {
  assert.deepEqual(MACHINE_LOCKED_GATES, { "desktop-ui": "browser", "desktop-native-e2e": "browser" });
});

test("a second holder waits until the first releases", windows, async () => {
  const release = await acquireMachineLock(dir, "serial");
  const second = acquireMachineLock(dir, "serial", { timeoutMs: 60_000 });
  assert.equal(await settledWithin(second, 1_500), false, "the second waits while the first holds the lock");
  release();
  assert.equal(await settledWithin(second, 15_000), true, "the second gets the lock once it is released");
  (await second)();
});

test("waiting is bounded and says why", windows, async () => {
  const release = await acquireMachineLock(dir, "bounded");
  try {
    await assert.rejects(acquireMachineLock(dir, "bounded", { timeoutMs: 800 }), /still held by another gate/);
  } finally {
    release();
  }
});

test("a holder whose gate process dies releases the lock with it", windows, async () => {
  const lock = new URL("./lifecycle/machine-lock.mjs", import.meta.url).href;
  const gate = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { acquireMachineLock } = await import(${JSON.stringify(lock)});
       await acquireMachineLock(${JSON.stringify(dir)}, "crash");
       console.log("HELD");
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
  );
  await new Promise((resolve, reject) => {
    gate.stdout.setEncoding("utf8").on("data", (chunk) => chunk.includes("HELD") && resolve());
    gate.on("exit", (code) => reject(new Error(`gate exited early (${code})`)));
  });
  gate.kill();
  // Only the gate process dies; its orphaned holder sees stdin close and lets go.
  const release = await acquireMachineLock(dir, "crash", { timeoutMs: 15_000 });
  release();
});

test("runGates takes the lock around exactly the listed checks and releases it", async () => {
  const calls = [];
  const gate = (id) => ({
    id,
    run: [`"${process.execPath}" -e "0"`],
    env: {},
    unsetEnv: [],
    requires: [],
    builtin: null,
    state: "selected",
  });
  const outcome = await runGates([gate("desktop-ui"), gate("rust"), gate("desktop-native-e2e")], {
    repo: dir,
    jobs: 2,
    machineLock: {
      dir,
      acquire: async (lockDir, name) => {
        calls.push(`acquire ${name}`);
        assert.equal(lockDir, dir);
        return () => calls.push(`release ${name}`);
      },
    },
  });
  assert.equal(outcome.status, "PASS");
  assert.deepEqual(calls.filter((c) => c.startsWith("acquire")).sort(), ["acquire browser", "acquire browser"]);
  assert.equal(calls.filter((c) => c.startsWith("release")).length, 2, "every lock taken is released");

  const refused = await runGates([gate("desktop-ui")], {
    repo: dir,
    jobs: 1,
    machineLock: {
      dir,
      acquire: async () => {
        throw new Error("machine lock browser: still held by another gate after 3600 s");
      },
    },
  });
  assert.equal(refused.status, "FAIL");
  assert.match(refused.results[0].why, /still held by another gate/);

  const unlocked = await runGates([gate("desktop-ui")], { repo: dir, jobs: 1 });
  assert.equal(unlocked.status, "PASS", "without a lock directory nothing is locked");
});
