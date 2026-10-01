import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  acquireLock,
  compareReleaseVersions,
  createRunner,
  GATE_CONTEXT,
  humanFingerprint,
  interpretShip,
  parseArgs,
  RELEASE_CONTEXT,
  releaseDue,
  releaseIdentity,
  scrubEnv,
  selectPrs,
  shipRunArgs,
  shipStateDir,
  statusDescription,
} from "./trusted-runner.mjs";

const HEAD = "a".repeat(40);
const PREV = "b".repeat(40);
const PR_SHA = "c".repeat(40);
const FORK_SHA = "d".repeat(40);
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

describe("scrubEnv", () => {
  test("drops credentials and isolates the GitHub and Azure CLI profiles", () => {
    const env = scrubEnv(
      {
        PATH: "C:/bin",
        USERPROFILE: "C:/Users/Kaleb",
        GH_TOKEN: "x",
        GITHUB_TOKEN: "x",
        AZURE_CLIENT_SECRET: "x",
        CLOUDFLARE_API_TOKEN: "x",
        TAURI_SIGNING_PRIVATE_KEY: "x",
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "x",
        MINISIGN_KEY: "x",
        APPLE_ID: "x",
        NPM_TOKEN: "x",
        SSH_AUTH_SOCK: "x",
        SOME_API_KEY: "x",
        AWS_ACCESS_KEY_ID: "x",
      },
      { isolatedDir: "S:/iso", cargoTargetDir: "S:/cargo" },
    );
    assert.deepEqual(Object.keys(env).sort(), [
      "AZURE_CONFIG_DIR",
      "CARGO_TARGET_DIR",
      "GCM_INTERACTIVE",
      "GH_CONFIG_DIR",
      "GIT_TERMINAL_PROMPT",
      "PATH",
      "USERPROFILE",
    ]);
    assert.equal(env.AZURE_CONFIG_DIR, join("S:/iso", "azure"));
    assert.equal(env.GH_CONFIG_DIR, join("S:/iso", "gh"));
    assert.equal(env.CARGO_TARGET_DIR, "S:/cargo");
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
        pr(3, "e".repeat(40), { headRepositoryOwner: { login: "someone" } }),
        pr(4, "f".repeat(40), { author: { login: "someone" } }),
        pr(5, HEAD),
        pr(6, "not-a-sha"),
        pr(7, PREV, { author: { login: "KalebCampbell2305" } }),
      ],
      { owner: OWNER, allowAuthors: [OWNER], done: { [HEAD]: { state: "success" } } },
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
  });

  test("a stopped pipeline reruns only when the head, identity or a person's record changes", () => {
    assert.equal(releaseDue(undefined, "k"), true);
    assert.equal(releaseDue({ key: "k", state: "failure" }, "k"), false);
    assert.equal(releaseDue({ key: "k", state: "pending" }, "k2"), true);
    assert.equal(releaseDue({ key: "k", busy: true }, "k"), true);
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
  test("one tick at a time; a dead holder's lock is taken over", () => {
    const file = join(temp(), "tick.lock");
    const release = acquireLock(file);
    assert.ok(release);
    assert.equal(acquireLock(file), null);
    release();
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345 }));
    const again = acquireLock(file);
    assert.ok(again);
    again();
  });
});

// A fake world: the control checkout, GitHub (gh) and the commands the runner starts. Records every call.
function world({ shipCode = 2, shipOutput = "[AWAITING-APPROVAL] package-mac: needs approval", gate = "PASS" } = {}) {
  const root = temp();
  const control = join(root, "control");
  const mainRepo = join(root, "repo");
  const stateRoot = join(root, "state");
  mkdirSync(control, { recursive: true });
  const calls = [];
  const statuses = [];
  const prs = [
    {
      number: 34,
      headRefOid: PR_SHA,
      headRefName: "feat/x",
      isCrossRepository: false,
      headRepositoryOwner: { login: OWNER },
      author: { login: OWNER },
    },
    {
      number: 99,
      headRefOid: FORK_SHA,
      headRefName: "evil",
      isCrossRepository: true,
      headRepositoryOwner: { login: "mallory" },
      author: { login: "mallory" },
    },
  ];
  const ok = (output = "") => ({ code: 0, output });
  const exec = (file, args, opts = {}) => {
    calls.push({ file, args, cwd: opts.cwd, env: opts.env, logFile: opts.logFile });
    if (file === "git") {
      const rest = [...args];
      if (rest[0] === "-C") rest.splice(0, 2);
      while (rest[0] === "-c") rest.splice(0, 2);
      const cmd = rest.join(" ");
      if (cmd.startsWith("symbolic-ref")) return { code: 1, output: "" };
      if (cmd === "rev-parse origin/main^{commit}") return ok(HEAD);
      if (cmd === `rev-parse ${HEAD}^1`) return ok(PREV);
      if (cmd === "rev-parse --path-format=absolute --git-common-dir") return ok(join(mainRepo, ".git"));
      return ok();
    }
    if (file === "gh") {
      if (args[0] === "repo") return ok(`${OWNER}/KalCode`);
      if (args[0] === "pr") return ok(JSON.stringify(prs));
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
        env: { PATH: "C:/bin", GH_TOKEN: "secret", AZURE_CLIENT_SECRET: "secret" },
        now: () => new Date("2026-10-01T00:00:00Z"),
      },
    );
  return { root, control, mainRepo, stateRoot, calls, statuses, lines, make };
}

describe("tick", () => {
  test("gates main, starts the automated release phases, and gates owner PRs in an isolated clone", () => {
    const w = world();
    assert.equal(w.make().tick(), 0);

    const ship = w.calls.filter((c) => c.file === "node" && c.args.includes("run"));
    assert.equal(ship.length, 1);
    assert.deepEqual(ship[0].args, shipRunArgs({ commit: HEAD, version: "0.1.7+900", baselineVersion: "0.1.7" }));
    assert.equal(ship[0].cwd, w.control);
    for (const c of w.calls)
      assert.ok(
        !(c.file === "node" && (c.args.includes("approve") || c.args.includes("attest"))),
        "the runner never approves or attests",
      );

    const gates = w.calls.filter((c) => c.file === "node" && c.args.includes("gate"));
    assert.deepEqual(
      gates.map((g) => [g.cwd, g.args.at(-1)]),
      [
        [w.control, PREV],
        [join(w.stateRoot, "pr-clone"), "origin/main"],
      ],
    );
    const prGate = gates[1];
    assert.equal(prGate.env.GH_TOKEN, undefined);
    assert.equal(prGate.env.AZURE_CLIENT_SECRET, undefined);
    assert.equal(prGate.env.AZURE_CONFIG_DIR, join(w.stateRoot, "pr-isolated", "azure"));
    for (const c of w.calls.filter(
      (c) => c.cwd === join(w.stateRoot, "pr-clone") || c.args.includes(join(w.stateRoot, "pr-clone")),
    ))
      if (c.file === "git" && c.args[0] === "-C") assert.ok(c.args.some((a) => a.startsWith("core.hooksPath=")));
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
    assert.equal(w.make().tick(), 0);
    const again = w.calls.slice(before);
    assert.ok(!again.some((c) => c.file === "node" && (c.args.includes("run") || c.args.includes("gate"))));
    assert.ok(!again.some((c) => c.file === "pnpm"));

    // The owner approves package-mac: the next tick resumes the pipeline.
    const dir = shipStateDir(w.mainRepo, { version: "0.1.7+900", commit: HEAD });
    mkdirSync(join(dir, "approvals"), { recursive: true });
    writeFileSync(join(dir, "approvals", "package-mac.json"), "{}");
    const mark = w.calls.length;
    assert.equal(w.make().tick(), 0);
    assert.equal(w.calls.slice(mark).filter((c) => c.file === "node" && c.args.includes("run")).length, 1);
  });

  test("a failing main gate posts failure and never starts the release", () => {
    const w = world({ gate: "FAIL" });
    assert.equal(w.make({ prs: false }).tick(), 0);
    assert.ok(!w.calls.some((c) => c.file === "node" && c.args.includes("run")));
    assert.deepEqual(w.statuses.at(-1), { sha: HEAD, context: GATE_CONTEXT, state: "failure" });
  });

  test("a release failure is reported and not retried until something changes", () => {
    const w = world({ shipCode: 1, shipOutput: "REFUSED: no kit in kits binds version 0.1.7+900" });
    w.make({ prs: false }).tick();
    assert.deepEqual(w.statuses.at(-1), { sha: HEAD, context: RELEASE_CONTEXT, state: "failure" });
    const n = w.calls.length;
    w.make({ prs: false }).tick();
    assert.ok(!w.calls.slice(n).some((c) => c.file === "node" && c.args.includes("run")));
  });

  test("dry run changes nothing", () => {
    const w = world();
    assert.equal(w.make({ dryRun: true }).tick(), 0);
    assert.ok(!w.calls.some((c) => c.file === "pnpm" || (c.file === "git" && c.args.includes("checkout"))));
    assert.equal(w.statuses.length, 0);
  });

  test("refuses a control checkout that is on a branch, and honours PAUSED", () => {
    const w = world();
    const runner = createRunner(
      { control: w.control, stateRoot: w.stateRoot, allowAuthors: [], prs: true, main: true, release: true },
      {
        exec: (_f, a) =>
          a.includes("symbolic-ref") ? { code: 0, output: "refs/heads/main" } : { code: 0, output: "" },
        log: () => {},
      },
    );
    assert.throws(() => runner.tick(), /dedicated detached checkout/);
    mkdirSync(w.stateRoot, { recursive: true });
    writeFileSync(join(w.stateRoot, "PAUSED"), "");
    assert.equal(w.make().tick(), 0);
    assert.equal(w.calls.length, 0);
  });

  test("adopts only a clean control checkout; once adopted, leftovers from a gate do not block it", () => {
    const w = world();
    let dirty = " M packages/protocol/src/generated/index.ts";
    const exec = (f, a) => {
      if (f === "git" && a.includes("status")) return { code: 0, output: dirty };
      if (f === "git" && a.includes("symbolic-ref")) return { code: 1, output: "" };
      return { code: 0, output: f === "git" && a.includes("origin/main^{commit}") ? HEAD : "" };
    };
    const runner = (stateRoot) =>
      createRunner(
        { control: w.control, stateRoot, allowAuthors: [], prs: false, main: false, release: false },
        { exec, log: () => {} },
      );
    assert.throws(() => runner(w.stateRoot).tick(), /has local changes/);
    dirty = "";
    assert.equal(runner(w.stateRoot).tick(), 0);
    dirty = " M packages/protocol/src/generated/index.ts";
    assert.equal(runner(w.stateRoot).tick(), 0);
  });
});
