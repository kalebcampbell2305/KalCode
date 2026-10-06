import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { test } from "node:test";
import { localPriority, lowerLocalPriority } from "./local-priority.mjs";

const { PRIORITY_BELOW_NORMAL, PRIORITY_LOW, PRIORITY_NORMAL } = constants.priority;

test("local heavy work defaults to below-normal, with idle and an opt-out", () => {
  assert.equal(localPriority({}), PRIORITY_BELOW_NORMAL);
  assert.equal(localPriority({ KALCODE_LOCAL_PRIORITY: "below-normal" }), PRIORITY_BELOW_NORMAL);
  assert.equal(localPriority({ KALCODE_LOCAL_PRIORITY: " Idle " }), PRIORITY_LOW);
  assert.equal(localPriority({ KALCODE_LOCAL_PRIORITY: "normal" }), null);
  assert.throws(() => localPriority({ KALCODE_LOCAL_PRIORITY: "high" }), /below-normal, idle or normal/);
});

test("CI keeps the priority its gate chose", () => {
  assert.equal(localPriority({ CI: "true" }), null);
  assert.equal(localPriority({ GITHUB_ACTIONS: "true" }), null);
  assert.equal(localPriority({ GITHUB_ACTIONS: "true", KALCODE_LOCAL_PRIORITY: "idle" }), null);
});

test("lowering only ever lowers this process and never fails the build", () => {
  const calls = [];
  assert.equal(lowerLocalPriority({ env: {}, set: (pid, level) => calls.push([pid, level]) }), PRIORITY_BELOW_NORMAL);
  assert.deepEqual(calls, [[0, PRIORITY_BELOW_NORMAL]], "pid 0 is this process");
  assert.equal(lowerLocalPriority({ env: { KALCODE_LOCAL_PRIORITY: "normal" }, set: () => assert.fail() }), null);
  assert.equal(
    lowerLocalPriority({
      env: {},
      set: () => {
        throw new Error("EACCES");
      },
    }),
    null,
  );
});

test("a lowered process and the processes it starts really run below normal", () => {
  const child = `
    const { getPriority } = require("node:os");
    const { spawnSync } = require("node:child_process");
    import(${JSON.stringify(new URL("./local-priority.mjs", import.meta.url).href)}).then(({ lowerLocalPriority }) => {
      lowerLocalPriority();
      const grandchild = spawnSync(process.execPath, ["-p", "require('node:os').getPriority()"], { encoding: "utf8" });
      console.log(JSON.stringify({ self: getPriority(), child: Number(grandchild.stdout.trim()) }));
    });`;
  const env = { ...process.env };
  delete env.CI;
  delete env.GITHUB_ACTIONS;
  delete env.KALCODE_LOCAL_PRIORITY;
  const result = spawnSync(process.execPath, ["-e", child], { encoding: "utf8", env, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const { self, child: inherited } = JSON.parse(result.stdout.trim());
  assert.ok(self > PRIORITY_NORMAL, `the process lowered itself (niceness ${self})`);
  assert.ok(inherited > PRIORITY_NORMAL, `a process it starts inherits the lower priority (niceness ${inherited})`);
});
