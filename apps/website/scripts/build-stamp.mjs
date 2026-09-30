/**
 * Build stamp: `astro build` writes dist/.well-known/kalcode-build.json, so production can say which commit
 * it serves (`node tooling/release/ship.mjs lifecycle status` reads https://kalcoded.com/.well-known/kalcode-build.json).
 *
 * The stamp holds only public facts: the source commit, whether the working tree had uncommitted tracked
 * changes, and the build time. It never fails the build: without git the commit is null.
 * KALCODE_BUILD_COMMIT (40 hex) overrides git, for builds from an exported tree.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const STAMP_PATH = ".well-known/kalcode-build.json";
const HEX40 = /^[0-9a-f]{40}$/;

/** @param {string} cwd @param {string[]} args @returns {string | null} */
function gitOut(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return r.status === 0 && !r.error ? r.stdout.trim() : null;
}

/**
 * @param {{ cwd: string, env?: Record<string, string | undefined>, now?: () => number,
 *           git?: (cwd: string, args: string[]) => string | null }} options
 */
export function buildStampData({ cwd, env = process.env, now = Date.now, git = gitOut }) {
  const override = env.KALCODE_BUILD_COMMIT?.trim().toLowerCase();
  let commit = null;
  let dirty = false;
  if (override && HEX40.test(override)) {
    commit = override;
  } else {
    const head = git(cwd, ["rev-parse", "HEAD"]);
    commit = head && HEX40.test(head) ? head : null;
    dirty = commit !== null && (git(cwd, ["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "";
  }
  return {
    schema: "kalcode-build/v1",
    app: "website",
    commit,
    dirty,
    builtAt: new Date(now()).toISOString(),
  };
}

/** Astro integration: writes the stamp into the build output. @returns {import("astro").AstroIntegration} */
export function kalcodeBuildStamp() {
  let root = process.cwd();
  return {
    name: "kalcode-build-stamp",
    hooks: {
      "astro:config:done": ({ config }) => {
        root = fileURLToPath(config.root);
      },
      "astro:build:done": ({ dir }) => {
        const file = join(fileURLToPath(dir), STAMP_PATH);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `${JSON.stringify(buildStampData({ cwd: root }), null, 2)}\n`);
      },
    },
  };
}
