#!/usr/bin/env node
// Keeps the persistent Windows release worktree warm (owner directive 2026-10-02: fastest truthful path from main to
// users; long releases are pipeline bugs). Run by release.yml's `warm` job after every push to main, on the guarded
// release runner. It moves the persistent worktree to the pushed main commit, installs dependencies exactly from the
// lockfile, and runs the compile-only warm build, so the release build that follows (same worktree) is incremental.
//
//   node tooling/release/warm-release-tree.mjs --repo <owner repo> --commit <sha40> [--timings-root <dir>] [--dry-run]
//
// The worktree is <repo>/.worktrees/release-warm-windows. It refuses a dirty worktree (a release build may own it) and
// never touches any other worktree.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export const WARM_WORKTREE = join(".worktrees", "release-warm-windows");

/** The ordered commands for one warm pass (pure, for tests and --dry-run). */
export function warmPlan({ repo, commit, worktreeExists }) {
  if (!isAbsolute(repo ?? "")) throw new Error("--repo must be an absolute path");
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("--commit must be a 40-hex main commit");
  const worktree = join(repo, WARM_WORKTREE);
  const steps = [{ cwd: repo, cmd: "git", args: ["fetch", "--quiet", "origin", "main"] }];
  steps.push(
    worktreeExists
      ? { cwd: worktree, cmd: "git", args: ["checkout", "--quiet", "--detach", commit], requireClean: true }
      : { cwd: repo, cmd: "git", args: ["worktree", "add", "--detach", worktree, commit] },
  );
  steps.push({ cwd: worktree, cmd: "pnpm", args: ["install", "--frozen-lockfile"] });
  steps.push({
    cwd: worktree,
    cmd: process.execPath,
    args: [join(worktree, "tooling", "release", "warm-windows.mjs")],
  });
  return { worktree, steps };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function sh(step) {
  const result = spawnSync(step.cmd, step.args, {
    cwd: step.cwd,
    stdio: "inherit",
    shell: step.cmd === "pnpm",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`${step.cmd} ${step.args.join(" ")} exited ${result.status}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  try {
    const repo = option(args, "--repo");
    const commit = option(args, "--commit");
    const timingsRoot = option(args, "--timings-root");
    const plan = warmPlan({ repo, commit, worktreeExists: existsSync(join(repo ?? "", WARM_WORKTREE, ".git")) });
    if (args.includes("--dry-run")) {
      console.log(JSON.stringify(plan, null, 2));
      process.exit(0);
    }
    const started = new Date().toISOString();
    for (const step of plan.steps) {
      if (step.requireClean) {
        const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
          cwd: step.cwd,
          encoding: "utf8",
          windowsHide: true,
        });
        if (status.status !== 0 || status.stdout.trim())
          throw new Error(`refused: ${step.cwd} is not clean (a release build may own it)`);
      }
      sh(step);
    }
    if (timingsRoot) {
      // Warm passes are recorded per main commit (a release's own timings are per version, release-timings.mjs).
      mkdirSync(join(timingsRoot, "warm"), { recursive: true });
      writeFileSync(
        join(timingsRoot, "warm", `${commit}.json`),
        `${JSON.stringify({ commit, started, finished: new Date().toISOString() })}\n`,
      );
    }
    console.log(`warm release tree at ${commit.slice(0, 12)}: ${plan.worktree}`);
  } catch (error) {
    console.error(`warm-release-tree: ${error.message}`);
    process.exit(1);
  }
}
