import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  createGitHubProvider,
  gateStateFrom,
  MAIN_PC_GATE_RUNNER,
  PC2_GATE_JOB,
  parseGateLog,
  parseSlug,
  queueFromGraphql,
} from "./github.mjs";
import { releaseKitCommand } from "./on-landed.mjs";
import { assertCandidateWorkflow, candidateBranch, createTrain, parseArgs, QUEUE_LABEL, withLock } from "./train.mjs";

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

let clock = 1_790_000_000;

/** Writes commits straight into a repository with one `git fast-import`; returns their SHAs. */
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

/** An agent's checkout: an empty repository whose origin is the shared bare repository. */
function cloneOf(env, name) {
  const path = join(env.dir, name);
  sh(env.dir, ["init", "-q", path]);
  appendFileSync(
    join(path, ".git", "config"),
    `[remote "origin"]\n\turl = ${env.origin.replaceAll("\\", "/")}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` +
      "[user]\n\tname = Merge Train Test\n\temail = train@example.invalid\n",
  );
  return path;
}

/** A local bare "origin" whose reflog records every main update. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kalcode-merge-train-"));
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
        ".github/workflows/gate.yml": readFileSync(
          new URL("../../.github/workflows/gate.yml", import.meta.url),
          "utf8",
        ),
      },
    },
  ]);
  return { dir, origin, provider: new FakeProvider(origin) };
}

const refLines = (text) => text.split("\n").filter(Boolean);
const originMain = (env) => sh(env.origin, ["rev-parse", "refs/heads/main"]);
const mainUpdates = (env) => refLines(sh(env.origin, ["reflog", "show", "--format=%H", "refs/heads/main"]));
const trainBranches = (env) =>
  refLines(sh(env.origin, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/merge-train/"]));

/** Opens PR #n: a branch off current main (or `from`) with `files` changed, on origin, queued. */
function openPr(env, n, files, { queue = true, from = "refs/heads/main^0" } = {}) {
  const [head] = importCommits(env.origin, [{ ref: `refs/heads/pr-${n}`, from, message: `PR ${n}`, files }]);
  if (!env.provider.prs.has(n)) env.provider.add(n, `PR ${n}`, { queue });
  return head;
}

/** Someone pushes straight to main, bypassing the train. */
function bypassPush(env, files) {
  return importCommits(env.origin, [
    { ref: "refs/heads/main", from: "refs/heads/main^0", message: "bypass", files },
  ])[0];
}

class FakeProvider {
  constructor(origin) {
    this.origin = origin;
    this.prs = new Map();
    this.comments = [];
    this.gates = new Map();
    this.autoGate = null;
    this.prEvidence = new Map();
    this.seq = 0;
    this.cancelled = [];
  }
  add(number, title, { queue = true } = {}) {
    this.prs.set(number, { number, title, open: true, draft: false, queued: queue, order: ++this.seq });
  }
  head(number) {
    return sh(this.origin, ["rev-parse", `refs/heads/pr-${number}`]);
  }
  async listQueue() {
    const heads = new Map(
      refLines(sh(this.origin, ["for-each-ref", "--format=%(refname:strip=2) %(objectname)", "refs/heads/"])).map(
        (line) => line.split(" "),
      ),
    );
    return [...this.prs.values()]
      .filter((p) => p.open && !p.draft && p.queued)
      .sort((a, b) => a.order - b.order)
      .map((p) => ({
        number: p.number,
        title: p.title,
        head: heads.get(`pr-${p.number}`),
        headRef: `pr-${p.number}`,
        fetchRef: `refs/heads/pr-${p.number}`,
      }));
  }
  async getPr(number) {
    const p = this.prs.get(number);
    if (!p) return null;
    return {
      baseRef: "main",
      crossRepository: false,
      ...p,
      head: this.head(number),
      fetchRef: `refs/heads/pr-${number}`,
      mergeRef: `refs/pull/${number}/merge`,
    };
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
  async prGateEvidence(number, head) {
    const evidence = this.prEvidence.get(number);
    return evidence ? { ...evidence } : { state: "missing", head };
  }
  async gateStatus(sha) {
    if (this.gates.has(sha)) return { state: this.gates.get(sha) };
    if (this.autoGate) return { state: this.autoGate(sha) };
    return { state: "missing" };
  }
  async cancelGates(sha, branch) {
    if (["pending", "missing"].includes((await this.gateStatus(sha)).state)) this.cancelled.push({ sha, branch });
  }
  commentsFor(number) {
    return this.comments.filter((c) => c.number === number).map((c) => c.body);
  }
}

function makeTrain(env, repo, extra = {}) {
  const lines = [];
  const train = createTrain({
    repo,
    provider: env.provider,
    log: (line) => lines.push(line),
    lanesDir: join(env.dir, "lanes"),
    mergeLog: join(env.dir, "lanes", "merge-log.md"),
    sleep: async () => {},
    ...extra,
  });
  return Object.assign(train, { lines });
}

const numbers = (items) => items.map((i) => i.number);
const fourIndependent = (env) => [1, 2, 3, 4].map((n) => openPr(env, n, { [`feature-${n}/file.txt`]: `pr ${n}\n` }));

describe("merge train", { concurrency: true }, () => {
  test("six ready agents and concurrent preparations preserve pending groups while admitting new work", async () => {
    const env = setup();
    for (const n of [1, 2, 3]) openPr(env, n, { [`${n}.txt`]: String(n) });
    const firstTrain = makeTrain(env, cloneOf(env, "first"));
    const first = await firstTrain.build();
    env.provider.gates.set(first.candidate, "pending");
    for (const n of [4, 5, 6]) openPr(env, n, { [`${n}.txt`]: String(n) });
    const peers = Array.from({ length: 6 }, (_, n) => makeTrain(env, cloneOf(env, `agent-${n}`)));
    const prepared = await Promise.all(peers.map((train) => train.build()));
    assert.ok(prepared.every((m) => m.base === first.base && numbers(m.included).join() === "4,5,6"));
    assert.equal(new Set(prepared.map((m) => m.candidate)).size, 1);
    assert.equal(trainBranches(env).length, 2);
    assert.equal(sh(env.origin, ["rev-parse", `refs/heads/${first.branch}`]), first.candidate);
    assert.deepEqual(env.provider.cancelled, []);
    const second = prepared[0];
    env.provider.gates.set(second.candidate, "success");
    assert.equal((await peers[0].land(second.branch)).landed, true);
    const refreshed = await firstTrain.build();
    assert.equal(refreshed.base, second.candidate);
    assert.deepEqual(numbers(refreshed.included), [1, 2, 3]);
    assert.deepEqual(env.provider.cancelled, [{ sha: first.candidate, branch: first.branch }]);
  });

  test("a failed group does not delay independent ready work or duplicate a pending bisect half", async () => {
    const env = setup();
    for (const n of [1, 2, 3, 4]) openPr(env, n, { [`${n}.txt`]: String(n) });
    const train = makeTrain(env, cloneOf(env, "agent"));
    const failed = await train.build();
    env.provider.gates.set(failed.candidate, "failure");
    openPr(env, 5, { "five.txt": "independent" });
    openPr(env, 6, { "six.txt": "independent" });
    const independent = await train.build();
    assert.deepEqual(numbers(independent.included), [5, 6]);
    env.provider.gates.set(independent.candidate, "pending");
    const left = await train.build();
    assert.deepEqual(numbers(left.included), [1, 2]);
    env.provider.gates.set(left.candidate, "pending");
    const right = await train.build();
    assert.deepEqual(numbers(right.included), [3, 4]);
    assert.deepEqual(env.provider.cancelled, []);
    env.provider.gates.set(independent.candidate, "success");
    assert.equal((await train.land(independent.branch)).landed, true);
  });

  test("parallel stacked candidates retain dependency heads and refuse a moved dependency while independent work lands", async () => {
    const env = setup();
    const firstHead = openPr(env, 1, { "one.txt": "one" });
    const events = [];
    const train = makeTrain(env, cloneOf(env, "agent"), { onLanded: async (event) => events.push(event) });
    const first = await train.build();
    env.provider.gates.set(first.candidate, "pending");
    openPr(env, 2, { "two.txt": "two" }, { from: firstHead });
    const dependent = await train.build();
    assert.deepEqual(numbers(dependent.included), [1, 2]);
    env.provider.gates.set(dependent.candidate, "pending");
    openPr(env, 3, { "three.txt": "independent" });
    const independent = await train.build();
    assert.deepEqual(numbers(independent.included), [3]);
    openPr(env, 1, { "one.txt": "changed" }, { from: firstHead });
    env.provider.gates.set(dependent.candidate, "success");
    assert.equal((await train.land(dependent.branch)).reason, "stale-pr");
    env.provider.gates.set(independent.candidate, "success");
    assert.equal((await train.land(independent.branch)).landed, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].main, independent.candidate);
    assert.equal(isAncestor(env.origin, firstHead, originMain(env)), false);
  });

  test("a changed PR head cancels only its obsolete pending candidate and keeps independent gates", async () => {
    const env = setup();
    const head = openPr(env, 1, { "one.txt": "one" });
    const train = makeTrain(env, cloneOf(env, "agent"));
    const stale = await train.build();
    env.provider.gates.set(stale.candidate, "pending");
    openPr(env, 2, { "two.txt": "two" });
    const kept = await train.build();
    env.provider.gates.set(kept.candidate, "pending");
    const replacement = openPr(env, 1, { "one.txt": "new one" }, { from: head });
    const refreshed = await train.build();
    assert.deepEqual(
      refreshed.included.map((p) => p.head),
      [replacement],
    );
    assert.deepEqual(env.provider.cancelled, [{ sha: stale.candidate, branch: stale.branch }]);
    assert.ok(trainBranches(env).includes(kept.branch));
  });

  test("uncertain PR fetches never cancel an existing candidate", async () => {
    const env = setup();
    openPr(env, 1, { "one.txt": "one" });
    const train = makeTrain(env, cloneOf(env, "agent"));
    const existing = await train.build();
    env.provider.gates.set(existing.candidate, "pending");
    sh(env.origin, ["update-ref", "-d", "refs/heads/pr-1"]);
    await train.build();
    assert.deepEqual(env.provider.cancelled, []);
    assert.ok(trainBranches(env).includes(existing.branch));
  });

  for (const unavailable of ["head fetch", "queue eligibility"])
    test(`a captured dependency with unavailable ${unavailable} holds only its new child`, async () => {
      const env = setup();
      const parentHead = openPr(env, 1, { "one.txt": "parent" });
      const train = makeTrain(env, cloneOf(env, "agent"));
      const parent = await train.build();
      env.provider.gates.set(parent.candidate, "pending");
      openPr(env, 2, { "two.txt": "child" }, { from: parentHead });
      openPr(env, 3, { "three.txt": "independent" });
      if (unavailable === "head fetch") sh(env.origin, ["update-ref", "-d", "refs/heads/pr-1"]);
      else env.provider.prs.get(1).queued = false;
      const candidate = await train.build();
      assert.deepEqual(numbers(candidate.included), [3]);
      const child = candidate.skipped.find((pr) => pr.number === 2);
      assert.equal(child.reason, "dependency-unavailable");
      assert.deepEqual(child.conflictsWith, [1]);
      if (unavailable === "head fetch") {
        assert.deepEqual(env.provider.cancelled, []);
        assert.ok(trainBranches(env).includes(parent.branch));
      }
      env.provider.gates.set(candidate.candidate, "success");
      assert.equal((await train.land(candidate.branch)).landed, true);
      assert.equal(isAncestor(env.origin, parentHead, originMain(env)), false);
    });

  for (const change of ["PR head", "main"])
    test(`gate polling retires an exact obsolete candidate after ${change} moves`, async () => {
      const env = setup();
      const head = openPr(env, 1, { "one.txt": "one" });
      let moved = false;
      const train = makeTrain(env, cloneOf(env, "agent"), {
        sleep: async () => {
          if (moved) return;
          moved = true;
          if (change === "main") bypassPush(env, { "other.txt": "new main" });
          else openPr(env, 1, { "one.txt": "new one" }, { from: head });
        },
      });
      const candidate = await train.build();
      env.provider.gates.set(candidate.candidate, "pending");
      const result = await train.waitForGate(candidate.candidate, {
        branch: candidate.branch,
        pollMs: 1,
        timeoutMs: 10_000,
      });
      assert.equal(result.state, "stale");
      assert.deepEqual(env.provider.cancelled, [{ sha: candidate.candidate, branch: candidate.branch }]);
      assert.deepEqual(trainBranches(env), []);
    });

  test("a conflicting queued dependency is never implicitly landed through its child", async () => {
    const env = setup();
    const dependency = openPr(env, 1, { "shared.txt": "one\nparent\nthree\n" });
    openPr(
      env,
      2,
      { "shared.txt": "one\nmain\nthree\n", "child.txt": "child resolves conflict" },
      { from: dependency },
    );
    // A child alone would merge cleanly after the main change, silently including the parent.
    bypassPush(env, { "shared.txt": "one\nmain\nthree\n" });
    openPr(env, 3, { "independent.txt": "independent" });
    const manifest = await makeTrain(env, cloneOf(env, "agent")).build();
    assert.deepEqual(numbers(manifest.included), [3]);
    assert.equal(manifest.skipped.find((p) => p.number === 2).reason, "dependency-unavailable");
  });
  test("1: four independent PRs ready together form one candidate containing all four", async () => {
    const env = setup();
    const heads = fourIndependent(env);
    const base = originMain(env);
    const train = makeTrain(env, cloneOf(env, "agent-a"));

    const m = await train.build();
    assert.equal(m.action, "built");
    assert.equal(m.base, base);
    assert.deepEqual(numbers(m.included), [1, 2, 3, 4]);
    assert.deepEqual(
      m.included.map((i) => i.head),
      heads,
    );
    assert.deepEqual(m.skipped, []);
    assert.equal(m.branch, candidateBranch(base, m.included));
    assert.ok(m.branch.startsWith(`merge-train/${base.slice(0, 12)}-`));
    assert.deepEqual(trainBranches(env), [m.branch]);
    assert.equal(sh(env.origin, ["rev-parse", `refs/heads/${m.branch}`]), m.candidate);
    // The candidate is BASE plus one --no-ff merge commit per PR, in queue order, keeping each PR's commits.
    const chain = sh(env.origin, ["rev-list", "--first-parent", "--parents", `${base}..${m.candidate}`]).split("\n");
    assert.equal(chain.length, 4);
    assert.deepEqual(chain.map((l) => l.split(" ")[2]).reverse(), heads);
    assert.equal(chain.at(-1).split(" ")[1], base);
    const manifest = JSON.parse(
      readFileSync(join(env.dir, "lanes", "merge-train", `${m.branch.slice("merge-train/".length)}.json`), "utf8"),
    );
    assert.equal(manifest.candidate, m.candidate);
    assert.equal(manifest.base, base);
    for (const n of [1, 2, 3, 4]) assert.match(env.provider.commentsFor(n).join("\n"), new RegExp(m.branch));
    assert.equal(originMain(env), base, "building never touches main");
  });

  test("2: concurrent preparation on the same main snapshot produces or reuses exactly one candidate", async () => {
    const env = setup();
    fourIndependent(env);
    const a = makeTrain(env, cloneOf(env, "agent-a"));
    const b = makeTrain(env, cloneOf(env, "agent-b"));

    // Two agents in separate checkouts race for real.
    const [ra, rb] = await Promise.all([a.build(), b.build()]);
    assert.equal(ra.branch, rb.branch);
    assert.equal(ra.candidate, rb.candidate);
    assert.deepEqual(numbers(ra.included), [1, 2, 3, 4]);
    assert.deepEqual(trainBranches(env), [ra.branch]);

    // Two coordinators in the same checkout (shared object store and refs) race too.
    const shared = cloneOf(env, "agent-shared");
    const [rc, rd] = await Promise.all([makeTrain(env, shared).build(), makeTrain(env, shared).build()]);
    assert.equal(rc.candidate, ra.candidate);
    assert.equal(rd.candidate, ra.candidate);
    assert.deepEqual(trainBranches(env), [ra.branch]);
    assert.equal(sh(shared, ["for-each-ref", "refs/merge-train/"]), "", "private refs are cleaned up");
  });

  test("2b: the worst interleaving (both decide to create, the other pushes first) reuses the winner", async () => {
    const env = setup();
    fourIndependent(env);
    const b = makeTrain(env, cloneOf(env, "agent-b"));
    let winner = null;
    const a = makeTrain(env, cloneOf(env, "agent-a"), {
      hooks: {
        beforePush: async () => {
          winner = await b.build();
        },
      },
    });
    const ra = await a.build();
    assert.equal(winner.action, "built");
    assert.equal(ra.action, "reused");
    assert.equal(ra.candidate, winner.candidate);
    assert.deepEqual(trainBranches(env), [winner.branch]);
    assert.equal(sh(env.origin, ["rev-parse", `refs/heads/${winner.branch}`]), winner.candidate);
  });

  test("3: compatible PRs land in one fast-forward main update containing every PR head", async () => {
    const env = setup();
    const heads = fourIndependent(env);
    const base = originMain(env);
    const before = mainUpdates(env).length;
    const train = makeTrain(env, cloneOf(env, "agent-a"));
    const m = await train.build();
    env.provider.gates.set(m.candidate, "success");

    const r = await train.land(m.branch);
    assert.equal(r.landed, true);
    assert.equal(originMain(env), m.candidate);
    assert.equal(mainUpdates(env).length, before + 1, "exactly one update of main");
    assert.ok(isAncestor(env.origin, base, originMain(env)), "fast-forward");
    for (const head of heads) assert.ok(isAncestor(env.origin, head, originMain(env)));
    for (const n of [1, 2, 3, 4]) {
      assert.equal(env.provider.prs.get(n).queued, false, `#${n} leaves the queue`);
      assert.match(env.provider.commentsFor(n).at(-1), new RegExp(`Landed in main ${m.candidate} via merge train`));
    }
    assert.deepEqual(trainBranches(env), [], "the landed candidate branch is removed");
    assert.equal((await train.build()).action, "idle");
  });

  test("4: a PR that conflicts with another queued PR is skipped with reason and files; the other three land", async () => {
    const env = setup();
    openPr(env, 1, { "shared.txt": "one\nTWO from #1\nthree\n" });
    openPr(env, 2, { "feature-2.txt": "two\n" });
    const conflicting = openPr(env, 3, { "shared.txt": "one\nTWO from #3\nthree\n" });
    openPr(env, 4, { "feature-4.txt": "four\n" });
    const train = makeTrain(env, cloneOf(env, "agent-a"));

    const m = await train.build();
    assert.deepEqual(numbers(m.included), [1, 2, 4]);
    assert.deepEqual(m.skipped, [
      { number: 3, head: conflicting, reason: "conflicts-with-batch", files: ["shared.txt"], conflictsWith: [1] },
    ]);
    const note = env.provider.commentsFor(3).join("\n");
    assert.match(note, /conflicts with #1/);
    assert.match(note, /`shared\.txt`/);

    env.provider.gates.set(m.candidate, "success");
    assert.equal((await train.land(m.branch)).landed, true);
    for (const n of [1, 2, 4]) assert.ok(isAncestor(env.origin, env.provider.head(n), originMain(env)));
    assert.ok(!isAncestor(env.origin, conflicting, originMain(env)));
    assert.equal(env.provider.prs.get(3).queued, true, "a skipped PR keeps its place and retries automatically");

    // Next train: #3 now conflicts with main itself, which is reported once per head, not on every run.
    const next = await train.build();
    assert.equal(next.action, "idle");
    assert.equal(next.skipped[0].reason, "conflicts-with-main");
    assert.deepEqual(next.skipped[0].files, ["shared.txt"]);
    const count = env.provider.commentsFor(3).length;
    await train.build();
    assert.equal(env.provider.commentsFor(3).length, count);
  });

  test("5: a bypass push to main during gating makes land refuse atomically, and run rebuilds on the new main", async () => {
    const env = setup();
    const heads = fourIndependent(env);
    const train = makeTrain(env, cloneOf(env, "agent-a"));
    const m = await train.build();
    env.provider.gates.set(m.candidate, "success");

    const bypass = bypassPush(env, { "hotfix.txt": "direct\n" });
    const refused = await train.land(m.branch);
    assert.equal(refused.landed, false);
    assert.equal(refused.reason, "main-moved");
    assert.equal(originMain(env), bypass, "main is untouched");

    // The lease, not the pre-check, is what makes the update atomic: main moves between check and push.
    const m2 = await train.build();
    assert.equal(m2.base, bypass);
    env.provider.gates.set(m2.candidate, "success");
    let racer = null;
    const leased = makeTrain(env, cloneOf(env, "agent-b"), {
      hooks: {
        beforeLandPush: async () => {
          racer = bypassPush(env, { "hotfix-2.txt": "direct again\n" });
        },
      },
    });
    const r2 = await leased.land(m2.branch);
    assert.equal(r2.reason, "main-moved");
    assert.equal(originMain(env), racer);

    env.provider.autoGate = () => "success";
    const run = await train.run();
    assert.equal(run.status, "idle");
    assert.equal(run.landed.length, 1);
    const main = originMain(env);
    assert.equal(run.landed[0].main, main);
    assert.equal(run.landed[0].base, racer);
    for (const head of [...heads, bypass, racer]) assert.ok(isAncestor(env.origin, head, main));
  });

  test("6: land refuses unless the gate succeeded for the exact candidate SHA", async () => {
    const env = setup();
    const heads = fourIndependent(env);
    const base = originMain(env);
    const train = makeTrain(env, cloneOf(env, "agent-a"));
    const m = await train.build();

    // Green gates on other commits (a PR head, main itself) are not evidence for the candidate.
    for (const sha of [heads[0], base]) env.provider.gates.set(sha, "success");
    for (const state of [null, "pending", "failure", "stale"]) {
      if (state) env.provider.gates.set(m.candidate, state);
      const r = await train.land(m.branch);
      assert.equal(r.landed, false);
      assert.equal(r.reason, "gate-not-green");
      assert.equal(originMain(env), base);
    }

    // A branch that merely looks like a candidate (no train structure) is never landed, even when green.
    const forged = `merge-train/${base.slice(0, 12)}-deadbeef`;
    sh(env.origin, ["update-ref", `refs/heads/${forged}`, heads[0]]);
    env.provider.gates.set(heads[0], "success");
    assert.equal((await train.land(forged)).reason, "invalid-candidate");
    assert.equal((await train.land("feature/not-a-train")).reason, "invalid-candidate");
    assert.equal(originMain(env), base);

    env.provider.gates.set(m.candidate, "success");
    assert.equal((await train.land(m.branch)).landed, true);
  });

  test("7: a successful land emits SHIP and calls the on-landed hook with the new main SHA", async () => {
    const env = setup();
    fourIndependent(env);
    const events = [];
    const train = makeTrain(env, cloneOf(env, "agent-a"), { onLanded: async (event) => events.push(event) });
    const m = await train.build();
    env.provider.gates.set(m.candidate, "success");
    const r = await train.land(m.branch);

    const main = originMain(env);
    assert.equal(r.main, main);
    assert.equal(events.length, 1);
    assert.equal(events[0].main, main);
    assert.deepEqual(numbers(events[0].included), [1, 2, 3, 4]);
    assert.ok(train.lines.includes(`SHIP ${main}`));
    const log = readFileSync(join(env.dir, "lanes", "merge-log.md"), "utf8");
    assert.match(log, new RegExp(`\\| merge-train \\| LANDED ${main} SHIP \\| ${m.branch.replace("/", "\\/")}`));
    assert.match(log, /#1@[0-9a-f]{12} #2@/);
  });

  test("a hook failure never undoes a landing", async () => {
    const env = setup();
    openPr(env, 1, { "a.txt": "a\n" });
    const train = makeTrain(env, cloneOf(env, "agent-a"), {
      onLanded: async () => {
        throw new Error("kit offline");
      },
    });
    const m = await train.build();
    env.provider.gates.set(m.candidate, "success");
    const r = await train.land(m.branch);
    assert.equal(r.landed, true);
    assert.equal(r.hookError, "kit offline");
    assert.equal(originMain(env), m.candidate);
  });

  test("a PR pushed to after its candidate was built is not landed; run lands its new head instead", async () => {
    const env = setup();
    openPr(env, 1, { "a.txt": "a\n" });
    openPr(env, 2, { "b.txt": "b\n" });
    const train = makeTrain(env, cloneOf(env, "agent-a"));
    const m = await train.build();
    env.provider.gates.set(m.candidate, "success");

    const newHead = openPr(env, 2, { "b.txt": "b, reviewed\n" }, { from: "refs/heads/pr-2^0" });

    const r = await train.land(m.branch);
    assert.equal(r.reason, "stale-pr");
    assert.match(r.detail, /#2 moved/);
    env.provider.autoGate = () => "success";
    const run = await train.run();
    assert.equal(run.landed.length, 1);
    assert.ok(isAncestor(env.origin, newHead, originMain(env)));
  });

  test("a PR that conflicts with main alone is attributed to main", async () => {
    const env = setup();
    const head = openPr(env, 1, { "shared.txt": "one\nTWO from #1\nthree\n" });
    bypassPush(env, { "shared.txt": "one\nTWO on main\nthree\n" });
    openPr(env, 2, { "b.txt": "b\n" });
    const m = await makeTrain(env, cloneOf(env, "agent-a")).build();
    assert.deepEqual(numbers(m.included), [2]);
    assert.deepEqual(m.skipped, [
      { number: 1, head, reason: "conflicts-with-main", files: ["shared.txt"], conflictsWith: [] },
    ]);
    assert.match(env.provider.commentsFor(1).join("\n"), /conflicts with main/);
  });

  test("a failing gate bisects: the good PR lands and the failing one is ejected without blocking it", async () => {
    const env = setup();
    const good = openPr(env, 1, { "a.txt": "a\n" });
    const bad = openPr(env, 2, { "b.txt": "breaks the gate\n" });
    env.provider.autoGate = (sha) => (isAncestor(env.origin, bad, sha) ? "failure" : "success");
    const train = makeTrain(env, cloneOf(env, "agent-a"));

    const run = await train.run();
    assert.equal(run.status, "idle");
    assert.equal(run.landed.length, 1);
    assert.deepEqual(numbers(run.landed[0].included), [1]);
    assert.ok(isAncestor(env.origin, good, originMain(env)));
    assert.ok(!isAncestor(env.origin, bad, originMain(env)));
    assert.equal(env.provider.prs.get(2).queued, false);
    assert.match(env.provider.commentsFor(2).join("\n"), /Removed from the merge queue: the gate failed/);

    // Resubmitting the same head gets a fresh gate (the failed single-PR candidate was retired).
    env.provider.autoGate = () => "success";
    await train.submit(2);
    const again = await train.run();
    assert.equal(again.landed.length, 1);
    assert.ok(isAncestor(env.origin, bad, originMain(env)));
  });

  test("a candidate whose gate was cancelled is re-pushed so the gate runs again", async () => {
    const env = setup();
    openPr(env, 1, { "a.txt": "a\n" });
    const train = makeTrain(env, cloneOf(env, "agent-a"));
    const first = await train.build();
    env.provider.gates.set(first.candidate, "stale");
    const second = await train.build();
    assert.equal(second.action, "built");
    assert.equal(second.branch, first.branch);
    assert.notEqual(second.candidate, first.candidate);
  });

  test("stale gates are cancelled: a candidate on an older main or with a moved PR stops gating and is deleted", async () => {
    const env = setup();
    openPr(env, 1, { "a.txt": "a\n" });
    openPr(env, 2, { "b.txt": "b\n" });
    const train = makeTrain(env, cloneOf(env, "agent-a"));
    const m1 = await train.build();
    env.provider.gates.set(m1.candidate, "pending");

    const bypass = bypassPush(env, { "hotfix.txt": "direct\n" });
    const m2 = await train.build();
    assert.equal(m2.base, bypass);
    assert.deepEqual(env.provider.cancelled, [{ sha: m1.candidate, branch: m1.branch }]);
    assert.deepEqual(trainBranches(env), [m2.branch], "the superseded candidate branch is gone");
    env.provider.gates.set(m2.candidate, "pending");

    // A new commit on #1 makes the pending candidate unlandable: it is cancelled and rebuilt with the new head.
    const moved = importCommits(env.origin, [
      { ref: "refs/heads/pr-1", from: "refs/heads/pr-1^0", message: "PR 1 again", files: { "a.txt": "a2\n" } },
    ])[0];
    const m3 = await train.build();
    assert.equal(m3.action, "built");
    assert.equal(m3.included.find((i) => i.number === 1).head, moved);
    assert.deepEqual(env.provider.cancelled.at(-1), { sha: m2.candidate, branch: m2.branch });
    assert.match(train.lines.join("\n"), /retiring .*: queued PR head or eligibility changed/);
    assert.deepEqual(trainBranches(env), [m3.branch]);

    // A fresh candidate is never cancelled: rebuilding reuses it.
    env.provider.gates.set(m3.candidate, "pending");
    const count = env.provider.cancelled.length;
    assert.equal((await train.build()).action, "reused");
    assert.equal(env.provider.cancelled.length, count);
  });

  test("six agents finishing together: one candidate, five land, the failing PR is ejected without blocking them", async () => {
    const env = setup();
    const heads = [1, 2, 3, 4, 5, 6].map((n) =>
      openPr(env, n, { [`feature-${n}/file.txt`]: `pr ${n}\n` }, { queue: false }),
    );
    const agents = [1, 2, 3, 4, 5, 6].map((n) => makeTrain(env, cloneOf(env, `agent-${n}`)));

    // Six agents submit at the same moment, then six coordinators prepare at the same moment.
    await Promise.all(agents.map((a, i) => a.submit(i + 1)));
    assert.equal((await env.provider.listQueue()).length, 6);
    const built = await Promise.all(agents.map((a) => a.build()));
    assert.equal(new Set(built.map((m) => m.candidate)).size, 1, "every coordinator agrees on one candidate");
    assert.deepEqual(numbers(built[0].included), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(trainBranches(env), [built[0].branch]);

    const bad = heads[3];
    env.provider.autoGate = (sha) => (isAncestor(env.origin, bad, sha) ? "failure" : "success");
    const before = mainUpdates(env).length;
    const run = await agents[0].run();
    assert.equal(run.status, "idle");
    const main = originMain(env);
    for (const [i, head] of heads.entries()) assert.equal(isAncestor(env.origin, head, main), i !== 3, `#${i + 1}`);
    assert.deepEqual(numbers(run.landed.flatMap((l) => l.included)).sort(), [1, 2, 3, 5, 6]);
    assert.ok(mainUpdates(env).length - before <= 2, "the five good PRs land in at most two main updates");
    assert.equal(env.provider.prs.get(4).queued, false);
    assert.deepEqual(trainBranches(env), [], "no candidate is left behind");
  });

  test("auto-resolver seam: a registered resolver may resolve a conflict; none means skip", async () => {
    const env = setup();
    openPr(env, 1, { "shared.txt": "one\nTWO from #1\nthree\n" });
    openPr(env, 2, { "shared.txt": "one\nTWO from #2\nthree\n" });
    const seen = [];
    const train = makeTrain(env, cloneOf(env, "agent-a"), {
      resolvers: [
        {
          name: "take-batch",
          resolve: async ({ git, tip, files }) => {
            seen.push(files);
            return (await git(["rev-parse", `${tip}^{tree}`])).stdout.trim();
          },
        },
      ],
    });
    const m = await train.build();
    assert.deepEqual(seen, [["shared.txt"]]);
    assert.deepEqual(numbers(m.included), [1, 2]);
    assert.match(sh(env.origin, ["log", "-1", "--format=%B", m.candidate]), /Merge-Train-Resolved-By: take-batch/);
  });

  test("submit labels a ready PR and refuses drafts", async () => {
    const env = setup();
    openPr(env, 1, { "a.txt": "a\n" }, { queue: false });
    openPr(env, 2, { "b.txt": "b\n" }, { queue: false });
    env.provider.prs.get(2).draft = true;
    const train = makeTrain(env, cloneOf(env, "agent-a"));
    const r = await train.submit(1);
    assert.equal(r.position, 1);
    assert.equal(env.provider.prs.get(1).queued, true);
    await assert.rejects(train.submit(2), /draft/);
    const s = await train.status();
    assert.deepEqual(numbers(s.queue), [1]);
  });
});

describe("review regressions", () => {
  test("a second train lands after the first train's merge-commit base", async () => {
    const env = setup();
    const train = makeTrain(env, cloneOf(env, "coordinator"));
    openPr(env, 1, { "first.txt": "first\n" });
    const first = await train.build();
    env.provider.gates.set(first.candidate, "success");
    assert.equal((await train.land(first.branch)).landed, true);
    openPr(env, 2, { "second.txt": "second\n" });
    const second = await train.build();
    assert.equal(second.base, first.candidate);
    const parsed = await train.parseCandidate(second.branch, second.candidate);
    assert.equal(parsed.base, first.candidate);
    assert.deepEqual(numbers(parsed.included), [2]);
    env.provider.gates.set(second.candidate, "success");
    assert.equal((await train.land(second.branch)).landed, true);
    assert.equal(originMain(env), second.candidate);
  });

  for (const mutation of [{ draft: true }, { baseRef: "release" }, { crossRepository: true }]) {
    test(`final landing refuses changed PR eligibility ${JSON.stringify(mutation)}`, async () => {
      const env = setup();
      openPr(env, 1, { "feature.txt": "feature\n" });
      const train = makeTrain(env, cloneOf(env, "coordinator"));
      const built = await train.build();
      env.provider.gates.set(built.candidate, "success");
      Object.assign(env.provider.prs.get(1), mutation);
      const result = await train.land(built.branch);
      assert.equal(result.landed, false);
      assert.equal(result.reason, "stale-pr");
      assert.equal(originMain(env), built.base);
    });
  }
});

describe("merge train pieces", () => {
  test("gate evidence binds exact candidate push, main-PC runner and executed Gate step", () => {
    const sha = "a".repeat(40);
    const branch = "merge-train/aaaaaaaaaaaa-12345678";
    const run = {
      id: 1,
      html_url: "u",
      head_sha: sha,
      head_branch: branch,
      event: "push",
      path: ".github/workflows/gate.yml",
    };
    const job = {
      name: "Gate (Windows)",
      status: "completed",
      conclusion: "success",
      head_sha: sha,
      runner_name: "kalcode-win-gate",
      labels: ["self-hosted", "Windows", "kalcode-gate"],
      steps: [{ name: "Gate", status: "completed", conclusion: "success" }],
    };
    const check = (r = run, j = job) => gateStateFrom([r], [j], sha, branch).state;
    assert.equal(check(), "success");
    for (const number of [1, 2, 3, 4, 5]) {
      const pooled = {
        ...job,
        runner_name: `kalcode-win-gate-w${number}`,
        labels: [...job.labels, "kalcode-main-pc"],
      };
      assert.equal(check(run, pooled), "success");
      assert.equal(check(run, { ...pooled, labels: job.labels }), "stale");
      assert.equal(check(run, { ...pooled, labels: ["self-hosted", "kalcode-gate", "kalcode-main-pc"] }), "stale");
    }
    assert.equal(gateStateFrom([], [], sha, branch).state, "missing");
    assert.equal(gateStateFrom([run], [], sha, branch).state, "pending");
    for (const wrong of [
      { event: "pull_request" },
      { head_sha: "b".repeat(40) },
      { head_branch: "merge-train/bbbbbbbbbbbb-12345678" },
      { path: ".github/workflows/other.yml" },
      { head_branch: "main" },
    ])
      assert.notEqual(check({ ...run, ...wrong }), "success");
    for (const wrong of [
      { head_sha: "b".repeat(40) },
      { runner_name: "kalcode-win-gate-2" },
      { runner_name: "kalcode-win-gate-w6", labels: [...job.labels, "kalcode-main-pc"] },
      { runner_name: "kalcode-win-gate-w9", labels: [...job.labels, "kalcode-main-pc"] },
      { runner_name: "kalcode-win-gate-worker-2", labels: [...job.labels, "kalcode-main-pc"] },
      { runner_name: "kalcode-win-gate-w10" },
      { runner_name: "kalcode-win-gate-w0" },
      { runner_name: "x-kalcode-win-gate" },
      { runner_name: undefined },
      { labels: [...job.labels, "kalcode-gate-2-retired"] },
      { labels: ["kalcode-gate-2"] },
      { labels: ["kalcode-gate", "kalcode-gate-2"] },
      { steps: [] },
      { steps: [{ name: "Gate", status: "completed", conclusion: "skipped" }] },
    ])
      assert.notEqual(check(run, { ...job, ...wrong }), "success");
    assert.equal(check(run, { ...job, status: "in_progress", conclusion: null }), "pending");
    assert.equal(check(run, { ...job, conclusion: "failure" }), "failure");
    assert.equal(check(run, { ...job, conclusion: "cancelled" }), "stale");
  });

  test("a split gate lands only when both PCs' jobs passed for the exact candidate", () => {
    // Owner, 2026-10-05: tests run partly on the build PC's pool and partly on the second Windows PC.
    const sha = "a".repeat(40);
    const branch = "merge-train/aaaaaaaaaaaa-12345678";
    const run = {
      id: 1,
      html_url: "u",
      head_sha: sha,
      head_branch: branch,
      event: "push",
      path: ".github/workflows/gate.yml",
    };
    const executed = [{ name: "Gate", status: "completed", conclusion: "success" }];
    const main = {
      name: "Gate (Windows)",
      status: "completed",
      conclusion: "success",
      head_sha: sha,
      runner_name: "kalcode-win-gate-w3",
      labels: ["self-hosted", "Windows", "kalcode-gate", "kalcode-main-pc"],
      steps: executed,
    };
    const pc2 = {
      name: PC2_GATE_JOB,
      status: "completed",
      conclusion: "success",
      head_sha: sha,
      runner_name: "kalcode-win-gate-2",
      labels: ["self-hosted", "Windows", "X64", "kalcode-gate-pc2"],
      steps: executed,
    };
    const state = (...jobs) => gateStateFrom([run], jobs, sha, branch).state;
    assert.equal(state(main, pc2), "success", "both halves green");
    assert.equal(state(main), "success", "a legacy single-job run keeps single-job evidence");
    assert.equal(state(main, { ...pc2, conclusion: "failure" }), "failure", "a red second-PC half refuses");
    assert.equal(state({ ...main, conclusion: "failure" }, pc2), "failure", "a red build-PC half refuses");
    assert.equal(state(main, { ...pc2, status: "queued", conclusion: null }), "pending", "a missing result waits");
    assert.equal(state(main, { ...pc2, status: "in_progress", conclusion: null }), "pending");
    assert.equal(state(main, pc2, { ...pc2 }), "stale", "two second-PC jobs are ambiguous");
    assert.equal(state(main, { ...pc2, head_sha: "b".repeat(40) }), "stale", "another commit is not evidence");
    assert.equal(state(main, { ...pc2, runner_name: "kalcode-win-gate-w1" }), "stale", "only the second PC's runner");
    assert.equal(
      state(main, { ...pc2, labels: ["self-hosted", "Windows", "kalcode-gate-pc2", "kalcode-main-pc"] }),
      "stale",
    );
    assert.equal(state(main, { ...pc2, labels: ["self-hosted", "Windows", "kalcode-gate"] }), "stale");
    assert.equal(
      state(main, { ...pc2, steps: [{ name: "Gate", status: "completed", conclusion: "skipped" }] }),
      "stale",
    );
    assert.equal(state(main, { ...pc2, conclusion: "cancelled" }), "stale");
    assert.equal(state({ ...pc2, name: "Gate (Windows)" }), "stale", "the second PC never satisfies the build-PC half");
  });

  test("the canonical registry includes exactly the original worker and five additional slots", () => {
    for (const name of ["kalcode-win-gate", ...[1, 2, 3, 4, 5].map((slot) => `kalcode-win-gate-w${slot}`)])
      assert.ok(MAIN_PC_GATE_RUNNER.test(name), name);
    for (const name of [
      "kalcode-win-gate-2",
      "kalcode-win-gate-w0",
      "kalcode-win-gate-w6",
      "kalcode-win-gate-w9",
      "kalcode-win-gate-worker-2",
      "x-kalcode-win-gate",
    ])
      assert.equal(MAIN_PC_GATE_RUNNER.test(name), false, name);
  });

  test("PR gate evidence is read from the job log, and a vacuous pass is visible", () => {
    const merge = "1".repeat(40);
    const head = "2".repeat(40);
    const base = "3".repeat(40);
    const log = [
      `2026-10-04T22:09:51Z [command]git -c protocol.version=2 fetch origin +refs/heads/*:refs/remotes/origin/* +${merge}:refs/remotes/pull/197/merge`,
      `2026-10-04T22:09:52Z HEAD is now at 1111111 Merge ${head} into ${base}`,
      "2026-10-04T22:10:22Z gate: lanes desktop (targets desktop); 42 changed file(s) vs 3333",
    ].join("\n");
    assert.deepEqual(parseGateLog(log, 197), {
      testedMerge: merge,
      testedHead: head,
      testedBase: base,
      changedFiles: 42,
    });
    assert.equal(parseGateLog(log, 19).testedMerge, null, "another PR's merge ref is not evidence");
    const vacuous = log.replace("lanes desktop (targets desktop); 42", "lanes none; 0");
    assert.equal(parseGateLog(vacuous, 197).changedFiles, 0);
    assert.equal(parseGateLog("no gate here", 197).changedFiles, 0);
  });

  test("the queue is ordered by label time and excludes drafts, forks and other bases", () => {
    const node = (number, at, extra = {}) => ({
      number,
      title: `t${number}`,
      isDraft: false,
      isCrossRepository: false,
      baseRefName: "main",
      headRefName: `b${number}`,
      headRefOid: "a".repeat(40),
      timelineItems: { nodes: [{ createdAt: at, label: { name: QUEUE_LABEL } }] },
      ...extra,
    });
    const data = {
      data: {
        repository: {
          pullRequests: {
            nodes: [
              node(5, "2026-10-04T10:00:00Z"),
              node(3, "2026-10-04T09:00:00Z"),
              node(4, "2026-10-04T08:00:00Z", { isDraft: true }),
              node(6, "2026-10-04T08:00:00Z", { isCrossRepository: true }),
              node(7, "2026-10-04T08:00:00Z", { baseRefName: "release" }),
            ],
          },
        },
      },
    };
    const queue = queueFromGraphql(data);
    assert.deepEqual(numbers(queue), [3, 5]);
    assert.equal(queue[0].fetchRef, "refs/pull/3/head");
  });

  test("slugs, arguments, the release kit command and the local lock", async () => {
    assert.equal(parseSlug("https://github.com/kalebcampbell2305/KalCode.git\n"), "kalebcampbell2305/KalCode");
    assert.equal(parseSlug("git@github.com:kalebcampbell2305/KalCode.git"), "kalebcampbell2305/KalCode");
    assert.deepEqual(parseArgs(["land", "merge-train/x"]).positional, ["merge-train/x"]);
    assert.equal(parseArgs(["run", "--timeout-min", "30"]).timeoutMin, 30);
    assert.throws(() => parseArgs(["land"]), /usage/);
    assert.throws(() => parseArgs(["merge", "1"]), /usage/);
    assert.equal(
      releaseKitCommand({ main: "f".repeat(40), mainCheckout: "C:\\Users\\Kaleb\\Downloads\\KalCode", kit: "C:\\kit" }),
      `& 'C:\\kit${process.platform === "win32" ? "\\" : "/"}prepare-release.ps1' -Commit ${"f".repeat(40)} -Repo 'C:\\Users\\Kaleb\\Downloads\\KalCode'`,
    );
    const dir = mkdtempSync(join(tmpdir(), "kalcode-merge-train-lock-"));
    temps.push(dir);
    const lock = join(dir, "main-update.lock");
    const order = [];
    await Promise.all([
      withLock(
        lock,
        async () => {
          order.push("a+");
          await new Promise((r) => setTimeout(r, 50));
          order.push("a-");
        },
        { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      ),
      withLock(
        lock,
        async () => {
          order.push("b+");
          order.push("b-");
        },
        { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      ),
    ]);
    assert.deepEqual(order, ["a+", "a-", "b+", "b-"]);
  });

  test("gate.yml gates merge-train candidates against their recorded base, never fork code", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    assert.match(workflow, /push:\n(?:\s+#.*\n)*\s+branches: \[main, "merge-train\/\*\*"\]/);
    assert.match(
      workflow,
      /if: github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    );
    assert.match(workflow, /runs-on: \[self-hosted, Windows, kalcode-gate, kalcode-main-pc\]\n/);
    assert.match(workflow, /name: Plan change-based gate/);
    assert.match(workflow, /Assert-GateWorkerHost/);
    assert.ok(workflow.includes("'^kalcode-win-gate(-w[1-5])?$'"));
    assert.match(workflow, /Runner name does not match its configured slot/);
    assert.match(
      workflow,
      /--base \$env:KALCODE_GATE_BASE --only \$env:KALCODE_GATE_ONLY --jobs \$env:KALCODE_GATE_JOBS --keep-going/,
    );
    // The split: the second PC's half gates the same exact candidate and recorded base.
    assert.match(workflow, /name: Gate \(Windows, PC2\)/);
    assert.match(workflow, /runs-on: \[self-hosted, Windows, kalcode-gate-pc2\]\n/);
    assert.match(workflow, /gate-split\.mjs main/);
    assert.match(workflow, /gate-split\.mjs pc2/);
    assert.match(workflow, /github\.event\.pull_request\.base\.sha/);
    assert.match(workflow, /%\(trailers:key=Merge-Train-Base,valueonly\)/);
    assert.match(workflow, /--keep-going/);
  });
});

test("PR-specific landing is refused even with a valid queued PR", async () => {
  const env = setup();
  openPr(env, 1, { "a.txt": "a" });
  const before = originMain(env);
  const train = makeTrain(env, cloneOf(env, "coordinator"));
  await assert.rejects(train.landPr(1), /disabled/);
  assert.throws(() => parseArgs(["land", "--pr", "1"]), /disabled/);
  assert.equal(originMain(env), before);
  assert.deepEqual(trainBranches(env), []);
});
test("bootstrap refuses pushing a candidate with no usable main-PC push workflow", async () => {
  const workflow = readFileSync(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8");
  assert.doesNotThrow(() => assertCandidateWorkflow(workflow));
  for (const invalid of [
    "",
    workflow.replace('"merge-train/**"', '"unrelated/**"'),
    workflow.replace(/Windows, kalcode-gate(?:, kalcode-main-pc)?\]/, "Windows, kalcode-gate-2]"),
    workflow.replace("trailers:key=Merge-Train-Base,valueonly", "wrong-base"),
    workflow.replace(
      "runs-on: [self-hosted, Windows, kalcode-gate-pc2]",
      "runs-on: [self-hosted, Windows, kalcode-gate-2]",
    ),
  ]) {
    const env = setup();
    openPr(env, 1, { ".github/workflows/gate.yml": invalid });
    const before = originMain(env);
    const train = makeTrain(env, cloneOf(env, "coordinator"));
    await assert.rejects(train.build(), /candidate gate workflow/);
    assert.equal(originMain(env), before);
    assert.deepEqual(trainBranches(env), []);
  }
});
test("bootstrap retains portable Windows build tools and their cleanup", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8");
  for (const script of ["prepare-desktop-python.ps1", "prepare-portable-cmake.ps1"]) {
    assert.ok(workflow.includes(`run: .github/scripts/${script}`));
    assert.ok(workflow.includes(`run: .github/scripts/${script} -Cleanup`));
  }
});

test("GitHub gate adapter passes candidate SHA and branch to provenance validation", async () => {
  const sha = "a".repeat(40);
  const branch = "merge-train/aaaaaaaaaaaa-12345678";
  const run = { id: 1, head_sha: sha, head_branch: branch, event: "push", path: ".github/workflows/gate.yml" };
  const job = {
    name: "Gate (Windows)",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    runner_name: "kalcode-win-gate",
    labels: ["self-hosted", "Windows", "kalcode-gate"],
    steps: [{ name: "Gate", status: "completed", conclusion: "success" }],
  };
  const provider = await createGitHubProvider({
    repo: ".",
    slug: "fixture/repository",
    gh: async (args) => ({
      stdout: JSON.stringify(args[1].includes("/jobs?") ? { jobs: [job] } : { workflow_runs: [run] }),
    }),
  });
  assert.equal((await provider.gateStatus(sha, branch)).state, "success");
  assert.equal((await provider.gateStatus(sha, "merge-train/bbbbbbbbbbbb-12345678")).state, "missing");
  job.steps[0].conclusion = "skipped";
  assert.equal((await provider.gateStatus(sha, branch)).state, "stale");
});

test("GitHub cancellation binds exact candidate push and rechecks status without canceling completed or other runs", async () => {
  const sha = "a".repeat(40);
  const branch = "merge-train/aaaaaaaaaaaa-12345678";
  const base = {
    head_sha: sha,
    head_branch: branch,
    event: "push",
    path: ".github/workflows/gate.yml",
    status: "queued",
  };
  const runs = [
    { ...base, id: 1 },
    { ...base, id: 2, status: "completed" },
    { ...base, id: 3, head_branch: "merge-train/bbbbbbbbbbbb-12345678" },
    { ...base, id: 4, event: "pull_request" },
    { ...base, id: 5, head_sha: "b".repeat(40) },
    { ...base, id: 6, path: ".github/workflows/other.yml" },
    { ...base, id: 7 },
    { ...base, id: 8 },
    { ...base, id: 9, status: "unknown" },
  ];
  const mutations = [];
  const provider = await createGitHubProvider({
    repo: ".",
    slug: "fixture/repository",
    gh: async (args) => {
      if (args.includes("POST")) {
        mutations.push(args.at(-1));
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[1].includes("/runs?")) return { stdout: JSON.stringify({ workflow_runs: runs }) };
      const id = Number(args[1].split("/").at(-1));
      const run = { ...runs.find((r) => r.id === id) };
      if (id === 7) run.status = "completed";
      if (id === 8) run.head_sha = "b".repeat(40);
      return { stdout: JSON.stringify(run) };
    },
  });
  assert.deepEqual(await provider.cancelGates(sha, branch), [1]);
  assert.deepEqual(mutations, ["repos/fixture/repository/actions/runs/1/cancel"]);
});
