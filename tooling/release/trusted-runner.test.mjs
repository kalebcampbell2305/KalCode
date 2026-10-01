import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  acquireLock,
  buildPrEnv,
  compareReleaseVersions,
  createRunner,
  GATE_CONTEXT,
  humanFingerprint,
  interpretShip,
  MAX_PR_ATTEMPTS,
  parseArgs,
  RELEASE_CONTEXT,
  realExec,
  releaseDue,
  releaseIdentity,
  selectPrs,
  shipLockState,
  shipRunArgs,
  shipStateDir,
  statusDescription,
  TIMEOUTS,
} from "./trusted-runner.mjs";

const HEAD = "a".repeat(40);
const PREV = "b".repeat(40);
const PR_SHA = "c".repeat(40);
const FORK_SHA = "d".repeat(40);
const PR2_SHA = "e".repeat(40);
const OWNER = "kalebcampbell2305";
const temps = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "kc-trusted-runner-"));
  temps.push(d);
  return d;
};
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("buildPrEnv", () => {
  const real = {
    Path: "C:/bin",
    PATHEXT: ".EXE",
    SystemRoot: "C:/Windows",
    ComSpec: "C:/Windows/system32/cmd.exe",
    NUMBER_OF_PROCESSORS: "8",
    USERPROFILE: "C:/Users/Kaleb",
    LOCALAPPDATA: "C:/Users/Kaleb/AppData/Local",
    APPDATA: "C:/Users/Kaleb/AppData/Roaming",
    TEMP: "C:/Users/Kaleb/AppData/Local/Temp",
    CARGO_HOME: "C:/Users/Kaleb/.cargo",
    GH_TOKEN: "x",
    AZURE_CLIENT_SECRET: "x",
    CLOUDFLARE_API_TOKEN: "x",
    TAURI_SIGNING_PRIVATE_KEY: "x",
    SSH_AUTH_SOCK: "x",
    SOME_UNRELATED_SETTING: "x",
    npm_config_store_dir: "C:/Users/Kaleb/pnpm-store",
  };
  const env = buildPrEnv(real, { isolatedDir: "S:/iso", cargoTargetDir: "S:/cargo-target" });

  test("passes only allowlisted system variables", () => {
    for (const k of ["Path", "PATHEXT", "SystemRoot", "ComSpec", "NUMBER_OF_PROCESSORS"]) assert.equal(env[k], real[k]);
    for (const k of [
      "GH_TOKEN",
      "AZURE_CLIENT_SECRET",
      "CLOUDFLARE_API_TOKEN",
      "TAURI_SIGNING_PRIVATE_KEY",
      "SSH_AUTH_SOCK",
      "SOME_UNRELATED_SETTING",
    ])
      assert.equal(env[k], undefined, k);
  });

  test("points home, AppData, temp, cargo, npm and pnpm at isolated directories", () => {
    const iso = (...p) => join("S:/iso", ...p);
    assert.equal(env.USERPROFILE, iso("home"));
    assert.equal(env.HOME, iso("home"));
    assert.equal(env.APPDATA, join(iso("home"), "AppData", "Roaming"));
    assert.equal(env.LOCALAPPDATA, join(iso("home"), "AppData", "Local"));
    assert.equal(env.TEMP, iso("tmp"));
    assert.equal(env.TMP, iso("tmp"));
    assert.equal(env.CARGO_HOME, iso("cargo-home"));
    assert.equal(env.CARGO_TARGET_DIR, "S:/cargo-target");
    assert.equal(env.npm_config_cache, iso("npm-cache"));
    assert.equal(env.npm_config_store_dir, iso("pnpm-store"));
    assert.equal(env.AZURE_CONFIG_DIR, iso("azure"));
    assert.equal(env.GH_CONFIG_DIR, iso("gh"));
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    for (const v of Object.values(env)) assert.ok(!String(v).includes("C:/Users/Kaleb/.cargo"));
  });

  test("shares only the read-mostly toolchains the gate needs", () => {
    assert.equal(env.RUSTUP_HOME, join("C:/Users/Kaleb", ".rustup"));
    assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, join("C:/Users/Kaleb/AppData/Local", "ms-playwright"));
  });
});

describe("selectPrs", () => {
  const pr = (number, sha, extra = {}) => ({
    number,
    headRefOid: sha,
    headRefName: `b${number}`,
    isCrossRepository: false,
    headRepositoryOwner: { login: OWNER },
    author: { login: OWNER },
    ...extra,
  });
  test("validates only same-repository PRs by allowlisted authors, once per head commit", () => {
    const out = selectPrs(
      [
        pr(1, PR_SHA),
        pr(2, FORK_SHA, { isCrossRepository: true }),
        pr(3, "1".repeat(40), { headRepositoryOwner: { login: "someone" } }),
        pr(4, "2".repeat(40), { author: { login: "someone" } }),
        pr(5, HEAD),
        pr(6, "not-a-sha"),
        pr(7, PREV, { author: { login: "KalebCampbell2305" } }),
        pr(8, PR2_SHA),
      ],
      {
        owner: OWNER,
        allowAuthors: [OWNER],
        done: { [HEAD]: { state: "success" }, [PR2_SHA]: { attempts: 1, error: "x" } },
      },
    );
    assert.deepEqual(
      out.map((p) => [p.number, p.skip ?? "run"]),
      [
        [1, "run"],
        [2, "head is in a fork"],
        [3, "head is not in this repository"],
        [4, "author someone is not allowlisted"],
        [5, "already validated (success)"],
        [6, "no head commit"],
        [7, "run"],
        [8, "run"],
      ],
    );
  });
});

describe("release decisions", () => {
  test("status descriptions fit GitHub's 140-character limit", () => {
    assert.equal(statusDescription("a\n  b"), "a b");
    const long = statusDescription("x".repeat(500));
    assert.equal(long.length, 140);
    assert.ok(long.endsWith("…"));
  });

  test("release versions order internal builds after the public version", () => {
    assert.equal(compareReleaseVersions("0.1.7", "0.1.7+1"), -1);
    assert.equal(compareReleaseVersions("0.1.7+12", "0.1.7+9"), 1);
    assert.equal(compareReleaseVersions("0.1.8", "0.1.7+900"), 1);
    assert.equal(compareReleaseVersions("0.1.7", "0.1.7"), 0);
    assert.equal(compareReleaseVersions("0.1.7-rc.1", "0.1.7"), null);
  });

  test("the published Stable version is the baseline only when it is lower", () => {
    assert.deepEqual(releaseIdentity({ commit: HEAD, version: "0.1.7+900", publishedVersion: "0.1.7" }), {
      commit: HEAD,
      version: "0.1.7+900",
      baselineVersion: "0.1.7",
    });
    assert.equal(releaseIdentity({ commit: HEAD, version: "0.1.7", publishedVersion: "0.1.7" }).baselineVersion, null);
    assert.equal(releaseIdentity({ commit: HEAD, version: "0.1.7", publishedVersion: null }).baselineVersion, null);
    assert.throws(() => releaseIdentity({ commit: HEAD, version: "garbage", publishedVersion: null }), /bad version/);
    assert.throws(() => releaseIdentity({ commit: "abc", version: "0.1.7", publishedVersion: null }), /bad commit/);
  });

  test("the runner's only release command runs the automated phases and never approves, attests or names a phase", () => {
    const args = shipRunArgs({ commit: HEAD, version: "0.1.7+900", baselineVersion: "0.1.7" });
    assert.deepEqual(args, [
      "tooling/release/ship.mjs",
      "run",
      "--version",
      "0.1.7+900",
      "--commit",
      HEAD,
      "--baseline-version",
      "0.1.7",
      "--phase",
      "all",
      "--execute",
    ]);
    assert.ok(!args.includes("approve") && !args.includes("attest") && !args.includes("--adopt"));
    assert.ok(!shipRunArgs({ commit: HEAD, version: "0.1.7", baselineVersion: null }).includes("--baseline-version"));
  });

  test("ship.mjs exits map to commit statuses", () => {
    assert.deepEqual(interpretShip(0, "[DONE] live-verify"), {
      state: "success",
      description: "all release phases complete",
    });
    const approval = interpretShip(
      2,
      "[DONE] bundle-mac\n[AWAITING-APPROVAL] package-mac: uses the Developer ID\n  plan...",
    );
    assert.equal(approval.state, "pending");
    assert.equal(approval.stoppedAt, "package-mac");
    assert.match(approval.description, /waiting for approval: package-mac/);
    const operator = interpretShip(2, "[AWAITING-OPERATOR] qa-sittings: person");
    assert.equal(operator.stoppedAt, "qa-sittings");
    assert.match(operator.description, /waiting for a person: qa-sittings/);
    const stop = interpretShip(
      2,
      "[STOP] stage writes to production and runs only when named explicitly (--phase stage)",
    );
    assert.equal(stop.stoppedAt, "stage");
    assert.match(stop.description, /named production write: stage/);
    const failed = interpretShip(1, "[RUN] build-windows\n[FAILED] build-windows: exit 3\n  failure record: x");
    assert.equal(failed.state, "failure");
    assert.equal(failed.stoppedAt, "build-windows");
    assert.match(
      interpretShip(1, "REFUSED: no kit in kits binds version 0.1.7+900 commit aaaaaaa").description,
      /no kit/,
    );
    const busy = interpretShip(1, "REFUSED: another ship.mjs run holds C:/x/lock (pid 4)");
    assert.equal(busy.busy, true);
    assert.equal(busy.state, "pending");
    const killed = interpretShip(124, "", { timedOut: true });
    assert.equal(killed.state, "failure");
    assert.match(killed.description, /killed/);
  });

  test("a stopped pipeline reruns only when the head, identity, a person's record or a stale lock changes", () => {
    assert.equal(releaseDue(undefined, "k"), true);
    assert.equal(releaseDue({ key: "k", state: "failure" }, "k"), false);
    assert.equal(releaseDue({ key: "k", state: "pending" }, "k2"), true);
    assert.equal(releaseDue({ key: "k", busy: true }, "k"), true);
    assert.equal(releaseDue({ key: "k", staleLock: "L" }, "k", { shipLock: "stale" }), false);
    assert.equal(releaseDue({ key: "k", staleLock: "L" }, "k", { shipLock: "none" }), true);
  });

  test("ship.mjs lock: none, held by a live run, or stale after a killed run or PID reuse", () => {
    const dir = temp();
    const lock = join(dir, "lock");
    const at = "2026-10-01T00:00:00.000Z";
    const now = () => Date.parse(at) + 60_000;
    assert.equal(shipLockState(lock), "none");
    writeFileSync(lock, `ship.mjs 0.1.7 pid=4242 at=${at}\n`);
    assert.equal(shipLockState(lock, { alive: () => true, now }), "held");
    assert.equal(shipLockState(lock, { alive: () => false, now }), "stale");
    assert.equal(
      shipLockState(lock, { alive: () => true, now: () => Date.parse(at) + TIMEOUTS.release + 11 * 60_000 }),
      "stale",
    );
  });

  test("approvals and attestations change the human fingerprint; receipts do not", () => {
    const dir = temp();
    assert.equal(humanFingerprint(dir), "none");
    mkdirSync(join(dir, "receipts"), { recursive: true });
    writeFileSync(join(dir, "receipts", "identity.json"), "{}");
    assert.equal(humanFingerprint(dir), "none");
    mkdirSync(join(dir, "approvals"), { recursive: true });
    writeFileSync(join(dir, "approvals", "package-mac.json"), "{}");
    assert.match(humanFingerprint(dir), /^approvals\/package-mac\.json:2:\d+$/);
  });

  test("arguments", () => {
    const o = parseArgs(["tick", "--allow-author", OWNER, "--no-prs", "--dry-run"]);
    assert.equal(o.command, "tick");
    assert.deepEqual(o.allowAuthors, [OWNER]);
    assert.equal(o.prs, false);
    assert.equal(o.dryRun, true);
    assert.equal(parseArgs([]).command, "tick");
    assert.throws(() => parseArgs(["approve"]), /unknown command/);
    assert.throws(() => parseArgs(["--allow-author", "bad login!"]), /GitHub login/);
    assert.throws(() => parseArgs(["--execute"]), /unknown argument/);
  });
});

describe("acquireLock", () => {
  test("the lock appears with its content; a second tick is refused while the holder is live", () => {
    const file = join(temp(), "tick.lock");
    const lock = acquireLock(file);
    assert.ok(lock);
    const held = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(held.pid, process.pid);
    assert.match(held.token, /^[0-9a-f-]{36}$/);
    assert.equal(acquireLock(file), null);
    lock.release();
    assert.equal(existsSync(file), false);
  });

  test("a dead holder's lock is taken over", () => {
    const file = join(temp(), "tick.lock");
    writeFileSync(file, JSON.stringify({ pid: 4242, token: "old" }));
    const lock = acquireLock(file, { alive: () => false });
    assert.ok(lock);
    assert.notEqual(JSON.parse(readFileSync(file, "utf8")).token, "old");
    lock.release();
  });

  test("a live PID whose heartbeat is too old (PID reuse) does not hold the lock forever", () => {
    const file = join(temp(), "tick.lock");
    writeFileSync(file, JSON.stringify({ pid: 4242, token: "old" }));
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, old, old);
    assert.equal(acquireLock(file, { alive: () => true, staleMs: 120 * 60_000 }), null);
    const lock = acquireLock(file, { alive: () => true, staleMs: 10 * 60_000 });
    assert.ok(lock);
    lock.release();
  });

  test("the heartbeat keeps a long tick's lock fresh, and release never removes someone else's lock", () => {
    const file = join(temp(), "tick.lock");
    const lock = acquireLock(file);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, old, old);
    lock.heartbeat();
    assert.equal(acquireLock(file, { staleMs: 10 * 60_000 }), null);
    writeFileSync(file, JSON.stringify({ pid: process.pid, token: "someone-else" }));
    lock.release();
    assert.equal(existsSync(file), true);
  });
});

describe("realExec", () => {
  test("captures output and exit codes", async () => {
    const r = await realExec(process.execPath, ["-e", "process.stdout.write('hi'); process.exit(3)"], {
      timeoutMs: 30_000,
    });
    assert.equal(r.code, 3);
    assert.equal(r.output, "hi");
    assert.equal(r.timedOut, false);
  });

  test("a command that exceeds its limit is killed with its whole process tree", async () => {
    const dir = temp();
    const marker = join(dir, "grandchild-survived");
    const grandchild = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 2500)`;
    const parent = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); setTimeout(() => {}, 60000)`;
    const logFile = join(dir, "run.log");
    const started = Date.now();
    const r = await realExec(process.execPath, ["-e", parent], { timeoutMs: 800, logFile });
    assert.equal(r.timedOut, true);
    assert.equal(r.code, 124);
    assert.ok(Date.now() - started < 20_000);
    assert.match(readFileSync(logFile, "utf8"), /killed after 800 ms/);
    await new Promise((res) => setTimeout(res, 3500));
    assert.equal(existsSync(marker), false, "the grandchild must die with the tree");
  });
});

// A fake world: the control checkout, GitHub (gh) and the commands the runner starts. Records every call.
function world({
  shipCode = 2,
  shipOutput = "[AWAITING-APPROVAL] package-mac: needs approval",
  gate = "PASS",
  controlHead = HEAD,
  failCheckout = new Set(),
  prs = null,
} = {}) {
  const root = temp();
  const control = join(root, "control");
  const mainRepo = join(root, "repo");
  const stateRoot = join(root, "state");
  mkdirSync(control, { recursive: true });
  const calls = [];
  const statuses = [];
  const pr = (number, sha, login = OWNER, cross = false) => ({
    number,
    headRefOid: sha,
    headRefName: `b${number}`,
    isCrossRepository: cross,
    headRepositoryOwner: { login },
    author: { login },
  });
  const list = prs ?? [pr(34, PR_SHA), pr(99, FORK_SHA, "mallory", true)];
  const ok = (output = "") => ({ code: 0, output });
  const exec = async (file, args, opts = {}) => {
    calls.push({ file, args, cwd: opts.cwd, env: opts.env, logFile: opts.logFile, timeoutMs: opts.timeoutMs });
    if (file === "git") {
      const rest = [...args];
      if (rest[0] === "-C") rest.splice(0, 2);
      while (rest[0] === "-c") rest.splice(0, 2);
      const cmd = rest.join(" ");
      if (cmd.startsWith("symbolic-ref")) return { code: 1, output: "" };
      if (cmd === "rev-parse origin/main^{commit}") return ok(HEAD);
      if (cmd === "rev-parse HEAD") return ok(controlHead);
      if (cmd === `rev-parse ${HEAD}^1`) return ok(PREV);
      if (cmd === "rev-parse --path-format=absolute --git-common-dir") return ok(join(mainRepo, ".git"));
      if (rest[0] === "checkout" && failCheckout.has(rest.at(-1)))
        return { code: 128, output: `fatal: reference is not a tree: ${rest.at(-1)}` };
      return ok();
    }
    if (file === "gh") {
      if (args[0] === "repo") return ok(`${OWNER}/KalCode`);
      if (args[0] === "pr") return ok(JSON.stringify(list));
      if (args[0] === "api") {
        const field = (k) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
        statuses.push({ sha: args[3].split("/").at(-1), context: field("context"), state: field("state") });
        return ok("{}");
      }
    }
    if (file === "pnpm") return ok();
    if (file === "node") {
      if (args.includes("gate")) return { code: gate === "PASS" ? 0 : 1, output: `gate ${gate}` };
      if (args.includes("lifecycle"))
        return ok(
          JSON.stringify({ unshippedLanes: ["desktop"], targets: { desktop: { published: { version: "0.1.7" } } } }),
        );
      if (args[0] === "--input-type=module") return ok("0.1.7+900");
      if (args.includes("run")) return { code: shipCode, output: shipOutput };
    }
    throw new Error(`unexpected ${file} ${args.join(" ")}`);
  };
  const lines = [];
  const make = (opts = {}) =>
    createRunner(
      { control, stateRoot, allowAuthors: [], prs: true, main: true, release: true, dryRun: false, ...opts },
      {
        exec,
        log: (l) => lines.push(l),
        node: "node",
        env: {
          PATH: "C:/bin",
          USERPROFILE: "C:/Users/Kaleb",
          GH_TOKEN: "secret",
          AZURE_CLIENT_SECRET: "secret",
        },
        now: () => new Date("2026-10-01T00:00:00Z"),
      },
    );
  const shipRuns = () => calls.filter((c) => c.file === "node" && c.args.includes("run"));
  return { root, control, mainRepo, stateRoot, calls, statuses, lines, make, shipRuns };
}

describe("tick", () => {
  test("gates main, starts the automated release phases, and gates owner PRs in an isolated clone", async () => {
    const w = world();
    assert.equal(await w.make().tick(), 0);

    const ship = w.shipRuns();
    assert.equal(ship.length, 1);
    assert.deepEqual(ship[0].args, shipRunArgs({ commit: HEAD, version: "0.1.7+900", baselineVersion: "0.1.7" }));
    assert.equal(ship[0].cwd, w.control);
    assert.equal(ship[0].timeoutMs, TIMEOUTS.release);
    for (const c of w.calls) {
      assert.ok(
        !(c.file === "node" && (c.args.includes("approve") || c.args.includes("attest"))),
        "the runner never approves or attests",
      );
      assert.ok(Number.isFinite(c.timeoutMs) && c.timeoutMs > 0, `${c.file} ${c.args[0]} has a timeout`);
    }

    const prClone = join(w.stateRoot, "pr-clone");
    const gates = w.calls.filter((c) => c.file === "node" && c.args.includes("gate"));
    assert.deepEqual(
      gates.map((g) => [g.cwd, g.args.at(-1), g.timeoutMs]),
      [
        [w.control, PREV, TIMEOUTS.gate],
        [prClone, "origin/main", TIMEOUTS.gate],
      ],
    );
    const prGate = gates[1];
    assert.equal(prGate.env.GH_TOKEN, undefined);
    assert.equal(prGate.env.AZURE_CLIENT_SECRET, undefined);
    assert.equal(prGate.env.USERPROFILE, join(w.stateRoot, "pr-isolated", "home"));
    assert.equal(prGate.env.AZURE_CONFIG_DIR, join(w.stateRoot, "pr-isolated", "azure"));

    const installs = w.calls.filter((c) => c.file === "pnpm");
    assert.equal(installs.length, 2);
    assert.equal(installs[0].cwd, w.control);
    assert.equal(installs[1].cwd, prClone);
    assert.equal(installs[1].env, prGate.env, "pnpm install in the PR clone gets the PR environment");
    assert.equal(installs[1].timeoutMs, TIMEOUTS.install);
    assert.deepEqual(installs[1].args, [
      "install",
      "--frozen-lockfile",
      "--store-dir",
      join(w.stateRoot, "pr-isolated", "pnpm-store"),
    ]);

    for (const c of w.calls.filter((c) => c.file === "git" && c.args[1] === prClone)) {
      assert.ok(c.args.some((a) => a.startsWith("core.hooksPath=")));
      assert.equal(c.env, prGate.env, "PR clone git runs with the PR environment");
    }
    assert.ok(
      w.calls.some((c) => c.file === "git" && c.args.includes("remote") && c.args.includes(w.mainRepo)),
      "the PR clone fetches from the local repository, not GitHub",
    );
    assert.ok(!w.calls.some((c) => c.args.includes(FORK_SHA)), "a fork PR is never checked out");

    assert.deepEqual(
      w.statuses.map((s) => [s.sha, s.context, s.state]),
      [
        [HEAD, GATE_CONTEXT, "pending"],
        [HEAD, GATE_CONTEXT, "success"],
        [HEAD, RELEASE_CONTEXT, "pending"],
        [HEAD, RELEASE_CONTEXT, "pending"],
        [PR_SHA, GATE_CONTEXT, "pending"],
        [PR_SHA, GATE_CONTEXT, "success"],
      ],
    );

    // Nothing changed: the next tick re-runs nothing.
    const before = w.calls.length;
    assert.equal(await w.make().tick(), 0);
    const again = w.calls.slice(before);
    assert.ok(!again.some((c) => c.file === "node" && (c.args.includes("run") || c.args.includes("gate"))));
    assert.ok(!again.some((c) => c.file === "pnpm"));

    // The owner approves package-mac: the next tick resumes the pipeline.
    const dir = shipStateDir(w.mainRepo, { version: "0.1.7+900", commit: HEAD });
    mkdirSync(join(dir, "approvals"), { recursive: true });
    writeFileSync(join(dir, "approvals", "package-mac.json"), "{}");
    const mark = w.calls.length;
    assert.equal(await w.make().tick(), 0);
    assert.equal(w.shipRuns().length - ship.length, 1);
    assert.ok(w.calls.slice(mark).length > 0);
  });

  test("each PR gets a freshly created clone", async () => {
    const w = world();
    const prClone = join(w.stateRoot, "pr-clone");
    mkdirSync(join(prClone, ".git", "hooks"), { recursive: true });
    writeFileSync(join(prClone, ".git", "hooks", "post-checkout"), "evil");
    writeFileSync(join(prClone, "leftover-from-last-pr"), "x");
    await w.make({ main: false }).tick();
    assert.equal(existsSync(join(prClone, "leftover-from-last-pr")), false);
    assert.equal(existsSync(join(prClone, ".git", "hooks", "post-checkout")), false);
    assert.ok(w.calls.some((c) => c.file === "git" && c.args[0] === "init" && c.args.at(-1) === prClone));
  });

  test("one PR's checkout failure does not stop the others, and is retried before it is reported", async () => {
    const pr = (number, sha) => ({
      number,
      headRefOid: sha,
      headRefName: `b${number}`,
      isCrossRepository: false,
      headRepositoryOwner: { login: OWNER },
      author: { login: OWNER },
    });
    const w = world({ prs: [pr(1, PR_SHA), pr(2, PR2_SHA)], failCheckout: new Set([PR_SHA]) });
    assert.equal(await w.make({ main: false }).tick(), 0);
    assert.deepEqual(
      w.statuses.map((s) => [s.sha, s.state]),
      [
        [PR2_SHA, "pending"],
        [PR2_SHA, "success"],
      ],
    );
    for (let i = 1; i < MAX_PR_ATTEMPTS; i++) await w.make({ main: false }).tick();
    assert.deepEqual(w.statuses.at(-1), { sha: PR_SHA, context: GATE_CONTEXT, state: "error" });
    const n = w.statuses.length;
    await w.make({ main: false }).tick();
    assert.equal(w.statuses.length, n, "an errored head is not retried");
  });

  test("a failing main gate posts failure and never starts the release", async () => {
    const w = world({ gate: "FAIL" });
    assert.equal(await w.make({ prs: false }).tick(), 0);
    assert.equal(w.shipRuns().length, 0);
    assert.deepEqual(w.statuses.at(-1), { sha: HEAD, context: GATE_CONTEXT, state: "failure" });
  });

  test("the release fails closed when the control checkout is not exactly the gated head", async () => {
    const w = world({ controlHead: PREV });
    await w.make({ prs: false }).tick();
    assert.equal(w.shipRuns().length, 0);
    assert.deepEqual(w.statuses.at(-1), { sha: HEAD, context: RELEASE_CONTEXT, state: "failure" });
    assert.ok(w.lines.some((l) => /control checkout is at bbbbbbbbbbbb, not aaaaaaaaaaaa/.test(l)));
  });

  test("a release failure is reported and not retried until something changes", async () => {
    const w = world({ shipCode: 1, shipOutput: "REFUSED: no kit in kits binds version 0.1.7+900" });
    await w.make({ prs: false }).tick();
    assert.deepEqual(w.statuses.at(-1), { sha: HEAD, context: RELEASE_CONTEXT, state: "failure" });
    await w.make({ prs: false }).tick();
    assert.equal(w.shipRuns().length, 1);
  });

  test("a stale ship.mjs lock is reported once with the unlock step, and the release resumes once it is removed", async () => {
    const w = world();
    const lock = join(shipStateDir(w.mainRepo, { version: "0.1.7+900", commit: HEAD }), "lock");
    mkdirSync(join(lock, ".."), { recursive: true });
    writeFileSync(lock, `ship.mjs 0.1.7+900 pid=${2 ** 22 + 4321} at=2026-10-01T00:00:00.000Z\n`);
    await w.make({ prs: false }).tick();
    await w.make({ prs: false }).tick();
    const release = w.statuses.filter((s) => s.context === RELEASE_CONTEXT);
    assert.deepEqual(release, [{ sha: HEAD, context: RELEASE_CONTEXT, state: "failure" }]);
    assert.ok(w.lines.some((l) => l.includes(`delete ${lock}`)));
    assert.equal(w.shipRuns().length, 0);
    rmSync(lock);
    await w.make({ prs: false }).tick();
    assert.equal(w.shipRuns().length, 1);
  });

  test("dry run changes nothing", async () => {
    const w = world();
    assert.equal(await w.make({ dryRun: true }).tick(), 0);
    assert.ok(!w.calls.some((c) => c.file === "pnpm" || (c.file === "git" && c.args.includes("checkout"))));
    assert.equal(w.statuses.length, 0);
  });

  test("refuses a control checkout that is on a branch, and honours PAUSED", async () => {
    const w = world();
    const runner = createRunner(
      { control: w.control, stateRoot: w.stateRoot, allowAuthors: [], prs: true, main: true, release: true },
      {
        exec: async (_f, a) =>
          a.includes("symbolic-ref") ? { code: 0, output: "refs/heads/main" } : { code: 0, output: "" },
        log: () => {},
      },
    );
    await assert.rejects(() => runner.tick(), /dedicated detached checkout/);
    assert.equal(existsSync(join(w.stateRoot, "tick.lock")), false, "the tick lock is released on error");
    writeFileSync(join(w.stateRoot, "PAUSED"), "");
    assert.equal(await w.make().tick(), 0);
    assert.equal(w.calls.length, 0);
  });

  test("adopts only a clean control checkout; once adopted, leftovers from a gate do not block it", async () => {
    const w = world();
    let dirty = " M packages/protocol/src/generated/index.ts";
    const exec = async (f, a) => {
      if (f === "git" && a.includes("status")) return { code: 0, output: dirty };
      if (f === "git" && a.includes("symbolic-ref")) return { code: 1, output: "" };
      return { code: 0, output: "" };
    };
    const runner = () =>
      createRunner(
        { control: w.control, stateRoot: w.stateRoot, allowAuthors: [], prs: false, main: false, release: false },
        { exec, log: () => {} },
      );
    await assert.rejects(() => runner().tick(), /has local changes/);
    dirty = "";
    assert.equal(await runner().tick(), 0);
    dirty = " M packages/protocol/src/generated/index.ts";
    assert.equal(await runner().tick(), 0);
  });
});
