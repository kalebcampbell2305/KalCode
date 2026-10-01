import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  compareReleaseVersions,
  interpretShip,
  RELEASE_TIMEOUT_MS,
  releaseIdentity,
  shipLockState,
  shipRunArgs,
  shipStateDir,
  statusDescription,
} from "./release-on-merge.mjs";

const HEAD = "a".repeat(40);
const temps = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "kalcode-release-on-merge-"));
  temps.push(dir);
  return dir;
};
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("release on merge", () => {
  test("status descriptions fit GitHub's 140-character limit", () => {
    assert.equal(statusDescription("a\n  b"), "a b");
    const long = statusDescription("x".repeat(500));
    assert.equal(long.length, 140);
    assert.ok(long.endsWith("…"));
  });

  test("release versions order internal builds after the public version", () => {
    assert.equal(compareReleaseVersions("0.1.7", "0.1.7+1"), -1);
    assert.equal(compareReleaseVersions("0.1.8+12", "0.1.8+9"), 1);
    assert.equal(compareReleaseVersions("0.1.8", "0.1.7+900"), 1);
    assert.equal(compareReleaseVersions("0.1.7", "0.1.7"), 0);
    assert.equal(compareReleaseVersions("0.1.7-rc.1", "0.1.7"), null);
  });

  test("the published Stable version is the baseline only when it is lower", () => {
    assert.deepEqual(releaseIdentity({ commit: HEAD, version: "0.1.8+900", publishedVersion: "0.1.7" }), {
      commit: HEAD,
      version: "0.1.8+900",
      baselineVersion: "0.1.7",
    });
    assert.equal(releaseIdentity({ commit: HEAD, version: "0.1.7", publishedVersion: "0.1.7" }).baselineVersion, null);
    assert.equal(releaseIdentity({ commit: HEAD, version: "0.1.7", publishedVersion: null }).baselineVersion, null);
    assert.throws(() => releaseIdentity({ commit: HEAD, version: "garbage", publishedVersion: null }), /bad version/);
    assert.throws(() => releaseIdentity({ commit: "abc", version: "0.1.7", publishedVersion: null }), /bad commit/);
  });

  test("the only release command runs the automated phases with persistent state, never approve or attest", () => {
    const identity = { commit: HEAD, version: "0.1.8+900", baselineVersion: "0.1.7" };
    const state = shipStateDir("C:/state", identity);
    assert.equal(state, join("C:/state", `0.1.8+900-${HEAD.slice(0, 12)}`));
    const args = shipRunArgs(identity, state);
    assert.deepEqual(args, [
      "tooling/release/ship.mjs",
      "run",
      "--version",
      "0.1.8+900",
      "--commit",
      HEAD,
      "--baseline-version",
      "0.1.7",
      "--phase",
      "all",
      "--execute",
      "--state",
      state,
    ]);
    assert.ok(!args.includes("approve") && !args.includes("attest") && !args.includes("--adopt"));
    assert.ok(
      !shipRunArgs({ commit: HEAD, version: "0.1.7", baselineVersion: null }, state).includes("--baseline-version"),
    );
  });

  test("ship.mjs exits map to commit statuses", () => {
    assert.deepEqual(interpretShip(0, "[DONE] live-verify"), {
      state: "success",
      description: "all release phases complete",
    });
    const approval = interpretShip(2, "[DONE] bundle-mac\n[AWAITING-APPROVAL] package-mac: uses the Developer ID\n");
    assert.equal(approval.state, "pending");
    assert.equal(approval.stoppedAt, "package-mac");
    assert.match(approval.description, /waiting for approval: package-mac/);
    assert.match(interpretShip(2, "[AWAITING-OPERATOR] qa-sittings: person").description, /a person: qa-sittings/);
    const stop = interpretShip(2, "[STOP] stage writes to production and runs only when named explicitly");
    assert.equal(stop.stoppedAt, "stage");
    assert.match(stop.description, /named production write: stage/);
    const failed = interpretShip(1, "[RUN] build-windows\n[FAILED] build-windows: exit 3\n  failure record: x");
    assert.equal(failed.state, "failure");
    assert.equal(failed.stoppedAt, "build-windows");
    assert.match(interpretShip(1, "REFUSED: no kit in kits binds version 0.1.8+900").description, /no kit/);
    const busy = interpretShip(1, "REFUSED: another ship.mjs run holds C:/x/lock (pid 4)");
    assert.equal(busy.state, "pending");
    assert.equal(busy.busy, true);
    assert.match(interpretShip(124, "", { timedOut: true }).description, /killed/);
  });

  test("ship.mjs lock: none, held by a live run, or stale after a killed run or PID reuse", () => {
    const lock = join(temp(), "lock");
    const at = "2026-10-01T00:00:00.000Z";
    const now = () => Date.parse(at) + 60_000;
    assert.equal(shipLockState(lock), "none");
    writeFileSync(lock, `ship.mjs 0.1.8 pid=4242 at=${at}\n`);
    assert.equal(shipLockState(lock, { alive: () => true, now }), "held");
    assert.equal(shipLockState(lock, { alive: () => false, now }), "stale");
    assert.equal(
      shipLockState(lock, { alive: () => true, now: () => Date.parse(at) + RELEASE_TIMEOUT_MS + 11 * 60_000 }),
      "stale",
    );
  });
});
