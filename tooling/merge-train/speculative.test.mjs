// Release lookahead: the decision, the launcher (spawn is always a stub; the real kit never runs here) and the
// on-landed message.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import onLanded from "./on-landed.mjs";
import {
  decideLookahead,
  frontHalfArgs,
  frontHalfDone,
  makeDesktopClassifier,
  newestWindowsSeed,
  placeholderNotes,
  readActive,
  releaseLookahead,
  speculativeFrontHalfFor,
} from "./speculative.mjs";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kc-lookahead-"));
  temps.push(dir);
  return dir;
};

const BASE12 = "a".repeat(12);
const level = (n, extra = {}) => ({
  branch: `merge-train/${BASE12}-${String(n).repeat(8)}`,
  sha: String(n).repeat(40),
  ...extra,
});
const L1 = level(1, { kind: "desktop" });
const L2 = level(2, { kind: "desktop" });
const L3 = level(3, { kind: "website" });
const L4 = level(4, { kind: "tooling" });
// isDesktop stub with the real semantics: a level's FULL stack (it or any level below it) changes desktop paths.
const stackDesktop = (levels) => (l) => levels.slice(0, levels.indexOf(l) + 1).some((x) => x.kind === "desktop");
const byKind = stackDesktop([L1, L2, L3, L4]);

describe("decideLookahead", () => {
  test("targets the deepest level overall when a desktop change is anywhere in its stack", () => {
    const seen = [];
    const isDesktop = stackDesktop([L1, L2, L3, L4]);
    const d = decideLookahead({
      enabled: true,
      levels: [L1, L2, L3, L4],
      isDesktop: (l) => {
        seen.push(l.sha[0]);
        return isDesktop(l);
      },
      isDone: () => null,
    });
    assert.equal(d.launch, true);
    // the tooling-only top level is what lands when all are green, and desktop L1/L2 are below it
    assert.equal(d.level, L4);
    assert.deepEqual(seen, ["4"], "only the deepest level's full stack is classified");
  });

  test("a desktop change only at the top counts too", () => {
    const top = level(6, { kind: "desktop" });
    const levels = [L3, L4, top];
    const d = decideLookahead({ enabled: true, levels, isDesktop: stackDesktop(levels), isDone: () => null });
    assert.equal(d.level, top);
  });

  test("a website/tooling-only stack -> nothing to launch", () => {
    const levels = [L3, L4];
    const d = decideLookahead({ enabled: true, levels, isDesktop: stackDesktop(levels), isDone: () => null });
    assert.deepEqual(d, { launch: false, reason: "no-desktop-change", level: L4 });
  });

  test("never the lower desktop level once a deeper level exists (superseded deepest -> new deepest next round)", () => {
    const first = decideLookahead({ enabled: true, levels: [L1, L2], isDesktop: byKind, isDone: () => null });
    assert.equal(first.level, L2);
    // next round, L2 went red and was superseded; the new deepest level is a fresh SHA, still once per exact SHA
    const L7 = level(7, { kind: "website" });
    const levels = [L1, L7];
    const next = decideLookahead({
      enabled: true,
      levels,
      isDesktop: stackDesktop(levels),
      isDone: (l) => (l === L2 ? "lookahead already launched" : null),
    });
    assert.equal(next.launch, true);
    assert.equal(next.level, L7);
  });

  test("flag unset -> disabled, without classifying anything", () => {
    const d = decideLookahead({
      enabled: false,
      levels: [L1],
      isDesktop: () => assert.fail("must not classify"),
      isDone: () => null,
    });
    assert.deepEqual(d, { launch: false, reason: "disabled" });
  });

  test("a front half already running or done for that exact SHA -> skip", () => {
    const done = decideLookahead({
      enabled: true,
      levels: [L1, L2],
      isDesktop: byKind,
      isDone: (l) => (l === L2 ? "kit state dir candidate-222222222222 exists" : null),
    });
    assert.equal(done.launch, false);
    assert.equal(done.reason, "already-done");
    assert.equal(done.level, L2);
    const running = decideLookahead({
      enabled: true,
      levels: [L1, L2],
      isDesktop: byKind,
      isDone: () => null,
      active: { sha: L2.sha, branch: L2.branch, pid: 7 },
    });
    assert.equal(running.reason, "already-running");
  });

  test("one at a time: another lookahead release still running -> busy", () => {
    const d = decideLookahead({
      enabled: true,
      levels: [L1, L2],
      isDesktop: byKind,
      isDone: () => null,
      active: { sha: L1.sha, branch: L1.branch, pid: 7 },
    });
    assert.equal(d.launch, false);
    assert.equal(d.reason, "busy");
  });

  test("never chooses something that is not an exact merge-train candidate", () => {
    const d = decideLookahead({
      enabled: true,
      levels: [L1, { branch: "feature/x", sha: "5".repeat(40), kind: "desktop" }],
      isDesktop: byKind,
      isDone: () => null,
    });
    assert.equal(d.level, L1);
    assert.deepEqual(decideLookahead({ enabled: true, levels: [], isDesktop: byKind, isDone: () => null }), {
      launch: false,
      reason: "no-candidate",
    });
  });
});

describe("makeDesktopClassifier (ship.mjs classify policy)", () => {
  test("classifies each level's full stack against the train base on a real git stack", () => {
    const repo = tempDir();
    const git = (...args) => {
      const r = spawnSync("git", ["-C", repo, "-c", "core.autocrlf=false", ...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    const commit = (path, msg) => {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), `${msg}\n`);
      git("add", "-A");
      git("commit", "-q", "-m", msg);
      return git("rev-parse", "HEAD");
    };
    const base = commit("README.md", "base");
    const website = { branch: `merge-train/${BASE12}-11111111`, sha: commit("apps/website/b.ts", "website") };
    const tooling = { branch: `merge-train/${BASE12}-22222222`, sha: commit("tooling/c.mjs", "tooling") };
    const desktop = { branch: `merge-train/${BASE12}-33333333`, sha: commit("apps/desktop/src/a.ts", "desktop") };
    const docs = { branch: `merge-train/${BASE12}-44444444`, sha: commit("docs/d.md", "docs") };
    const isDesktop = makeDesktopClassifier({ repo, base });
    assert.equal(isDesktop(website), false);
    assert.equal(isDesktop(tooling), false, "website + tooling stack");
    assert.equal(isDesktop(desktop), true);
    assert.equal(isDesktop(docs), true, "docs on top of a desktop level: the stack still changes desktop");
    const d = decideLookahead({
      enabled: true,
      levels: [website, tooling, desktop, docs],
      isDesktop,
      isDone: () => null,
    });
    assert.equal(d.level, docs);
    const none = decideLookahead({ enabled: true, levels: [website, tooling], isDesktop, isDone: () => null });
    assert.equal(none.reason, "no-desktop-change");
  });
});

function fixture() {
  const root = tempDir();
  const lanesDir = join(root, "lanes");
  const kit = join(root, "kit");
  const seedRoot = join(root, "drive");
  mkdirSync(lanesDir, { recursive: true });
  mkdirSync(kit, { recursive: true });
  for (const [name, age] of [
    ["kc-release-code-primary-old000000000", 3000],
    ["kc-release-code-primary-new000000000", 10],
  ]) {
    const target = join(seedRoot, name, "target");
    mkdirSync(target, { recursive: true });
    const t = new Date(Date.now() - age * 1000);
    utimesSync(target, t, t);
  }
  const env = { KALCODE_RELEASE_LOOKAHEAD: "1", KALCODE_RELEASE_KIT: kit, KALCODE_RELEASE_SEED_ROOT: seedRoot };
  const spawned = [];
  const priorities = [];
  let nextPid = 4242;
  const spawn = (command, args, options) => {
    const pid = nextPid++;
    spawned.push({ command, args, options, pid });
    return { pid, unref() {}, on() {} };
  };
  const lines = [];
  return {
    root,
    lanesDir,
    kit,
    seedRoot,
    env,
    spawned,
    priorities,
    lines,
    mergeLog: join(lanesDir, "merge-log.md"),
    // default stack: desktop, desktop, website on top -> the website level is the deepest, with desktop below it
    run: (overrides = {}) =>
      releaseLookahead({
        manifest: { base: "0".repeat(40), levels: [L1, L2, L3] },
        isDesktop: stackDesktop(overrides.manifest?.levels ?? [L1, L2, L3]),
        repo: root,
        mainCheckout: "C:\\main-checkout",
        lanesDir,
        mergeLog: join(lanesDir, "merge-log.md"),
        env,
        platform: "win32",
        log: (line) => lines.push(line),
        isAlive: () => true,
        spawn,
        setPriority: (pid, p) => priorities.push([pid, p]),
        ...overrides,
      }),
  };
}

describe("releaseLookahead (launcher with an injected spawn stub)", () => {
  test("starts only the speculative front half for the chosen candidate, detached and low priority", async () => {
    const f = fixture();
    const r = await f.run();
    assert.equal(r.launch, true, f.lines.join("\n"));
    assert.equal(r.level, L3);
    assert.equal(f.spawned.length, 1);
    const [{ command, args, options, pid }] = f.spawned;
    assert.equal(command, "powershell.exe");
    assert.equal(options.detached, true);
    assert.equal(options.windowsHide, true);
    const arg = (name) => args[args.indexOf(name) + 1];
    assert.equal(arg("-File"), join(f.kit, "release-front-half.ps1"));
    assert.equal(arg("-Commit"), L3.sha);
    assert.equal(arg("-SpeculativeRef"), `refs/heads/${L3.branch}`);
    assert.equal(arg("-WindowsSeed"), join(f.seedRoot, "kc-release-code-primary-new000000000", "target"));
    assert.equal(arg("-Repo"), "C:\\main-checkout");
    assert.equal(arg("-Kit"), f.kit);
    assert.ok(!args.some((a) => /back-half|publish/i.test(a)), "never the back half or a publish step");
    // the kit requires clean ASCII/LF notes without to-do markers, even though speculative mode never uses them
    const notes = readFileSync(arg("-NotesDraft"), "utf8");
    assert.equal(notes, placeholderNotes({ branch: L3.branch, sha: L3.sha }));
    assert.ok(
      [...notes].every((ch) => ch.charCodeAt(0) < 0x80),
      "ASCII only",
    );
    assert.ok(!notes.includes("\r") && !/\b(todo|tbd)\b/i.test(notes));
    assert.deepEqual(f.priorities, [[pid, osConstants.priority.PRIORITY_BELOW_NORMAL]]);
    const log = readFileSync(f.mergeLog, "utf8");
    assert.match(
      log,
      new RegExp(
        `^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z \\| merge-train \\| SPECULATIVE RELEASE STARTED ${L3.branch} @${L3.sha.slice(0, 12)} \\(pid ${pid}\\)\\n$`,
      ),
    );
    const active = JSON.parse(readFileSync(join(f.lanesDir, "release-lookahead", "active.json"), "utf8"));
    assert.equal(active.pid, pid);
    assert.equal(active.sha, L3.sha);
    assert.ok(existsSync(join(f.lanesDir, "release-lookahead", `${L3.sha.slice(0, 12)}.json`)));
  });

  test("one at a time machine-wide, and never twice for one SHA", async () => {
    const f = fixture();
    await f.run();
    // the same candidate while it runs
    assert.equal((await f.run()).reason, "already-running");
    // a deeper desktop level appears while the first still runs
    const L5 = level(5, { kind: "desktop" });
    const busy = await f.run({ manifest: { base: "0".repeat(40), levels: [L1, L2, L5] } });
    assert.equal(busy.reason, "busy");
    // the first finished (pid gone): the same SHA is done, not relaunched
    assert.equal((await f.run({ isAlive: () => false })).reason, "already-done");
    assert.equal(f.spawned.length, 1);
    // and the deeper one may start now
    const next = await f.run({ isAlive: () => false, manifest: { base: "0".repeat(40), levels: [L1, L2, L5] } });
    assert.equal(next.launch, true);
    assert.equal(f.spawned.length, 2);
  });

  test("skips a SHA whose kit state dir or front-half log already exists", async () => {
    const f = fixture();
    mkdirSync(join(f.kit, `candidate-${L3.sha.slice(0, 12)}`));
    const r = await f.run();
    assert.equal(r.reason, "already-done");
    assert.match(r.detail, /candidate-333333333333/);
    assert.equal(f.spawned.length, 0);
    rmSync(join(f.kit, `candidate-${L3.sha.slice(0, 12)}`), { recursive: true });
    writeFileSync(join(f.kit, `front-half-${L3.sha.slice(0, 12)}.log`), "");
    assert.match(frontHalfDone({ dir: join(f.lanesDir, "release-lookahead"), kit: f.kit, sha: L3.sha }), /front-half/);
  });

  test("flag unset: nothing is classified or spawned", async () => {
    const f = fixture();
    const r = await f.run({ env: { ...f.env, KALCODE_RELEASE_LOOKAHEAD: "" }, isDesktop: () => assert.fail() });
    assert.equal(r.reason, "disabled");
    assert.equal(f.spawned.length, 0);
    assert.equal(f.lines.length, 0);
    assert.ok(!existsSync(join(f.lanesDir, "release-lookahead")));
  });

  test("a failed launch is logged, never thrown, and leaves no lock behind", async () => {
    const f = fixture();
    const r = await f.run({
      spawn: () => {
        throw new Error("spawn EPERM");
      },
    });
    assert.equal(r.launch, false);
    assert.equal(r.reason, "error");
    assert.match(f.lines.at(-1), /warning: release lookahead failed .*spawn EPERM/);
    assert.ok(!existsSync(join(f.lanesDir, "release-lookahead", "active.json")));
    assert.ok(!existsSync(f.mergeLog));
  });

  test("a classifier error is logged and swallowed", async () => {
    const f = fixture();
    const r = await f.run({
      isDesktop: () => {
        throw new Error("git diff timed out");
      },
    });
    assert.equal(r.reason, "error");
    assert.equal(f.spawned.length, 0);
  });

  test("Idle priority and an explicit seed come from env", async () => {
    const f = fixture();
    const seed = join(f.root, "explicit-seed");
    await f.run({ env: { ...f.env, KALCODE_RELEASE_LOOKAHEAD_PRIORITY: "idle", KALCODE_RELEASE_WINDOWS_SEED: seed } });
    const { args, pid } = f.spawned[0];
    assert.equal(args[args.indexOf("-WindowsSeed") + 1], seed);
    assert.deepEqual(f.priorities, [[pid, osConstants.priority.PRIORITY_LOW]]);
  });

  test("not Windows -> skipped", async () => {
    const f = fixture();
    assert.equal((await f.run({ platform: "darwin" })).reason, "unsupported-platform");
    assert.equal(f.spawned.length, 0);
  });
});

describe("helpers", () => {
  test("newestWindowsSeed picks the newest target by mtime and skips excluded trees", () => {
    const f = fixture();
    assert.equal(
      newestWindowsSeed({ root: f.seedRoot }),
      join(f.seedRoot, "kc-release-code-primary-new000000000", "target"),
    );
    assert.equal(
      newestWindowsSeed({ root: f.seedRoot, exclude: ["kc-release-code-primary-new000000000"] }),
      join(f.seedRoot, "kc-release-code-primary-old000000000", "target"),
    );
    assert.equal(newestWindowsSeed({ root: join(f.root, "missing") }), null);
  });

  test("readActive drops a stale lock (dead pid, or older than the age cap)", () => {
    const dir = join(tempDir(), "release-lookahead");
    mkdirSync(dir, { recursive: true });
    const write = (startedAt) =>
      writeFileSync(join(dir, "active.json"), JSON.stringify({ pid: 9, sha: L1.sha, branch: L1.branch, startedAt }));
    write(Date.now());
    assert.equal(readActive({ dir, kit: dir, isAlive: () => true })?.pid, 9);
    assert.equal(readActive({ dir, kit: dir, isAlive: () => false }), null);
    assert.ok(!existsSync(join(dir, "active.json")));
    write(Date.now() - 7 * 60 * 60_000);
    assert.equal(readActive({ dir, kit: dir, isAlive: () => true }), null);
  });

  test("frontHalfArgs is always speculative", () => {
    const args = frontHalfArgs({
      kit: "C:\\kit",
      sha: L1.sha,
      branch: L1.branch,
      notesDraft: "n",
      windowsSeed: "s",
      repo: "r",
    });
    assert.ok(args.includes("-SpeculativeRef"));
    assert.ok(!args.includes("-SpeculativePr"));
  });
});

describe("on-landed", () => {
  test("a landed SHA with a lookahead front half points the releaser at it", () => {
    const f = fixture();
    const dir = join(f.lanesDir, "release-lookahead");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${L2.sha.slice(0, 12)}.json`), JSON.stringify({ sha: L2.sha, branch: L2.branch }));
    const lines = [];
    onLanded({ main: L2.sha, mainCheckout: "C:\\m", lanesDir: f.lanesDir, kit: f.kit, log: (l) => lines.push(l) });
    assert.deepEqual(lines, [
      `SHIP ${L2.sha}: speculative front half already ran for ${L2.branch}; rerun front half without -SpeculativeRef for notes, then back half`,
    ]);
  });

  test("a kit speculative.json for exactly that SHA counts too", () => {
    const f = fixture();
    const state = join(f.kit, `candidate-${L1.sha.slice(0, 12)}`);
    mkdirSync(state);
    writeFileSync(join(state, "speculative.json"), JSON.stringify({ ref: `refs/heads/${L1.branch}`, commit: L1.sha }));
    assert.deepEqual(speculativeFrontHalfFor({ sha: L1.sha, lanesDir: f.lanesDir, kit: f.kit }), {
      branch: L1.branch,
      source: "kit",
    });
    // a different SHA with the same 12-char prefix does not
    assert.equal(speculativeFrontHalfFor({ sha: `${L1.sha.slice(0, 12)}${"f".repeat(28)}`, kit: f.kit }), null);
  });

  test("otherwise it prints the release kit command as before", () => {
    const f = fixture();
    const lines = [];
    onLanded({ main: L3.sha, mainCheckout: "C:\\m", lanesDir: f.lanesDir, kit: f.kit, log: (l) => lines.push(l) });
    assert.equal(lines.length, 1);
    assert.match(
      lines[0],
      /^SHIP 3{40}: start the release kit \(PowerShell\): & '.*prepare-release\.ps1' -Commit 3{40}/,
    );
  });
});
