import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applySweep,
  DiskSpaceError,
  guardDisk,
  inUse,
  mentionedBy,
  pathKey,
  planSweep,
  profileDirs,
  regenerableEntries,
  staleIncremental,
  staleTempLeftovers,
  startBackgroundSweep,
  targetDirs,
} from "./disk-hygiene.mjs";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 7, 12);
const config = {
  warnGb: 150,
  criticalGb: 25,
  idleHours: 24,
  mainIdleHours: 168,
  incrementalDays: 7,
  protect: ["kc-release-*"],
  retain: [],
};

function touch(path, at) {
  const seconds = at / 1000;
  utimesSync(path, seconds, seconds);
}

/** A worktree whose target/<profile> was last built `ageHours` before NOW. */
function worktree(root, name, { ageHours = 72, profile = "debug", buildOutput } = {}) {
  const path = join(root, name);
  const dir = join(path, "target", profile);
  for (const sub of ["deps", "build/ring-1/out", ".fingerprint/ring-1", "incremental/x", "bundle/nsis"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  writeFileSync(join(dir, "deps", "libring.rlib"), "x");
  writeFileSync(join(dir, "kalcode.exe"), "x");
  writeFileSync(join(dir, "kalcode.pdb"), "x");
  writeFileSync(join(dir, "bundle", "nsis", "KalCode-setup.exe"), "installer");
  writeFileSync(join(dir, "receipt.json"), "{}");
  writeFileSync(join(path, "target", "evidence.md"), "# proof");
  if (buildOutput)
    writeFileSync(join(dir, "build", "ring-1", "output"), `cargo:rustc-link-search=native=${buildOutput}\n`);
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/x\n");
  writeFileSync(join(path, ".git", "index"), "");
  const at = NOW - ageHours * HOUR;
  for (const sub of ["", "deps", "build", ".fingerprint", "incremental"]) touch(join(dir, sub), at);
  touch(join(path, ".git", "HEAD"), at);
  touch(join(path, ".git", "index"), at);
  return { path, dir };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "kc-hygiene-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const verdicts = (plan) => Object.fromEntries(plan.map((entry) => [entry.path, `${entry.verdict}: ${entry.reason}`]));

test("only idle, unprotected, unreferenced, unused profiles are SAFE", (t) => {
  const root = fixture(t);
  const main = worktree(root, "KalCode", { ageHours: 500 });
  const nested = join(main.path, "target", "lane-old", "release");
  mkdirSync(join(nested, ".fingerprint"), { recursive: true });
  touch(nested, NOW - 400 * HOUR);
  touch(join(nested, ".fingerprint"), NOW - 400 * HOUR);
  const idle = worktree(root, "kc-idle");
  const active = worktree(root, "kc-active", { ageHours: 2 });
  const seed = worktree(root, "kc-release-abc", { profile: "release" });
  const origin = worktree(root, "kc-warm", { profile: "release" });
  worktree(root, "kc-seeded", { buildOutput: join(origin.dir, "build", "ring-1", "out") });
  const running = worktree(root, "kc-run");
  worktree(root, "kc-run-ios");
  const plan = planSweep({
    config,
    now: NOW,
    worktrees: [
      "KalCode",
      "kc-idle",
      "kc-active",
      "kc-release-abc",
      "kc-warm",
      "kc-seeded",
      "kc-run",
      "kc-run-ios",
    ].map((name, index) => ({ path: join(root, name), main: index === 0 })),
    commandLines: [pathKey(`cargo build --manifest-path ${join(running.path, "Cargo.toml")}`)],
  });
  const result = verdicts(plan);
  assert.match(result[main.dir], /^KEEP: main checkout/);
  assert.match(result[nested], /^SAFE/);
  assert.match(result[idle.dir], /^SAFE: idle 72 h/);
  assert.match(result[active.dir], /^KEEP: active 2 h ago/);
  assert.match(result[seed.dir], /^KEEP: protected/);
  assert.match(result[origin.dir], /^KEEP: build outputs of .*kc-seeded/);
  assert.match(result[running.dir], /^KEEP: a running process/);
  assert.match(result[join(root, "kc-run-ios", "target", "debug")], /^SAFE/);
});

test("sessions running in the main checkout do not pin its idle nested caches", (t) => {
  const root = fixture(t);
  const main = worktree(root, "KalCode", { ageHours: 500, profile: "lane-old/release" });
  const profile = { key: pathKey(main.dir), worktree: main.path, main: true };
  const lines = [pathKey(`node ${join(main.path, "tooling", "test-suites.mjs")}`)];
  assert.equal(inUse(profile, lines), false);
  assert.equal(inUse({ ...profile, main: false }, lines), true);
  assert.equal(inUse(profile, [pathKey(`rustc --out-dir ${join(main.dir, "deps")}`)]), true);
});

test("a recent git index keeps an idle-looking target", (t) => {
  const root = fixture(t);
  const wt = worktree(root, "kc-edit");
  touch(join(wt.path, ".git", "index"), NOW - HOUR);
  const plan = planSweep({ config, now: NOW, worktrees: [{ path: wt.path }], commandLines: [] });
  assert.match(plan[0].reason, /active 1 h ago/);
});

test("the sweep removes only regenerable build output and keeps installers and evidence", (t) => {
  const root = fixture(t);
  const wt = worktree(root, "kc-idle");
  const plan = planSweep({ config, now: NOW, worktrees: [{ path: wt.path }], commandLines: [] });
  const result = applySweep(plan, { now: () => NOW });
  assert.deepEqual(result.removed, [wt.dir]);
  for (const gone of ["deps", "build", ".fingerprint", "incremental", "kalcode.exe", "kalcode.pdb"]) {
    assert.equal(existsSync(join(wt.dir, gone)), false, gone);
  }
  for (const kept of ["bundle/nsis/KalCode-setup.exe", "receipt.json"])
    assert.equal(existsSync(join(wt.dir, kept)), true, kept);
  assert.equal(existsSync(join(wt.path, "target", "evidence.md")), true);
  assert.equal(existsSync(join(wt.path, "target", ".kalcode-hygiene-trash")), true);
  assert.deepEqual(profileDirs(join(wt.path, "target")), []);
});

test("an entry a build holds open is skipped, and a profile that became active is left alone", (t) => {
  const root = fixture(t);
  const wt = worktree(root, "kc-idle");
  const busy = worktree(root, "kc-busy");
  const plan = planSweep({
    config,
    now: NOW,
    worktrees: [{ path: wt.path }, { path: busy.path }],
    commandLines: [],
  });
  const locked = Object.assign(new Error("busy"), { code: "EBUSY" });
  const result = applySweep(plan, {
    now: () => NOW,
    recheck: (profile) => profile.path !== busy.dir,
    rename: (from, to) => {
      if (from.endsWith("deps")) throw locked;
      renameSync(from, to);
    },
  });
  assert.ok(result.skipped.some((entry) => entry.path === busy.dir && entry.reason === "a process started using it"));
  assert.ok(result.skipped.some((entry) => entry.path === join(wt.dir, "deps") && entry.reason === "EBUSY"));
  assert.equal(existsSync(join(wt.dir, "deps", "libring.rlib")), true);
  assert.equal(existsSync(join(busy.dir, "deps")), true);
  assert.equal(existsSync(join(wt.dir, ".fingerprint")), false);
});

test("regenerable entries never include bundle output or evidence", (t) => {
  const root = fixture(t);
  const wt = worktree(root, "kc-x");
  const names = regenerableEntries(wt.dir)
    .map((path) => path.slice(wt.dir.length + 1))
    .sort();
  assert.deepEqual(names, [".fingerprint", "build", "deps", "incremental", "kalcode.exe", "kalcode.pdb"]);
});

test("a path is only mentioned as a whole path, never as a prefix of a longer name", () => {
  assert.equal(mentionedBy("c:/kc-remote", ["node c:/kc-remote-ios/x.mjs"]), false);
  assert.equal(mentionedBy("c:/kc-remote", ["node c:/kc-remote/x.mjs"]), true);
  assert.equal(mentionedBy("c:/kc-remote", ['cargo "c:/kc-remote"']), true);
  assert.equal(pathKey("C:\\KC-Remote\\target\\", "win32"), "c:/kc-remote/target");
});

test("the guard warns and sweeps when low and refuses to start a build when critical", (t) => {
  const state = fixture(t);
  const env = { KALCODE_DISK_HYGIENE_STATE: state };
  const lines = [];
  let sweeps = 0;
  const options = { env, config, log: (line) => lines.push(line), sweep: () => ++sweeps > 0, now: NOW };
  assert.equal(guardDisk({ ...options, free: 400 * 1024 ** 3 }).level, "ok");
  assert.equal(sweeps, 0);
  assert.equal(guardDisk({ ...options, free: 100 * 1024 ** 3 }).level, "low");
  assert.equal(sweeps, 1);
  assert.match(lines.at(-1), /100\.0 GB free/);
  assert.throws(() => guardDisk({ ...options, free: 10 * 1024 ** 3, purpose: "cargo test" }), DiskSpaceError);
  assert.equal(
    guardDisk({ ...options, env: { ...env, KALCODE_DISK_GUARD: "warn" }, free: 10 * 1024 ** 3 }).level,
    "critical",
  );
  assert.equal(guardDisk({ ...options, env: { ...env, KALCODE_DISK_GUARD: "off" }, free: 1 }).level, "skipped");
});

test("the guard reports a fall of 100 GB or more within a day", (t) => {
  const env = { KALCODE_DISK_HYGIENE_STATE: fixture(t) };
  const lines = [];
  const options = { env, config, log: (line) => lines.push(line), sweep: () => false };
  guardDisk({ ...options, free: 900 * 1024 ** 3, now: NOW - 6 * HOUR });
  guardDisk({ ...options, free: 700 * 1024 ** 3, now: NOW });
  assert.match(lines.join("\n"), /fell 200 GB in 24 h/);
});

test("at most one background sweep starts per hour, hidden and detached", (t) => {
  const env = { KALCODE_DISK_HYGIENE_STATE: fixture(t) };
  const launches = [];
  const launch = (command, args, options) => {
    launches.push({ command, args, options });
    return { unref() {} };
  };
  assert.equal(startBackgroundSweep({ env, now: Date.now(), launch }), true);
  assert.equal(startBackgroundSweep({ env, now: Date.now(), launch }), false);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].args.slice(1), ["sweep", "--apply", "--background"]);
  assert.equal(launches[0].options.windowsHide, true);
  assert.equal(launches[0].options.detached, true);
  assert.equal(launches[0].options.env.KALCODE_DISK_GUARD, "off");
});

test("kept profiles shed only incremental caches untouched for a week", (t) => {
  const root = fixture(t);
  const main = worktree(root, "KalCode", { ageHours: 1 });
  const fresh = join(main.dir, "incremental", "kalcode_core-fresh");
  const stale = join(main.dir, "incremental", "kalcode_core-stale");
  const staleSession = join(stale, "s-old");
  for (const dir of [join(fresh, "s-new"), staleSession]) mkdirSync(dir, { recursive: true });
  for (const dir of [stale, staleSession]) touch(dir, NOW - 10 * 24 * HOUR);
  touch(join(main.dir, "incremental"), NOW - HOUR);
  assert.deepEqual(staleIncremental(main.dir, NOW - 7 * 24 * HOUR), [stale]);
  const busy = worktree(root, "kc-busy", { ageHours: 1 });
  const busyStale = join(busy.dir, "incremental", "old");
  mkdirSync(busyStale, { recursive: true });
  touch(busyStale, NOW - 10 * 24 * HOUR);
  const plan = planSweep({
    config,
    now: NOW,
    worktrees: [{ path: main.path, main: true }, { path: busy.path }],
    commandLines: [pathKey(`cargo build --manifest-path ${join(busy.path, "Cargo.toml")}`)],
  });
  const [kept, running] = plan;
  assert.equal(kept.verdict, "KEEP");
  assert.deepEqual(kept.trim, [stale]);
  assert.deepEqual(running.trim, []);
  const result = applySweep(plan, { now: () => NOW });
  assert.deepEqual(result.trimmed, [stale]);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
  assert.equal(existsSync(join(main.dir, "deps", "libring.rlib")), true);
  assert.equal(existsSync(busyStale), true);
});

test("custom cargo target dirs marked with CACHEDIR.TAG are found, node_modules is not searched", (t) => {
  const root = fixture(t);
  const wt = worktree(root, "kc-custom");
  const custom = join(wt.path, ".validation", "cargo");
  mkdirSync(join(custom, "debug", ".fingerprint"), { recursive: true });
  writeFileSync(join(custom, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55");
  const hidden = join(wt.path, "node_modules", "x");
  mkdirSync(join(hidden, "debug", "deps"), { recursive: true });
  writeFileSync(join(hidden, "CACHEDIR.TAG"), "");
  assert.deepEqual(targetDirs(wt.path).sort(), [custom, join(wt.path, "target")].sort());
});

test("leaked test fixtures and old Claude snapshot stores in temp are found; anything else is not", (t) => {
  const tmp = fixture(t);
  const dir = (name, files, ageHours) => {
    const path = join(tmp, name);
    mkdirSync(path, { recursive: true });
    for (const file of files) writeFileSync(join(path, file), "");
    for (const file of ["", ...files]) touch(join(path, file), NOW - ageHours * HOUR);
    return path;
  };
  const leaked = dir(".tmpAbC123", ["kalcode.db", "kalcode.lock"], 30);
  dir(".tmpFresh1", ["kalcode.db"], 2);
  dir(".tmpOther1", ["notes.txt"], 300);
  dir(".tmpTooLongName", ["kalcode.db"], 300);
  const oldSnapshot = dir(join("claude", "bash-edit-diff", "1-2-old"), ["index"], 100);
  dir(join("claude", "bash-edit-diff", "1-2-live"), ["index"], 5);
  dir(join("claude", "C--project", "session"), ["x.output"], 500);
  assert.deepEqual(staleTempLeftovers({ tmp, now: NOW }).sort(), [leaked, oldSnapshot].sort());
});

test("only the newest release seeds are retained; older idle, unreferenced seeds are SAFE", (t) => {
  const root = fixture(t);
  const seeds = [500, 400, 300, 200, 100, 50].map((age, index) =>
    worktree(root, `kc-release-code-primary-${index}`, { ageHours: age, profile: "release" }),
  );
  const origin = seeds[0];
  writeFileSync(
    join(seeds[5].dir, "build", "ring-1", "output"),
    `cargo:rustc-link-search=native=${join(origin.dir, "build", "ring-1", "out")}\n`,
  );
  const plan = planSweep({
    config: { ...config, protect: [], retain: [{ match: "kc-release-code-primary-*", keepNewest: 2 }] },
    now: NOW,
    worktrees: seeds.map((seed) => ({ path: seed.path })),
    commandLines: [],
  });
  const result = verdicts(plan);
  assert.match(result[seeds[5].dir], /^KEEP: one of the newest/);
  assert.match(result[seeds[4].dir], /^KEEP: one of the newest/);
  assert.match(result[origin.dir], /^KEEP: build outputs of/);
  for (const seed of seeds.slice(1, 4)) assert.match(result[seed.dir], /^SAFE/);
});
