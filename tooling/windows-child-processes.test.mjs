import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TOOLING = dirname(fileURLToPath(import.meta.url));

function source(file) {
  return readFileSync(join(TOOLING, file), "utf8");
}

function launchContaining(file, marker) {
  const contents = source(file);
  const markerAt = contents.indexOf(marker);
  assert.notEqual(markerAt, -1, `${file}: missing audited launch marker ${marker}`);
  const embeddedSpawn = contents.indexOf("spawn", markerAt);
  const spawnAt =
    embeddedSpawn >= markerAt && embeddedSpawn < markerAt + marker.length
      ? embeddedSpawn
      : Math.max(contents.lastIndexOf("spawn(", markerAt), contents.lastIndexOf("spawnSync(", markerAt));
  assert.notEqual(spawnAt, -1, `${file}: ${marker} is no longer owned by a child-process launch`);
  const end = contents.indexOf(");", markerAt);
  assert.notEqual(end, -1, `${file}: could not bound ${marker}`);
  return contents.slice(spawnAt, end + 2);
}

const AUDITED_LAUNCHES = [
  ["release/lifecycle.test.mjs", '["-C", ROOT, "ls-files", "-z"]'],
  ["release/lifecycle.test.mjs", '[SHIP, ...args, "--repo", f.repo]'],
  ["release/lifecycle.test.mjs", '[SHIP, "lifecycle", "status", ...args, "--repo", f.repo]'],
  ["release/lifecycle.test.mjs", 'const r = spawnSync(process.execPath, [SHIP, "lifecycle", "hook"]'],
  ["release/lifecycle.test.mjs", 'const active = spawnSync(process.execPath, [SHIP, "lifecycle", "hook"]'],
  ["release/lifecycle.test.mjs", '["-C", ROOT, "check-ignore", "-q", p]'],
  ["release/lifecycle.test.mjs", 'const c = spawn(process.execPath, ["-e"'],
  ["release/lifecycle.test.mjs", '[SHIP, "gate", "--list", "--repo", f.repo]'],
  ["release/lifecycle.test.mjs", '[SHIP, "gate", "--only", "nope", "--repo", f.repo]'],
  ["release/release-on-merge.mjs", "spawnSync(command, args"],
  ["release/release-on-merge.mjs", "spawn(process.execPath, args"],
  ["release/release-on-merge.mjs", 'spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]'],
  ["release/warm-release-tree.mjs", "spawnSync(step.cmd, step.args"],
  ["release/warm-release-tree.mjs", 'spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"]'],
  ["check-capabilities.test.mjs", 'spawnSync(process.execPath, [join(root, "tooling/check-capabilities.mjs")]'],
  ["release/ship.test.mjs", '["kit/build.mjs", fx3.commit'],
];

test("audited Windows tooling launches hide their child console", () => {
  for (const [file, marker] of AUDITED_LAUNCHES) {
    const launch = launchContaining(file, marker);
    assert.match(launch, /windowsHide\s*:\s*true/, `${file}: ${marker} must set windowsHide: true`);
    assert.doesNotMatch(launch, /windowsHide\s*:\s*false/, `${file}: ${marker} must not override the hidden flag`);
  }
});

test("release-on-merge callers cannot override the hidden console policy", () => {
  const launch = launchContaining("release/release-on-merge.mjs", "spawnSync(command, args");
  assert.ok(
    launch.lastIndexOf("windowsHide: true") > launch.lastIndexOf("...options"),
    "the fixed hidden-console policy must be applied after caller options",
  );
});
