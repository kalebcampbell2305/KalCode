// Release lookahead: the decision, the launcher and the on-landed message. The real release kit never runs here:
// powershell/git are stubs, and the one real launch starts a stub .ps1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import onLanded from "./on-landed.mjs";
import {
  dataOrUpdaterChanges,
  decideLookahead,
  frontHalfArgs,
  frontHalfDone,
  macFromCommit,
  makeDesktopClassifier,
  newestWindowsSeed,
  pathsSinceLive,
  placeholderNotes,
  readActive,
  releaseLookahead,
  speculativeFrontHalfFor,
  windowsCommandLine,
} from "./speculative.mjs";

const temps = [];
after(() => {
  // Windows releases a just-exited process's file handles asynchronously; retry instead of failing on EPERM.
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
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

/** CommandLineToArgvW, enough to read back what windowsCommandLine() produced. */
function parseCommandLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      let n = 0;
      while (line[i] === "\\") {
        n++;
        i++;
      }
      if (line[i] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2) cur += '"';
        else quoted = !quoted;
      } else {
        cur += "\\".repeat(n);
        i--;
      }
      any = true;
    } else if (ch === '"') {
      quoted = !quoted;
      any = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += ch;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

const writeIdentity = (kit, sha, extra = {}, macAgeSec = null) => {
  const dir = join(kit, `candidate-${sha.slice(0, 12)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "identity.json"),
    JSON.stringify({ commit: sha, release: `0.1.9+${extra.build ?? 1}`, ...extra }),
  );
  if (macAgeSec !== null) {
    const log = join(dir, `start-mac-${extra.build ?? 1}.log`);
    writeFileSync(log, "STARTED mac job\n");
    const t = new Date(Date.now() - macAgeSec * 1000);
    utimesSync(log, t, t);
  }
};

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
  const launched = []; // front halves started through the Start-Process launcher
  const prepared = []; // prepare-release.ps1 runs
  const calls = []; // every spawnSync, in order
  let nextPid = 4242;
  const state = { prepareStatus: 0, launcherFails: false };
  // Stands in for powershell.exe: never runs anything.
  const spawnSync = (command, args, options) => {
    calls.push(args.includes("-EncodedCommand") ? "launcher" : "prepare");
    if (args.includes("-EncodedCommand")) {
      const payload = JSON.parse(options.env.KALCODE_LOOKAHEAD_LAUNCH);
      if (state.launcherFails) {
        writeFileSync(payload.result, "ERROR=Access is denied");
        return { status: 1 };
      }
      const pid = nextPid++;
      launched.push({ command, options, payload, args: parseCommandLine(payload.argumentList), pid });
      writeFileSync(payload.result, `PID=${pid}`);
      return { status: 0 };
    }
    prepared.push({ command, args, options });
    return { status: state.prepareStatus, stderr: state.prepareStatus ? "data/updater proof missing" : "" };
  };
  // Stands in for git in the main checkout.
  const gitState = { notAncestors: new Set(), diff: ["apps/desktop/src/a.ts"] };
  const git = (args) => {
    if (args[0] === "merge-base") return { status: gitState.notAncestors.has(args[2]) ? 1 : 0, stdout: "" };
    if (args[0] === "diff") return { status: 0, stdout: gitState.diff.join("\0") };
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
  const lines = [];
  return {
    root,
    lanesDir,
    kit,
    seedRoot,
    env,
    launched,
    prepared,
    calls,
    state,
    gitState,
    lines,
    mergeLog: join(lanesDir, "merge-log.md"),
    // default stack: desktop, desktop, website on top -> the website level is the deepest, with desktop below it
    run: (overrides = {}) =>
      releaseLookahead({
        manifest: { base: "0".repeat(40), levels: [L1, L2, L3] },
        isDesktop: stackDesktop(overrides.manifest?.levels ?? [L1, L2, L3]),
        repo: root,
        mainCheckout: "C:\\main checkout",
        lanesDir,
        mergeLog: join(lanesDir, "merge-log.md"),
        env,
        platform: "win32",
        log: (line) => lines.push(line),
        isAlive: () => true,
        spawnSync,
        git,
        ...overrides,
      }),
  };
}

describe("releaseLookahead (launcher with injected powershell/git stubs)", () => {
  test("starts only the speculative front half for the chosen candidate, via Start-Process, at low priority", async () => {
    const f = fixture();
    const r = await f.run();
    assert.equal(r.launch, true, f.lines.join("\n"));
    assert.equal(r.level, L3);
    assert.equal(f.launched.length, 1);
    const [{ command, options, payload, args, pid }] = f.launched;
    assert.equal(command, "powershell.exe");
    // regression (2026-10-06): never a detached spawn (DETACHED_PROCESS powershell exits at once), and the
    // launcher's stdio is NUL so an inherited pipe cannot block the train until the front half ends
    assert.equal(options.detached, undefined);
    assert.equal(options.stdio, "ignore");
    assert.equal(options.windowsHide, true);
    assert.equal(payload.file, "powershell.exe");
    assert.equal(payload.priority, "BelowNormal");
    assert.equal(payload.out, join(f.lanesDir, "release-lookahead", `front-half-spec-${L3.sha.slice(0, 12)}.log`));
    assert.equal(payload.err, join(f.lanesDir, "release-lookahead", `front-half-spec-${L3.sha.slice(0, 12)}.err.log`));
    const arg = (name) => args[args.indexOf(name) + 1];
    assert.equal(arg("-File"), join(f.kit, "release-front-half.ps1"));
    assert.equal(arg("-Commit"), L3.sha);
    assert.equal(arg("-SpeculativeRef"), `refs/heads/${L3.branch}`);
    assert.equal(arg("-WindowsSeed"), join(f.seedRoot, "kc-release-code-primary-new000000000", "target"));
    assert.equal(arg("-Repo"), "C:\\main checkout", "a path with a space survives the command line");
    assert.equal(arg("-Kit"), f.kit);
    assert.equal(arg("-MacFromCommit"), "0".repeat(40), "no Mac package ran yet: the train base");
    assert.ok(!args.some((a) => /back-half|publish/i.test(a)), "never the back half or a publish step");
    assert.equal(f.prepared.length, 0, "no data/updater change: the front half writes the identity itself");
    // the kit requires clean ASCII/LF notes without to-do markers, even though speculative mode never uses them
    const notes = readFileSync(arg("-NotesDraft"), "utf8");
    assert.equal(notes, placeholderNotes({ branch: L3.branch, sha: L3.sha }));
    assert.ok(
      [...notes].every((ch) => ch.charCodeAt(0) < 0x80),
      "ASCII only",
    );
    assert.ok(!notes.includes("\r") && !/\b(todo|tbd)\b/i.test(notes));
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
    assert.equal(f.launched.length, 1);
    // and the deeper one may start now
    const next = await f.run({ isAlive: () => false, manifest: { base: "0".repeat(40), levels: [L1, L2, L5] } });
    assert.equal(next.launch, true);
    assert.equal(f.launched.length, 2);
  });

  test("skips a SHA whose kit state dir or front-half log already exists", async () => {
    const f = fixture();
    mkdirSync(join(f.kit, `candidate-${L3.sha.slice(0, 12)}`));
    const r = await f.run();
    assert.equal(r.reason, "already-done");
    assert.match(r.detail, /candidate-333333333333/);
    assert.equal(f.launched.length, 0);
    rmSync(join(f.kit, `candidate-${L3.sha.slice(0, 12)}`), { recursive: true });
    writeFileSync(join(f.kit, `front-half-${L3.sha.slice(0, 12)}.log`), "");
    assert.match(frontHalfDone({ dir: join(f.lanesDir, "release-lookahead"), kit: f.kit, sha: L3.sha }), /front-half/);
  });

  test("flag unset: nothing is classified or started", async () => {
    const f = fixture();
    const r = await f.run({ env: { ...f.env, KALCODE_RELEASE_LOOKAHEAD: "" }, isDesktop: () => assert.fail() });
    assert.equal(r.reason, "disabled");
    assert.equal(f.calls.length, 0);
    assert.equal(f.lines.length, 0);
    assert.ok(!existsSync(join(f.lanesDir, "release-lookahead")));
  });

  test("a failed launch is logged, never thrown, leaves no lock, and is not retried for that SHA", async () => {
    const f = fixture();
    f.state.launcherFails = true;
    const r = await f.run();
    assert.equal(r.launch, false);
    assert.equal(r.reason, "error");
    assert.match(f.lines.at(-1), /warning: release lookahead failed .*Access is denied/);
    assert.ok(!existsSync(join(f.lanesDir, "release-lookahead", "active.json")));
    assert.ok(!existsSync(f.mergeLog));
    const record = JSON.parse(
      readFileSync(join(f.lanesDir, "release-lookahead", `${L3.sha.slice(0, 12)}.json`), "utf8"),
    );
    assert.match(record.failed, /Access is denied/);
    assert.equal((await f.run()).reason, "already-done");
  });

  test("a classifier error is logged and swallowed", async () => {
    const f = fixture();
    const r = await f.run({
      isDesktop: () => {
        throw new Error("git diff timed out");
      },
    });
    assert.equal(r.reason, "error");
    assert.equal(f.calls.length, 0);
  });

  test("Idle priority and an explicit seed come from env", async () => {
    const f = fixture();
    const seed = join(f.root, "explicit seed");
    await f.run({ env: { ...f.env, KALCODE_RELEASE_LOOKAHEAD_PRIORITY: "idle", KALCODE_RELEASE_WINDOWS_SEED: seed } });
    const { args, payload } = f.launched[0];
    assert.equal(args[args.indexOf("-WindowsSeed") + 1], seed);
    assert.equal(payload.priority, "Idle");
  });

  test("not Windows -> skipped", async () => {
    const f = fixture();
    assert.equal((await f.run({ platform: "darwin" })).reason, "unsupported-platform");
    assert.equal(f.calls.length, 0);
  });
});

describe("data/updater candidates", () => {
  test("run prepare-release -AllowDataOrUpdaterChanges first, logged, then the front half", async () => {
    const f = fixture();
    f.gitState.diff = ["apps/desktop/src/a.ts", "crates/updater/src/lib.rs"];
    const r = await f.run();
    assert.equal(r.launch, true, f.lines.join("\n"));
    assert.deepEqual(f.calls, ["prepare", "launcher"]);
    const [{ args, options }] = f.prepared;
    const arg = (name) => args[args.indexOf(name) + 1];
    assert.equal(arg("-File"), join(f.kit, "prepare-release.ps1"));
    assert.equal(arg("-Commit"), L3.sha);
    assert.equal(arg("-StateRoot"), f.kit);
    assert.equal(arg("-Repo"), "C:\\main checkout");
    assert.ok(args.includes("-AllowDataOrUpdaterChanges"));
    // prepare-release's exact-SHA guard accepts the not-yet-landed candidate only through this env
    assert.equal(options.env.KALCODE_SPECULATIVE_REF, `refs/heads/${L3.branch}`);
    assert.ok(
      f.lines.some((l) => /changes data\/updater paths \(data=false updater=true\); running prepare-release/.test(l)),
    );
  });

  test("a data migration counts too, and a prepare failure stops the launch", async () => {
    const f = fixture();
    f.gitState.diff = ["crates/native-core/migrations/0042_x.sql"];
    f.state.prepareStatus = 1;
    const r = await f.run();
    assert.equal(r.reason, "error");
    assert.match(f.lines.at(-1), /prepare-release -AllowDataOrUpdaterChanges failed: data\/updater proof missing/);
    assert.equal(f.launched.length, 0);
    assert.ok(!existsSync(join(f.lanesDir, "release-lookahead", "active.json")));
  });

  test("the kit's own path rules", () => {
    assert.deepEqual(dataOrUpdaterChanges(["apps/desktop/src-tauri/src/updater.rs"]), {
      data: false,
      updater: true,
      any: true,
    });
    assert.deepEqual(dataOrUpdaterChanges(["crates/timeline/migrations/1.sql"]).data, true);
    assert.equal(dataOrUpdaterChanges(["crates/timeline/src/lib.rs", "apps/website/x.ts"]).any, false);
  });

  test("paths are diffed from the newest kit identity's live Stable commit when it is an ancestor", async () => {
    const f = fixture();
    const live = "c".repeat(40);
    writeIdentity(f.kit, "a".repeat(40), { build: 7, liveCommit: live });
    writeIdentity(f.kit, "b".repeat(40), { build: 9, liveCommit: live });
    const seen = [];
    const since = pathsSinceLive({
      kit: f.kit,
      sha: L3.sha,
      base: "0".repeat(40),
      isAncestor: () => true,
      diffNames: (a, b) => {
        seen.push([a, b]);
        return [];
      },
    });
    assert.equal(since.from, live);
    assert.deepEqual(seen, [[live, L3.sha]]);
    const fallback = pathsSinceLive({
      kit: f.kit,
      sha: L3.sha,
      base: "0".repeat(40),
      isAncestor: () => false,
      diffNames: () => [],
    });
    assert.equal(fallback.from, "0".repeat(40));
  });
});

describe("-MacFromCommit", () => {
  test("the kit candidate whose Mac package ran most recently", async () => {
    const f = fixture();
    writeIdentity(f.kit, "a".repeat(40), { build: 5 }, 600); // Mac ran 10 min ago
    writeIdentity(f.kit, "b".repeat(40), { build: 6 }, 60); // Mac ran 1 min ago -> warm tree HEAD
    writeIdentity(f.kit, "c".repeat(40), { build: 7 }); // newer, but its Mac package never ran
    const r = await f.run();
    assert.equal(r.launch, true, f.lines.join("\n"));
    const { args } = f.launched[0];
    assert.equal(args[args.indexOf("-MacFromCommit") + 1], "b".repeat(40));
    assert.equal(r.record.mac.from, "b".repeat(40));
  });

  test("not an ancestor of the candidate -> a clear Mac skip; the Windows half still starts", async () => {
    const f = fixture();
    writeIdentity(f.kit, "b".repeat(40), { build: 6 }, 60);
    f.gitState.notAncestors.add("b".repeat(40));
    const r = await f.run();
    assert.equal(r.launch, true);
    const { args } = f.launched[0];
    assert.ok(!args.includes("-MacFromCommit"));
    assert.ok(
      f.lines.some((l) =>
        /SKIP Mac for merge-train\/\S+ @333333333333: Mac warm-tree commit bbbbbbbbbbbb \(Mac package of 0\.1\.9\+6\) is not an ancestor of 333333333333; the Windows half still runs/.test(
          l,
        ),
      ),
      f.lines.join("\n"),
    );
    assert.match(
      macFromCommit({ kit: f.kit, sha: L3.sha, base: null, isAncestor: () => false }).skip,
      /not an ancestor/,
    );
  });
});

describe("startDetached (regression: the live 2026-10-06 dead launch)", () => {
  test("windowsCommandLine round-trips spaces, quotes and trailing backslashes", () => {
    const args = ["-File", "C:\\a b\\x.ps1", 'say "hi"', "C:\\dir with space\\", "", "plain"];
    assert.deepEqual(parseCommandLine(windowsCommandLine(args)), args);
  });

  test("a stub .ps1 started from a node process that exits at once keeps running, with its args and output", {
    skip: process.platform !== "win32" && "Start-Process launcher is Windows-only",
  }, async () => {
    const dir = tempDir();
    const marker = join(dir, "stub args.txt");
    const stub = join(dir, "stub front half.ps1");
    // A stand-in for release-front-half.ps1 (the real kit never runs in tests): records its args, outlives
    // its starter, and writes to stdout/stderr.
    writeFileSync(
      stub,
      [
        "param([string]$Commit, [string]$SpeculativeRef, [string]$Repo)",
        `$m = '${marker.replaceAll("'", "''")}'`,
        '"commit=$Commit ref=$SpeculativeRef repo=$Repo priority=$((Get-Process -Id $PID).PriorityClass)" | Set-Content -LiteralPath $m -Encoding ascii',
        "Write-Host '[stub] step 1'",
        "[Console]::Error.WriteLine('[stub] stderr line')",
        "Start-Sleep -Seconds 4",
        "'finished' | Add-Content -LiteralPath $m -Encoding ascii",
        "",
      ].join("\n"),
    );
    const out = join(dir, "front half.log");
    const err = join(dir, "front half.err.log");
    const starter = join(dir, "starter.mjs");
    writeFileSync(
      starter,
      `import { startDetached } from ${JSON.stringify(new URL("./speculative.mjs", import.meta.url).href)};
const pid = startDetached({
  args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ${JSON.stringify(stub)},
    "-Commit", "${"d".repeat(40)}", "-SpeculativeRef", "refs/heads/merge-train/${BASE12}-12345678", "-Repo", "C:\\\\main checkout"],
  out: ${JSON.stringify(out)}, err: ${JSON.stringify(err)}, priority: "below-normal",
});
process.stdout.write(String(pid));
`,
    );
    const started = spawnSync(process.execPath, [starter], { encoding: "utf8", timeout: 120_000 });
    assert.equal(started.status, 0, started.stderr);
    const finishedBeforeStarterExit = existsSync(marker) && readFileSync(marker, "utf8").includes("finished");
    assert.match(started.stdout, /^\d+$/);
    // the starter returned before the stub finished: nothing waits on the front half
    const deadline = Date.now() + 90_000;
    while (!(existsSync(marker) && readFileSync(marker, "utf8").includes("finished")) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 250));
    const text = readFileSync(marker, "utf8");
    assert.match(
      text,
      new RegExp(
        `^commit=${"d".repeat(40)} ref=refs/heads/merge-train/${BASE12}-12345678 repo=C:\\\\main checkout priority=BelowNormal\\r?\\nfinished`,
      ),
    );
    assert.equal(finishedBeforeStarterExit, false, "the starter returned at once and the stub outlived it");
    // "finished" is written before the stub's PowerShell exits, and it still holds both logs open: wait for
    // the process itself, or the temp folder cannot be removed (EPERM on the second PC, gate 37797680157).
    const pid = Number(started.stdout);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const exitDeadline = Date.now() + 60_000;
    while (alive() && Date.now() < exitDeadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(), false, "the stub front half exited");
    assert.match(readFileSync(out, "utf8"), /\[stub\] step 1/);
    assert.match(readFileSync(err, "utf8"), /\[stub\] stderr line/);
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
