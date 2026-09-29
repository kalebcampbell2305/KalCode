import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assembleRelease,
  validateBaselineSourceAuthority,
  validateCandidateToolAuthority,
} from "./updater-qa-stage-assembly.mjs";

function authorityFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "kalcode-tool-authority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const toolSource = join(root, "tool");
  const candidateSource = join(root, "notes");
  mkdirSync(toolSource);
  const git = (source, ...args) => {
    const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (source, path, text) => {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), text);
  };
  const commit = (source) => {
    git(source, "add", ".");
    git(source, "commit", "-m", "fixture");
    return git(source, "rev-parse", "HEAD");
  };
  git(toolSource, "init", "-b", "tool");
  git(toolSource, "config", "user.name", "KalCode test");
  git(toolSource, "config", "user.email", "test@example.invalid");
  write(toolSource, "apps/desktop/product.txt", "signed product\n");
  const candidateCommit = commit(toolSource);
  git(toolSource, "worktree", "add", "-b", "notes", candidateSource, candidateCommit);
  write(candidateSource, "docs/releases/0.1.5.md", "exact hashes\n");
  const notesCommit = commit(candidateSource);
  write(toolSource, "tooling/release/updater-manifest.mjs", "reviewed tool\n");
  const approvedToolCommit = commit(toolSource);
  return { toolSource, candidateSource, candidateCommit, notesCommit, approvedToolCommit, git, write, commit };
}

test("explicit tool authority separates approved tooling from unchanged product and notes", (t) => {
  const f = authorityFixture(t);
  assert.deepEqual(validateCandidateToolAuthority(f), {
    toolCommit: f.approvedToolCommit,
    productCommit: f.candidateCommit,
    candidateNotesCommit: f.notesCommit,
  });
  assert.throws(() => validateCandidateToolAuthority({ ...f, approvedToolCommit: undefined }), /owns the executing/);
  assert.throws(
    () => validateCandidateToolAuthority({ ...f, approvedToolCommit: "a".repeat(40) }),
    /approved tool commit/,
  );
  assert.throws(
    () => validateCandidateToolAuthority({ ...f, approvedToolCommit: f.approvedToolCommit.slice(0, 12) }),
    /approved tool commit/,
  );
  assert.equal(
    validateCandidateToolAuthority({ ...f, toolSource: f.candidateSource, approvedToolCommit: undefined }),
    null,
  );
});

test("tool authority rejects dirty or unreviewed tool files and product changes", (t) => {
  for (const path of ["apps/desktop/product.txt", "tooling/release/publish.mjs", "tooling/release/unreviewed.mjs"]) {
    const f = authorityFixture(t);
    f.write(f.toolSource, path, "changed\n");
    assert.throws(() => validateCandidateToolAuthority(f), /tool.*clean/);
    f.approvedToolCommit = f.commit(f.toolSource);
    assert.throws(() => validateCandidateToolAuthority(f), /six reviewed release-tool files/);
  }
});

test("separate tooling never relaxes notes source cleanliness or notes-only history", (t) => {
  for (const path of ["apps/desktop/product.txt", "tooling/release/updater-manifest.mjs"]) {
    const f = authorityFixture(t);
    f.write(f.candidateSource, path, "changed\n");
    assert.throws(() => validateCandidateToolAuthority(f), /candidate source must be clean/);
    f.commit(f.candidateSource);
    assert.throws(() => validateCandidateToolAuthority(f), /beyond release notes/);
  }
});

test("tool authority rejects unrelated tool and notes ancestry", (t) => {
  for (const lane of ["toolSource", "candidateSource"]) {
    const f = authorityFixture(t);
    f.git(f[lane], "checkout", "--orphan", "unrelated");
    f.write(f[lane], "unrelated.txt", "unrelated\n");
    const unrelated = f.commit(f[lane]);
    if (lane === "toolSource") f.approvedToolCommit = unrelated;
    assert.throws(() => validateCandidateToolAuthority(f), /exact signed build commit/);
  }
});

function fixture(t, mutateBaseline = () => {}, populateBase = () => {}) {
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
  populateBase({ source, write });
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

function cliFixture(t) {
  const f = fixture(t, undefined, ({ source }) => {
    cpSync(import.meta.dirname, join(source, "tooling", "release"), { recursive: true });
    cpSync(join(import.meta.dirname, "../../apps/website/worker"), join(source, "apps/website/worker"), {
      recursive: true,
    });
  });
  const root = mkdtempSync(join(tmpdir(), "kalcode-tool-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const notes = join(root, "notes");
  const tool = join(root, "tool");
  f.git("worktree", "add", "-b", "cli-notes", notes, f.candidate.commit);
  f.git("worktree", "add", "-b", "cli-tool", tool, f.candidate.commit);
  const gitAt = (source, ...args) => {
    const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commitAt = (source) => {
    gitAt(source, "add", ".");
    gitAt(source, "commit", "-m", "CLI fixture");
    return gitAt(source, "rev-parse", "HEAD");
  };
  const digest = createHash("sha256").update("fixture artifact").digest("hex");
  mkdirSync(join(notes, "docs/releases"), { recursive: true });
  writeFileSync(join(notes, "docs/releases/1.2.3.md"), digest);
  commitAt(notes);
  const toolFile = join(tool, "tooling/release/updater-manifest.mjs");
  writeFileSync(toolFile, `${readFileSync(toolFile, "utf8")}\n// Reviewed isolated tool fixture.\n`);
  const approved = commitAt(tool);
  const stage = (release, lane) => {
    const path = join(root, lane);
    mkdirSync(path);
    for (const platform of ["windows", "macos"]) {
      const windows = platform === "windows";
      const file = `KalCode_${release.version}_${windows ? "x64-setup.exe" : "arm64.dmg"}`;
      const build = {
        ...release,
        file,
        requestedReleaseChannel: "stable",
        size: 16,
        sha256: digest,
        builtAt: "2026-01-01T00:00:00.000Z",
      };
      writeFileSync(join(path, windows ? "build.json" : "macos-arm64-build.json"), JSON.stringify(build));
      writeFileSync(join(path, windows ? "verify.json" : "macos-arm64-verify.json"), "{}");
      writeFileSync(join(path, windows ? "windows-x86_64-qa.json" : "macos-arm64-qa.json"), "{}");
      writeFileSync(join(path, file), "fixture artifact");
      writeFileSync(join(path, `${file}${windows ? ".windows-x86_64" : ""}.sig`), "uncertified fixture signature");
    }
    return path;
  };
  const baselineStaging = stage(f.baseline, "baseline-stage");
  const candidateStaging = stage(f.candidate, "candidate-stage");
  const args = [
    join(tool, "tooling/release/stage-updater-qa.mjs"),
    "--baseline-source",
    f.source,
    "--baseline-staging",
    baselineStaging,
    "--candidate-source",
    notes,
    "--candidate-staging",
    candidateStaging,
    "--receipt",
    join(root, "receipt.json"),
    "--dry-run",
  ];
  const run = (extra = []) => {
    const result = spawnSync(process.execPath, [...args, ...extra], {
      cwd: notes,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    for (const path of [
      join(root, "receipt.json"),
      join(baselineStaging, "publication.json"),
      join(candidateStaging, "publication.json"),
    ]) {
      assert.equal(existsSync(path), false, "dry-run must not freeze or publish evidence");
    }
    return result.stderr;
  };
  return { run, approved, toolFile, baselineStaging, candidateStaging };
}

test("real staging CLI binds its actual tool checkout and leaves uncertified packets blocked", (t) => {
  const { run, approved, toolFile } = cliFixture(t);
  assert.match(run(), /owns the executing release tooling/);
  assert.match(run(["--approved-tool-commit", "a".repeat(40)]), /exact approved tool commit/);
  assert.match(run(["--approved-tool-commit", approved]), /build is not eligible for a release descriptor/);
  writeFileSync(toolFile, `${readFileSync(toolFile, "utf8")}\n// Uncommitted change.\n`);
  assert.match(run(["--approved-tool-commit", approved]), /tool source must be clean/);
});

test("staging refuses a baseline account isolation waiver until the same platform candidate proves isolation", (t) => {
  const { run, approved, baselineStaging, candidateStaging } = cliFixture(t);
  const qaFile = { "windows-x86_64": "windows-x86_64-qa.json", "darwin-aarch64": "macos-arm64-qa.json" };
  const waiver = { reason: "baseline-provider-cli-incompatible", candidateProofRequired: true };
  const candidate = (target, accountIsolation) => ({ target, checks: { accountIsolation } });
  for (const target of Object.keys(qaFile)) {
    const other = target === "windows-x86_64" ? "darwin-aarch64" : "windows-x86_64";
    writeFileSync(
      join(baselineStaging, qaFile[target]),
      JSON.stringify({ target, accountIsolationUnavailable: waiver }),
    );
    writeFileSync(join(baselineStaging, qaFile[other]), "{}");
    writeFileSync(join(candidateStaging, qaFile[other]), JSON.stringify(candidate(other, true)));
    for (const value of [false, null]) {
      writeFileSync(join(candidateStaging, qaFile[target]), JSON.stringify(candidate(target, value)));
      assert.match(
        run(["--approved-tool-commit", approved]),
        new RegExp(`${target} baseline account isolation waiver requires the candidate record for the same platform`),
      );
    }
    // With the candidate proof present the waiver no longer blocks; the uncertified packets still do.
    writeFileSync(join(candidateStaging, qaFile[target]), JSON.stringify(candidate(target, true)));
    const stderr = run(["--approved-tool-commit", approved]);
    assert.doesNotMatch(stderr, /account isolation waiver/);
    assert.match(stderr, /build is not eligible for a release descriptor/);
  }
});

test("staging refuses the macOS baseline browser waiver until the macOS candidate proves browser", (t) => {
  const { run, approved, baselineStaging, candidateStaging } = cliFixture(t);
  const waiver = { reason: "baseline-webview-nil-url-abort", candidateProofRequired: true };
  const macQa = "macos-arm64-qa.json";
  const target = "darwin-aarch64";
  writeFileSync(join(baselineStaging, macQa), JSON.stringify({ target, browserUnavailable: waiver }));
  writeFileSync(join(baselineStaging, "windows-x86_64-qa.json"), "{}");
  writeFileSync(
    join(candidateStaging, "windows-x86_64-qa.json"),
    JSON.stringify({ target: "windows-x86_64", checks: { browser: true } }),
  );
  const refused = new RegExp(`${target} baseline browser waiver requires the candidate record for the same platform`);
  // The fixture's empty macOS candidate record ({}) carries no browser proof at all.
  assert.match(run(["--approved-tool-commit", approved]), refused);
  for (const candidate of [
    { target },
    { target, checks: { browser: false } },
    { target, checks: { browser: null } },
    { target, checks: { browser: true }, browserUnavailable: waiver },
    { target: "windows-x86_64", checks: { browser: true } },
  ]) {
    writeFileSync(join(candidateStaging, macQa), JSON.stringify(candidate));
    assert.match(run(["--approved-tool-commit", approved]), refused);
  }
  // With the candidate proof present the waiver no longer blocks; the uncertified packets still do.
  writeFileSync(join(candidateStaging, macQa), JSON.stringify({ target, checks: { browser: true } }));
  const stderr = run(["--approved-tool-commit", approved]);
  assert.doesNotMatch(stderr, /browser waiver/);
  assert.match(stderr, /build is not eligible for a release descriptor/);
});

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

function timestampStage(t, macTimes) {
  const staging = mkdtempSync(join(tmpdir(), "kalcode-stage-timestamp-"));
  t.after(() => rmSync(staging, { recursive: true, force: true }));
  const signaturePath = join(staging, "fixture.sig");
  writeFileSync(signaturePath, "uncertified fixture signature");
  const packets = [
    { target: "windows-x86_64", file: "KalCode_1.2.3_x64-setup.exe", times: { builtAt: "2026-01-01T00:00:00.000Z" } },
    { target: "darwin-aarch64", file: "KalCode_1.2.3_arm64.dmg", times: macTimes },
  ].map(({ target, file, times }) => ({
    target,
    signaturePath,
    build: {
      version: "1.2.3",
      commit: "a".repeat(40),
      requestedReleaseChannel: "stable",
      file,
      sha256: "b".repeat(64),
      size: 100,
      ...times,
    },
  }));
  return {
    staging,
    publication: join(staging, "publication.json"),
    run: () => assembleRelease({ staging, source: staging, packets, version: "1.2.3", notes: "Fixture", write: true }),
  };
}

test("QA staging accepts Mac createdAt while retaining downstream artifact certification", async (t) => {
  const createdAt = "2026-01-02T00:00:00.000Z";
  const f = timestampStage(t, { createdAt });
  // This fixture intentionally has no valid signing/QA evidence. Valid time mapping may
  // create local publication identity, but must never authorize its distribution.
  await assert.rejects(f.run(), /build is not eligible for a release descriptor/);
  const publication = JSON.parse(readFileSync(f.publication, "utf8"));
  assert.equal(publication.artifacts.find((artifact) => artifact.target === "darwin-aarch64").builtAt, createdAt);
});

test("QA staging gives builtAt precedence over createdAt", async (t) => {
  const builtAt = "2026-01-03T00:00:00.000Z";
  const f = timestampStage(t, { builtAt, createdAt: "2026-01-02T00:00:00.000Z" });
  await assert.rejects(f.run(), /build is not eligible for a release descriptor/);
  const publication = JSON.parse(readFileSync(f.publication, "utf8"));
  assert.equal(publication.artifacts.find((artifact) => artifact.target === "darwin-aarch64").builtAt, builtAt);
});

test("QA staging rejects malformed fallback or preferred build timestamps", async (t) => {
  for (const times of [
    {},
    { createdAt: "not a timestamp" },
    { createdAt: "2026-01-02T00:00:00Z" },
    { builtAt: "invalid", createdAt: "2026-01-02T00:00:00.000Z" },
  ]) {
    const f = timestampStage(t, times);
    await assert.rejects(f.run(), /publication artifact build time is not a canonical timestamp/);
    assert.equal(existsSync(f.publication), false);
  }
});
