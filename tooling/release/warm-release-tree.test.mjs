import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { WARM_WORKTREE, warmPlan } from "./warm-release-tree.mjs";

const repo = process.platform === "win32" ? "C:\\repo" : "/repo";
const sha = "a".repeat(40);

test("a first warm pass adds the persistent worktree at the commit, installs from the lockfile, then warms", () => {
  const { worktree, steps } = warmPlan({ repo, commit: sha, worktreeExists: false });
  assert.equal(worktree, join(repo, WARM_WORKTREE));
  assert.deepEqual(
    steps.map((s) => `${s.cmd === process.execPath ? "node" : s.cmd} ${s.args[0]}`),
    ["git fetch", "git worktree", "pnpm install", `node ${join(worktree, "tooling", "release", "warm-windows.mjs")}`],
  );
  assert.ok(steps[2].args.includes("--frozen-lockfile"));
});

test("a later pass checks the existing worktree out at the commit and requires it clean", () => {
  const { steps } = warmPlan({ repo, commit: sha, worktreeExists: true });
  assert.deepEqual(steps[1].args, ["checkout", "--quiet", "--detach", sha]);
  assert.equal(steps[1].requireClean, true);
});

test("refuses a relative repo or a non-commit", () => {
  assert.throws(() => warmPlan({ repo: "repo", commit: sha, worktreeExists: false }));
  assert.throws(() => warmPlan({ repo, commit: "main", worktreeExists: false }));
});

test("the warm compile mirrors the signed build's invocation and leaves no guardian behind", () => {
  const warm = readFileSync(new URL("./warm-windows.mjs", import.meta.url), "utf8");
  assert.match(warm, /"tauri", "build", "--bundles", "nsis", "--features", "kalvoice-whisper", "--no-sign"/);
  assert.match(warm, /releaseVersionOverlay\(releaseVersion\(\)\)/);
  assert.equal((warm.match(/clearStaleGuardian\(TARGET_DIR\)/g) ?? []).length, 2);
});
