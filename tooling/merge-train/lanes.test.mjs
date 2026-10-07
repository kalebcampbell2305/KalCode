// Multi-lane integration (owner rule 2026-10-05, AGENTS.md "high-concurrency merge + release architecture"):
// lanes on one captured main SHA, stacked exact candidates gating concurrently, conflicts and red gates
// confined to their own lane, supersession, a seconds-long main lock, one coordinator, release records.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  createTrain,
  deltaPreservesEvidence,
  isReleaseRecordPath,
  machineLeasePath,
  planLanes,
  releaseRecordResolver,
  riskZones,
  stackOrder,
} from "./train.mjs";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function sh(cwd, args, input) {
  const r = spawnSync("git", ["-C", cwd, "-c", "core.autocrlf=false", ...args], {
    encoding: "utf8",
    windowsHide: true,
    input,
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const isAncestor = (repo, a, b) =>
  spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", a, b], { windowsHide: true }).status === 0;
const hasPath = (repo, sha, path) =>
  spawnSync("git", ["-C", repo, "cat-file", "-e", `${sha}:${path}`], { windowsHide: true }).status === 0;

let clock = 1_791_000_000;
function importCommits(repo, commits) {
  const data = (text) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  let stream = "";
  commits.forEach((c, i) => {
    stream += `commit ${c.ref}\nmark :${i + 1}\ncommitter Test <test@example.invalid> ${clock++} +0000\n${data(c.message)}`;
    if (c.from) stream += `from ${c.from}\n`;
    for (const [path, text] of Object.entries(c.files)) stream += `M 100644 inline ${path}\n${data(text)}`;
    stream += `get-mark :${i + 1}\n`;
  });
  return sh(repo, ["fast-import", "--quiet"], stream).split("\n").filter(Boolean);
}

const RELEASES = (build, unavailable = []) =>
  `${JSON.stringify({ schemaVersion: 1, latest: { version: `0.1.9+${build}`, channel: "stable" }, unavailable }, null, 2)}\n`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kalcode-merge-lanes-"));
  temps.push(dir);
  const origin = join(dir, "origin.git");
  sh(dir, ["init", "-q", "--bare", "-b", "main", origin]);
  appendFileSync(join(origin, "config"), "[core]\n\tlogAllRefUpdates = always\n");
  importCommits(origin, [
    {
      ref: "refs/heads/main",
      message: "seed",
      files: {
        "shared.txt": "one\ntwo\nthree\n",
        "README.md": "seed\n",
        "apps/website/src/data/releases.json": RELEASES(1565),
        ".github/workflows/gate.yml": readFileSync(
          new URL("../../.github/workflows/gate.yml", import.meta.url),
          "utf8",
        ),
      },
    },
  ]);
  return { dir, origin, provider: new FakeProvider(origin) };
}

function cloneOf(env, name) {
  const path = join(env.dir, name);
  sh(env.dir, ["init", "-q", path]);
  appendFileSync(
    join(path, ".git", "config"),
    `[remote "origin"]\n\turl = ${env.origin.replaceAll("\\", "/")}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` +
      "[user]\n\tname = Merge Lanes Test\n\temail = lanes@example.invalid\n",
  );
  return path;
}

const lines = (text) => text.split("\n").filter(Boolean);
const originMain = (env) => sh(env.origin, ["rev-parse", "refs/heads/main"]);
const mainUpdates = (env) => lines(sh(env.origin, ["reflog", "show", "--format=%H", "refs/heads/main"]));
const trainBranches = (env) =>
  lines(sh(env.origin, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/merge-train/"]));

function openPr(env, n, files, { from = "refs/heads/main^0" } = {}) {
  const [head] = importCommits(env.origin, [{ ref: `refs/heads/pr-${n}`, from, message: `PR ${n}`, files }]);
  if (!env.provider.prs.has(n)) env.provider.add(n);
  return head;
}
function pushMain(env, files, message = "bypass") {
  return importCommits(env.origin, [{ ref: "refs/heads/main", from: "refs/heads/main^0", message, files }])[0];
}

class FakeProvider {
  constructor(origin) {
    this.origin = origin;
    this.prs = new Map();
    this.comments = [];
    this.gates = new Map();
    this.autoGate = null;
    this.seq = 0;
    this.cancelled = [];
    this.onGate = null;
  }
  add(number) {
    this.prs.set(number, { number, title: `PR ${number}`, open: true, draft: false, queued: true, order: ++this.seq });
  }
  head(number) {
    return sh(this.origin, ["rev-parse", `refs/heads/pr-${number}`]);
  }
  async listQueue() {
    return [...this.prs.values()]
      .filter((p) => p.open && !p.draft && p.queued)
      .sort((a, b) => a.order - b.order)
      .map((p) => ({
        number: p.number,
        title: p.title,
        head: this.head(p.number),
        headRef: `pr-${p.number}`,
        fetchRef: `refs/heads/pr-${p.number}`,
      }));
  }
  async getPr(number) {
    const p = this.prs.get(number);
    return p
      ? { baseRef: "main", crossRepository: false, ...p, head: this.head(number), fetchRef: `refs/heads/pr-${number}` }
      : null;
  }
  async ensureLabel() {}
  async addLabel(number) {
    Object.assign(this.prs.get(number), { queued: true, order: ++this.seq });
  }
  async removeLabel(number) {
    this.prs.get(number).queued = false;
  }
  async comment(number, body) {
    this.comments.push({ number, body });
  }
  async hasComment(number, marker) {
    return this.comments.some((c) => c.number === number && c.body.includes(`<!-- merge-train:${marker} -->`));
  }
  async gateStatus(sha) {
    this.onGate?.(sha);
    if (this.gates.has(sha)) return { state: this.gates.get(sha) };
    if (this.autoGate) return { state: this.autoGate(sha) };
    return { state: "missing" };
  }
  async cancelGates(sha, branch) {
    if (["pending", "missing"].includes((await this.gateStatus(sha)).state)) this.cancelled.push({ sha, branch });
  }
}

function makeTrain(env, repo, extra = {}) {
  const log = [];
  const train = createTrain({
    repo,
    provider: env.provider,
    log: (line) => log.push(line),
    lanesDir: join(env.dir, "lanes"),
    mergeLog: join(env.dir, "lanes", "merge-log.md"),
    sleep: async () => {},
    ...extra,
  });
  return Object.assign(train, { log });
}

/** Six agents' PRs: two independent, two sharing a risky zone, two that really conflict. */
function sixAgents(env) {
  return {
    1: openPr(env, 1, { "feature-1/a.txt": "one\n" }),
    2: openPr(env, 2, { "feature-2/b.txt": "two\n" }),
    3: openPr(env, 3, { "crates/threads/src/runtime.rs": "// three\n" }),
    4: openPr(env, 4, { "crates/contracts/src/agent_state.rs": "// four\n" }),
    5: openPr(env, 5, { "shared.txt": "one\nFIVE\nthree\n" }),
    6: openPr(env, 6, { "shared.txt": "one\nSIX\nthree\n" }),
  };
}

const nums = (items) => items.map((i) => i.number);

describe("merge lanes", { concurrency: true }, () => {
  test("planLanes: independent PRs get their own lane; risky zones, stacks and real conflicts share one", async () => {
    const prs = [
      { number: 1, head: "a", files: ["x.txt"], ancestors: new Set() },
      { number: 2, head: "b", files: ["y.txt"], ancestors: new Set() },
      { number: 3, head: "c", files: ["pnpm-lock.yaml"], ancestors: new Set() },
      { number: 4, head: "d", files: ["apps/desktop/pnpm-lock.yaml"], ancestors: new Set() },
      { number: 5, head: "e", files: ["same.txt"], ancestors: new Set() },
      { number: 6, head: "f", files: ["same.txt"], ancestors: new Set() },
      { number: 7, head: "g", files: ["z.txt"], ancestors: new Set(["a"]) },
      { number: 8, head: "h", files: ["x.txt"], ancestors: new Set() },
    ];
    const { lanes, reasons } = await planLanes(prs, { conflicts: async (a, b) => a.number === 5 && b.number === 6 });
    assert.deepEqual(
      lanes.map((l) => l.numbers),
      [[1, 7], [2], [3, 4], [5, 6], [8]],
      "x.txt overlap without a merge conflict stays independent",
    );
    assert.ok(reasons.some((r) => r.why === "risk:lockfile"));
    assert.ok(reasons.some((r) => r.why === "conflict"));
    assert.ok(reasons.some((r) => r.why === "stacked"));
    assert.deepEqual(riskZones(".github/workflows/gate.yml"), ["ci"]);
    assert.deepEqual(riskZones("packages/protocol/src/generated/Thread.ts"), ["protocol"]);
    assert.equal(new Set(lanes.map((l) => l.id)).size, lanes.length);
  });

  test("six agents finishing together: lanes prepare and gate concurrently, a conflict blocks only its lane, compatible lanes land in ONE update", async () => {
    const env = setup();
    const heads = sixAgents(env);
    const agents = [1, 2, 3, 4, 5, 6].map((n) => makeTrain(env, cloneOf(env, `agent-${n}`)));
    const base = originMain(env);

    // Six coordinators prepare at the same moment: they agree on the same stacked levels.
    const prepared = await Promise.all(agents.map((a) => a.buildAll()));
    const levels = prepared[0].levels;
    for (const p of prepared)
      assert.deepEqual(
        p.levels.map((l) => l.sha),
        levels.map((l) => l.sha),
      );
    assert.deepEqual(
      prepared[0].lanes.map((l) => l.numbers),
      [[1], [2], [3, 4], [5, 6]],
    );
    assert.deepEqual(
      levels.map((l) => nums(l.included)),
      [[1], [1, 2], [1, 2, 3, 4], [1, 2, 3, 4, 5]],
    );
    assert.deepEqual(
      levels.map((l) => l.added),
      [[1], [2], [3, 4], [5]],
      "#3 and #4 batch in one lane level",
    );
    // Several candidates exist at once: the gate pool validates all four concurrently.
    assert.equal(trainBranches(env).length, 4);
    env.provider.autoGate = () => "pending";
    const states = await Promise.all(levels.map((l) => env.provider.gateStatus(l.sha)));
    assert.ok(states.every((s) => s.state === "pending"));
    // #6 conflicts with #5 only: it waits, nothing else does.
    const six = prepared[0].skipped.find((s) => s.number === 6);
    assert.equal(six.reason, "conflicts-with-batch");
    assert.deepEqual(six.files, ["shared.txt"]);
    assert.equal(originMain(env), base, "preparation never touches main");

    // All green: the deepest level lands in one fast-forward; the lower levels are SUPERSEDED.
    env.provider.autoGate = (sha) => (sha === levels.at(-1).sha ? "success" : "pending");
    const before = mainUpdates(env).length;
    const coordinator = agents[0];
    const result = await coordinator.run({ maxRounds: 2 });
    assert.equal(result.landed.length, 1);
    assert.equal(mainUpdates(env).length - before, 1, "one main update for five PRs");
    const main = originMain(env);
    for (const n of [1, 2, 3, 4, 5]) assert.ok(isAncestor(env.origin, heads[n], main), `#${n} landed`);
    assert.equal(isAncestor(env.origin, heads[6], main), false);
    for (const lower of levels.slice(0, -1)) {
      assert.ok(
        env.provider.cancelled.some((c) => c.sha === lower.sha),
        `${lower.branch} gate cancelled`,
      );
      assert.ok(!trainBranches(env).includes(lower.branch), `${lower.branch} deleted`);
    }
    assert.ok(coordinator.log.some((l) => /^main lock held \d+ ms$/.test(l)));
    assert.ok(!coordinator.log.some((l) => l.startsWith("stacking")), "an all-green stack keeps queue order");
    const status = await coordinator.status();
    const byNumber = Object.fromEntries(status.prs.map((p) => [p.number, p]));
    for (const n of [1, 2, 3, 4, 5]) assert.equal(byNumber[n].state, "MERGED");
    assert.notEqual(byNumber[6].state, "MERGED");
    assert.ok(Number.isFinite(byNumber[1].timings.toLandMs ?? 0));
  });

  test("a red level is attributed to its own lane only: the culprit is ejected, every other lane lands", async () => {
    const env = setup();
    const heads = sixAgents(env);
    const train = makeTrain(env, cloneOf(env, "coordinator"));
    // Any candidate containing #2's file fails; everything else passes.
    env.provider.autoGate = (sha) => (hasPath(env.origin, sha, "feature-2/b.txt") ? "failure" : "success");
    const result = await train.run({ maxRounds: 6 });
    const main = originMain(env);
    assert.equal(isAncestor(env.origin, heads[2], main), false);
    for (const n of [1, 3, 4, 5]) assert.ok(isAncestor(env.origin, heads[n], main), `#${n} landed despite #2`);
    assert.equal(env.provider.prs.get(2).queued, false, "#2 ejected");
    assert.ok(result.landed.length >= 1);
  });

  test("a multi-PR lane that turns red is bisected inside the lane, not ejected wholesale", async () => {
    const env = setup();
    const three = openPr(env, 3, { "crates/threads/src/runtime.rs": "// three\n" });
    const four = openPr(env, 4, { "crates/contracts/src/agent_state.rs": "// four\n" });
    const train = makeTrain(env, cloneOf(env, "coordinator"));
    env.provider.autoGate = (sha) =>
      hasPath(env.origin, sha, "crates/contracts/src/agent_state.rs") ? "failure" : "success";
    await train.run({ maxRounds: 8 });
    const main = originMain(env);
    assert.ok(isAncestor(env.origin, three, main), "the good half landed");
    assert.equal(isAncestor(env.origin, four, main), false);
    assert.equal(env.provider.prs.get(4).queued, false, "the culprit was isolated and ejected");
    assert.equal(env.provider.prs.get(3).queued, false, "#3 left the queue by landing");
  });

  test("stackOrder: clean lanes form the bottom, recently-red lanes go on top, ties keep queue order", () => {
    const lanes = [{ numbers: [1] }, { numbers: [2, 3] }, { numbers: [4] }, { numbers: [5] }];
    const none = stackOrder(lanes, () => false);
    assert.deepEqual(none.lanes, lanes, "no red: exactly queue order");
    assert.deepEqual([none.moved, none.jumped], [[], []]);
    const some = stackOrder(lanes, (n) => n === 3 || n === 4);
    assert.deepEqual(
      some.lanes.map((l) => l.numbers),
      [[1], [5], [2, 3], [4]],
    );
    assert.deepEqual(
      some.moved.map((l) => l.numbers),
      [[2, 3], [4]],
    );
    assert.deepEqual(
      some.jumped.map((l) => l.numbers),
      [[5]],
    );
    const alreadyOnTop = stackOrder(lanes, (n) => n === 5);
    assert.deepEqual(alreadyOnTop.lanes, lanes);
    assert.deepEqual(alreadyOnTop.moved, [], "a red lane already last moves nothing");
  });

  test("a lane attributed red in one round stacks above a clean lane the next, which lands without it", async () => {
    const env = setup();
    const three = openPr(env, 3, { "crates/threads/src/runtime.rs": "// three\n" });
    const four = openPr(env, 4, { "crates/contracts/src/agent_state.rs": "// four\n" });
    const one = openPr(env, 1, { "feature-1/a.txt": "one\n" });
    let sleeps = 0;
    const train = makeTrain(env, cloneOf(env, "coordinator"), {
      sleep: async () => {
        sleeps++;
      },
    });
    // Queue order: the lane [#3 #4] first, so #1 stacks on it.
    const first = await train.buildAll();
    assert.deepEqual(
      first.levels.map((l) => nums(l.included)),
      [
        [3, 4],
        [3, 4, 1],
      ],
    );
    env.provider.gates.set(first.levels[0].sha, "failure");
    env.provider.gates.set(first.levels[1].sha, "failure");
    env.provider.autoGate = () => "pending";

    // Round 1 attributes the red to the lane (bisect); round 2 follows with no wait and re-stacks #1 on main.
    await train.run({ maxRounds: 2 });
    assert.ok(train.log.includes("stacking recently-red lane [#3 #4] above [#1]"), train.log.join("\n"));
    assert.equal(sleeps, 1, "the rebuild happened in the round right after attribution, before any wait");
    const second = await train.buildAll();
    assert.deepEqual(
      second.levels.map((l) => nums(l.included)),
      [[1], [1, 3]],
      "the clean lane is the bottom level; the red lane (bisected) is on top",
    );
    assert.deepEqual(
      second.levels.map((l) => l.action),
      ["reused", "reused"],
      "built by round 2 of run()",
    );

    // #1's level goes green while the red lane's is still gating: #1 lands alone.
    env.provider.gates.set(second.levels[0].sha, "success");
    const result = await train.run({ maxRounds: 1 });
    assert.equal(result.landed.length, 1);
    const main = originMain(env);
    assert.ok(isAncestor(env.origin, one, main), "#1 landed without the red lane");
    assert.equal(isAncestor(env.origin, three, main), false);
    assert.equal(isAncestor(env.origin, four, main), false);
    assert.equal(env.provider.prs.get(3).queued, true, "the red lane keeps its place in the queue");
  });

  test("a red lane that goes green again returns to queue order", async () => {
    const env = setup();
    openPr(env, 10, { "feature-10/a.txt": "ten\n" });
    let moveMain = false;
    const train = makeTrain(env, cloneOf(env, "coordinator"), {
      hooks: {
        beforeLandPush: () => {
          if (moveMain) pushMain(env, { "other.txt": "moved\n" });
          moveMain = false;
        },
      },
    });
    env.provider.autoGate = () => "failure";
    await train.run({ maxRounds: 1 });
    assert.equal(env.provider.prs.get(10).queued, false, "#10 ejected");

    // The author fixes and resubmits #10; another agent queues #11 after it.
    openPr(env, 10, { "feature-10/a.txt": "ten, fixed\n" }, { from: "refs/heads/pr-10^0" });
    await env.provider.addLabel(10);
    openPr(env, 11, { "feature-11/b.txt": "eleven\n" });
    env.provider.autoGate = () => "pending";
    const stacked = await train.buildAll();
    assert.deepEqual(
      stacked.levels.map((l) => nums(l.included)),
      [[11], [11, 10]],
    );
    assert.ok(train.log.includes("stacking recently-red lane [#10] above [#11]"));

    // Its level gates green, but main moves before it can land: #10 is green again, not landed.
    env.provider.gates.set(stacked.levels[1].sha, "success");
    moveMain = true;
    const result = await train.run({ maxRounds: 1 });
    assert.equal(result.landed.length, 0);
    const mark = train.log.length;
    const back = await train.buildAll();
    assert.deepEqual(
      back.levels.map((l) => nums(l.included)),
      [[10], [10, 11]],
      "queue order again on the new main",
    );
    assert.ok(!train.log.slice(mark).some((l) => l.startsWith("stacking")));
  });

  test("append-only while gating: a PR that joins a gating lane stacks above it; nothing gating is rebuilt or cancelled", async () => {
    const env = setup();
    openPr(env, 1, { "feature-1/a.txt": "one\n" });
    openPr(env, 2, { "crates/threads/src/runtime.rs": "// two\n" });
    const train = makeTrain(env, cloneOf(env, "pinned"));
    const first = await train.buildAll();
    assert.deepEqual(
      first.levels.map((l) => nums(l.included)),
      [[1], [1, 2]],
    );
    env.provider.autoGate = () => "pending";

    // #3 shares #2's risky zone, so a fresh plan would rebuild #2's lane as one level [1, 2, 3].
    openPr(env, 3, { "crates/contracts/src/agent_state.rs": "// three\n" });
    const second = await train.buildAll();
    assert.deepEqual(
      second.levels.map((l) => nums(l.included)),
      [[1], [1, 2], [1, 2, 3]],
      "the gating stack keeps its levels and #3 stacks above it",
    );
    assert.deepEqual(
      second.levels.slice(0, 2).map((l) => [l.sha, l.action]),
      first.levels.map((l) => [l.sha, "reused"]),
    );
    assert.deepEqual(env.provider.cancelled, [], "no gate in flight is cancelled");
    assert.equal(trainBranches(env).length, 3);

    // A changed head inside the stack releases it: the plan rebuilds as before.
    openPr(env, 2, { "crates/threads/src/runtime.rs": "// two, revised\n" }, { from: "refs/heads/pr-2^0" });
    const third = await train.buildAll();
    assert.ok(
      !third.levels.some((l) => l.sha === first.levels[1].sha),
      "a stack whose PR head changed is not kept",
    );
  });

  test("a lower level that lands keeps the deeper levels valid: they fast-forward on their exact gated tree", async () => {
    const env = setup();
    openPr(env, 1, { "feature-1/a.txt": "one\n" });
    openPr(env, 2, { "feature-2/b.txt": "two\n" });
    const train = makeTrain(env, cloneOf(env, "coordinator"));
    const { levels } = await train.buildAll();
    assert.equal(levels.length, 2);
    env.provider.gates.set(levels[0].sha, "success");
    env.provider.gates.set(levels[1].sha, "pending");
    assert.equal((await train.land(levels[0].branch)).landed, true);
    // The next round reuses level 2 as is: no rebuild, no new candidate, no new gate.
    const again = await train.buildAll();
    assert.deepEqual(
      again.levels.map((l) => l.sha),
      [levels[1].sha],
    );
    assert.equal(again.levels[0].action, "reused");
    env.provider.gates.set(levels[1].sha, "success");
    const second = await train.land(levels[1].branch);
    assert.equal(second.landed, true);
    assert.equal(originMain(env), levels[1].sha, "fast-forward to the exact gated tree");
  });

  test("the main lock covers only the push: no gate query or fetch happens while it is held", async () => {
    const env = setup();
    openPr(env, 1, { "feature-1/a.txt": "one\n" });
    const lockPath = join(env.dir, "lanes", "main-update.lock");
    let lockedGateQueries = 0;
    let sawLock = false;
    env.provider.onGate = () => {
      if (existsSync(lockPath)) lockedGateQueries++;
    };
    const train = makeTrain(env, cloneOf(env, "coordinator"), {
      hooks: {
        beforeLandPush: () => {
          sawLock = existsSync(lockPath);
        },
      },
    });
    env.provider.autoGate = () => "success";
    await train.run({ maxRounds: 2 });
    assert.equal(sawLock, true);
    assert.equal(lockedGateQueries, 0);
    assert.equal(existsSync(lockPath), false, "released immediately");
    assert.ok(train.log.some((l) => /^main lock held \d+ ms$/.test(l)));
  });

  test("a second coordinator refuses to start while a live one holds the lease; a dead or silent one is replaced", async () => {
    const env = setup();
    openPr(env, 1, { "feature-1/a.txt": "one\n" });
    const leasePath = join(env.dir, "lanes", "coordinator.lock");
    mkdirSync(join(env.dir, "lanes"), { recursive: true });
    let t = 1_000_000;
    writeFileSync(leasePath, JSON.stringify({ pid: 424242, startedAt: t, heartbeatAt: t }));
    const blocked = makeTrain(env, cloneOf(env, "second"), { isProcessAlive: () => true, now: () => t + 1000 });
    await assert.rejects(blocked.run({ maxRounds: 1 }), /coordinator already running \(pid 424242/);
    assert.deepEqual(trainBranches(env), [], "the refused coordinator pushed nothing");

    const deadHolder = makeTrain(env, cloneOf(env, "third"), { isProcessAlive: () => false, now: () => t + 1000 });
    env.provider.autoGate = () => "pending";
    const r1 = await deadHolder.run({ maxRounds: 1, timeoutMs: 0 });
    assert.notEqual(r1.status, "refused");
    t += 10 * 60_000;
    writeFileSync(leasePath, JSON.stringify({ pid: 424242, startedAt: 0, heartbeatAt: 0 }));
    const silent = makeTrain(env, cloneOf(env, "fourth"), { isProcessAlive: () => true, now: () => t });
    await silent.run({ maxRounds: 1, timeoutMs: 0 });
    assert.equal(existsSync(leasePath), false, "the lease is released when run returns");
  });

  test("the coordinator lease is machine-wide: separate clones share one lease path and refuse each other", async () => {
    const env = setup();
    const leasePath = join(env.dir, "machine", "coordinator.lock");
    mkdirSync(join(env.dir, "machine"), { recursive: true });
    const t = 2_000_000;
    // A coordinator in another clone/account (different cwd, its own lanesDir) holds the machine-wide lease.
    writeFileSync(
      leasePath,
      JSON.stringify({ pid: 515151, owner: "other-account", cwd: "C:/kc-wt-mt9", startedAt: t, heartbeatAt: t }),
    );
    const mine = makeTrain(env, cloneOf(env, "mine"), {
      lanesDir: join(env.dir, "my-own-lanes"),
      leasePath,
      isProcessAlive: () => true,
      now: () => t + 1000,
    });
    assert.throws(
      () => mine.acquireLease(),
      /coordinator already running \(pid 515151, owner other-account, in C:\/kc-wt-mt9/,
    );
    assert.throws(
      () => mine.acquireLease(),
      new RegExp(`one coordinator per machine: ${leasePath.replace(/\\/g, "\\\\")}`),
    );
    await assert.rejects(mine.run({ maxRounds: 1 }), /coordinator already running/);
    assert.deepEqual(trainBranches(env), [], "the refused coordinator pushed nothing");

    // The same owner (KALCODE_TRAIN_OWNER) borrows the live lease and never releases it on the holder's behalf.
    const sameOwner = makeTrain(env, cloneOf(env, "same-owner"), {
      leasePath,
      leaseOwner: "other-account",
      isProcessAlive: () => true,
      now: () => t + 2000,
    });
    const borrowed = sameOwner.acquireLease();
    borrowed.beat();
    borrowed();
    const after = JSON.parse(readFileSync(leasePath, "utf8"));
    assert.equal(after.pid, 515151, "the holder keeps its lease");
    assert.equal(after.heartbeatAt, t + 2000, "a borrower keeps the shared lease fresh");

    // A dead holder is replaced; the new record names its owner and checkout, and release frees the path.
    const next = makeTrain(env, cloneOf(env, "next"), {
      leasePath,
      leaseOwner: "kalcode-44",
      isProcessAlive: () => false,
      now: () => t + 3000,
    });
    const release = next.acquireLease();
    const taken = JSON.parse(readFileSync(leasePath, "utf8"));
    assert.equal(taken.pid, process.pid);
    assert.equal(taken.owner, "kalcode-44");
    release();
    assert.equal(existsSync(leasePath), false);
  });

  test("a live coordinator on the old per-checkout lease still blocks the machine-wide lease", async () => {
    const env = setup();
    const lanes = join(env.dir, "lanes");
    mkdirSync(lanes, { recursive: true });
    const t = 3_000_000;
    writeFileSync(join(lanes, "coordinator.lock"), JSON.stringify({ pid: 22644, startedAt: t, heartbeatAt: t }));
    const leasePath = join(env.dir, "machine", "coordinator.lock");
    const mine = makeTrain(env, cloneOf(env, "mine"), { leasePath, isProcessAlive: () => true, now: () => t + 1000 });
    assert.throws(() => mine.acquireLease(), /coordinator already running \(pid 22644/);
    assert.equal(existsSync(leasePath), false, "the refused caller never wrote the machine-wide lease");
    await assert.rejects(mine.run({ maxRounds: 1 }), /coordinator already running/);
    assert.deepEqual(trainBranches(env), [], "nothing was pushed");
    const later = makeTrain(env, cloneOf(env, "later"), {
      leasePath,
      isProcessAlive: () => true,
      now: () => t + 10 * 60_000,
    });
    later.acquireLease()();
  });

  test("machineLeasePath is one fixed path per machine, independent of the checkout", () => {
    assert.equal(
      machineLeasePath({ env: { ProgramData: "C:\\ProgramData" }, platform: "win32" }),
      join("C:\\ProgramData", "KalCode", "merge-train", "coordinator.lock"),
    );
    assert.equal(
      machineLeasePath({ env: {}, platform: "win32" }),
      join("C:\\ProgramData", "KalCode", "merge-train", "coordinator.lock"),
    );
    assert.equal(
      machineLeasePath({ env: {}, platform: "darwin" }),
      join("/Users/Shared/KalCode/merge-train", "coordinator.lock"),
    );
    assert.equal(
      machineLeasePath({ env: { KALCODE_TRAIN_LOCK_DIR: "/x/lock" }, platform: "win32" }),
      join("/x/lock", "coordinator.lock"),
    );
  });

  test("a candidate whose base is no longer main is retired and never re-pushed", async () => {
    const env = setup();
    openPr(env, 1, { "feature-1/a.txt": "one\n" });
    const train = makeTrain(env, cloneOf(env, "coordinator"));
    const first = await train.buildAll();
    env.provider.autoGate = () => "stale";
    const moved = pushMain(env, { "other.txt": "someone else\n" });
    const second = await train.buildAll();
    assert.ok(!trainBranches(env).includes(first.levels[0].branch), "old-base candidate deleted");
    assert.ok(
      trainBranches(env).every((b) => b.startsWith(`merge-train/${moved.slice(0, 12)}-`)),
      "only current-main candidates exist",
    );
    assert.equal(second.levels[0].base, moved);
  });

  test("release-record resolver takes the newest published record and refuses anything more", async () => {
    const env = setup();
    const ok = openPr(env, 1, {
      "apps/website/src/data/releases.json": RELEASES(1658),
      "docs/releases/0.1.9+1658.md": "notes\n",
    });
    const tooMuch = openPr(env, 2, { "apps/website/src/data/releases.json": RELEASES(1700, ["0.1.9+1600"]) });
    const mainNow = pushMain(env, {
      "apps/website/src/data/releases.json": RELEASES(1738),
      "docs/releases/0.1.9+1738.md": "notes\n",
    });
    const train = makeTrain(env, cloneOf(env, "coordinator"), { resolvers: [releaseRecordResolver] });
    const built = await train.buildAll();
    const level = built.levels.find((l) => nums(l.included).includes(1));
    assert.ok(level, "#1 was resolved mechanically");
    const record = JSON.parse(sh(env.origin, ["show", `${level.sha}:apps/website/src/data/releases.json`]));
    assert.equal(record.latest.version, "0.1.9+1738", "main's newer record wins over the PR's older one");
    assert.ok(hasPath(env.origin, level.sha, "docs/releases/0.1.9+1658.md"));
    assert.match(
      sh(env.origin, ["log", "-1", "--format=%B", level.chain?.at?.(-1) ?? level.sha]),
      /Merge-Train-Resolved-By: release-record/,
    );
    const skipped = built.skipped.find((s) => s.number === 2);
    assert.ok(skipped?.reason.startsWith("conflicts"), "a change beyond the release record is never guessed");
    assert.ok(isAncestor(env.origin, mainNow, level.sha));
    assert.ok(ok);
    assert.ok(tooMuch);
  });

  test("a main move of only release records keeps a lane's gate evidence; a website lane or a code move does not", async () => {
    assert.equal(
      deltaPreservesEvidence(["apps/website/src/data/releases.json", "docs/releases/0.1.9+1738.md"], ["crates/x.rs"]),
      true,
    );
    assert.equal(
      deltaPreservesEvidence(["apps/website/src/data/releases.json"], ["apps/website/src/pages/a.astro"]),
      false,
    );
    assert.equal(deltaPreservesEvidence(["crates/y.rs"], ["crates/x.rs"]), false);
    assert.equal(isReleaseRecordPath("docs/releases/0.1.9+1738.md"), true);

    const env = setup();
    openPr(env, 1, { "crates/feature/src/lib.rs": "// one\n" });
    const train = makeTrain(env, cloneOf(env, "coordinator"));
    const first = await train.buildAll();
    env.provider.gates.set(first.levels[0].sha, "success");
    pushMain(
      env,
      { "apps/website/src/data/releases.json": RELEASES(1800), "docs/releases/0.1.9+1800.md": "notes\n" },
      "release(website)",
    );
    const refreshed = await train.buildAll();
    const level = refreshed.levels[0];
    assert.notEqual(level.sha, first.levels[0].sha, "rebuilt on the new main");
    const landed = await train.land(level.branch);
    assert.equal(landed.landed, true, "landed on the equivalent evidence without a new gate");
    assert.match(landed.evidence, /^equivalent:/);

    const env2 = setup();
    openPr(env2, 1, { "crates/feature/src/lib.rs": "// one\n" });
    const train2 = makeTrain(env2, cloneOf(env2, "coordinator"));
    const old = await train2.buildAll();
    env2.provider.gates.set(old.levels[0].sha, "success");
    pushMain(env2, { "crates/other/src/lib.rs": "// code moved main\n" });
    const rebuilt = await train2.buildAll();
    const refused = await train2.land(rebuilt.levels[0].branch);
    assert.equal(refused.landed, false);
    assert.equal(refused.reason, "gate-not-green", "a code move of main always re-gates");
  });
});
