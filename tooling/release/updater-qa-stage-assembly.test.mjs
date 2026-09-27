import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { validateBaselineSourceAuthority } from "./updater-qa-stage-assembly.mjs";

function fixture(t, mutateBaseline = () => {}) {
  const source = mkdtempSync(join(tmpdir(), "kalcode-baseline-authority-"));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (path, value) => {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), value);
  };
  const versionFiles = (version, endpoint) => {
    write(
      "Cargo.toml",
      `[package]\nname = "kalcode-desktop"\nversion.workspace = true\nedition = "2021"\n[workspace]\nmembers = []\n[workspace.package]\nversion = "${version}"\n`,
    );
    write("Cargo.lock", `version = 4\n\n[[package]]\nname = "kalcode-desktop"\nversion = "${version}"\n`);
    write("apps/desktop/package.json", `${JSON.stringify({ name: "@kalcode/desktop", version })}\n`);
    write("apps/desktop/src-tauri/tauri.conf.json", `${JSON.stringify({ version })}\n`);
    write("crates/updater/src/lib.rs", `Self::Stable => "https://kalcoded.com/releases/updater/${endpoint}"\n`);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-b", "candidate");
  git("config", "user.name", "KalCode test");
  git("config", "user.email", "test@example.invalid");
  git("config", "core.autocrlf", "false");
  versionFiles("1.2.3", "stable.json");
  write("src/lib.rs", "pub fn unchanged() {}\n");
  const base = commit();
  git("checkout", "-b", "baseline");
  versionFiles("1.2.2", "stable/1.2.3.json");
  mutateBaseline({ write, versionFiles });
  const baseline = { version: "1.2.2", commit: commit() };
  git("checkout", "candidate");
  write("src/lib.rs", "pub fn release_fix() {}\n");
  const candidate = { version: "1.2.3", commit: commit() };
  git("checkout", "baseline");
  return { source, git, write, commit, base, baseline, candidate };
}

test("preserves a signed baseline derived from a historical ancestor of the final candidate", (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() => validateBaselineSourceAuthority({ baselineSource: f.source, ...f }));
});

test("still accepts a baseline derived directly from the exact candidate", (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() =>
    validateBaselineSourceAuthority({
      baselineSource: f.source,
      baseline: f.baseline,
      candidate: { version: "1.2.3", commit: f.base },
    }),
  );
});

test("rejects a historical base outside the candidate ancestry", (t) => {
  const f = fixture(t);
  f.git("checkout", "--orphan", "unrelated");
  f.write("unrelated.txt", "unrelated history\n");
  const candidate = { version: "1.2.3", commit: f.commit() };
  f.git("checkout", "baseline");
  assert.throws(
    () => validateBaselineSourceAuthority({ baselineSource: f.source, baseline: f.baseline, candidate }),
    /ancestor|derived/,
  );
});

test("rejects application changes hidden in the baseline derivation", (t) => {
  const f = fixture(t, ({ write }) => write("src/lib.rs", "pub fn altered_baseline() {}\n"));
  assert.throws(() => validateBaselineSourceAuthority({ baselineSource: f.source, ...f }), /whitelist|derived/);
});

test("rejects a baseline pinned to another candidate version", (t) => {
  const f = fixture(t, ({ versionFiles }) => versionFiles("1.2.2", "stable/1.2.4.json"));
  assert.throws(() => validateBaselineSourceAuthority({ baselineSource: f.source, ...f }), /candidate|derived/);
});

test("rejects a historical source base for a different release version", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      validateBaselineSourceAuthority({
        baselineSource: f.source,
        baseline: f.baseline,
        candidate: { ...f.candidate, version: "1.2.4" },
      }),
    /version|candidate/,
  );
});

test("rejects a root commit without a derivation source parent", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      validateBaselineSourceAuthority({
        baselineSource: f.source,
        baseline: { ...f.baseline, commit: f.base },
        candidate: f.candidate,
      }),
    /one parent/,
  );
});

test("rejects merge-derived baselines even when their tree has the expected version-only diff", (t) => {
  const f = fixture(t);
  const tree = f.git("rev-parse", `${f.baseline.commit}^{tree}`);
  const merged = f.git("commit-tree", tree, "-p", f.base, "-p", f.candidate.commit, "-m", "merge fixture");
  assert.throws(
    () =>
      validateBaselineSourceAuthority({
        baselineSource: f.source,
        baseline: { ...f.baseline, commit: merged },
        candidate: { ...f.candidate, commit: f.base },
      }),
    /single parent|one parent/,
  );
});
