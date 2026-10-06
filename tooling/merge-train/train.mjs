#!/usr/bin/env node
// KalCode's shared merge train (AGENTS.md "high-concurrency merge + release architecture"). Every agent, Claude Code or
// Codex, lands work on main only through this train:
//
//   node tooling/merge-train/train.mjs submit <pr>       queue a validated PR (adds the `merge-queue` label)
//   node tooling/merge-train/train.mjs plan [--json]     partition the queue into independent lanes on today's main
//   node tooling/merge-train/train.mjs build             build every lane as stacked exact candidates (they gate concurrently)
//   node tooling/merge-train/train.mjs land <branch>     fast-forward main to a candidate whose exact SHA gated green
//   node tooling/merge-train/train.mjs run               one coordinator: build all lanes, land the deepest green level, repeat
//   node tooling/merge-train/train.mjs status [--json]   queue, candidates and their gate state
//
// Shared state lives only on GitHub: the queue is the open, non-draft, same-repository PRs labelled
// `merge-queue` (in the order the label was added); candidates are `merge-train/<base12>-<id>` branches whose
// merge commits carry `Merge-Train-*` trailers; gate evidence is the "Gate (Windows)" job of gate.yml for the
// exact candidate SHA. Preparation runs anywhere and in parallel. Two serialization points exist and both are
// atomic on the server: creating a candidate branch (a lease that requires the branch to be absent) and
// updating main (a lease that requires main to still be the candidate's base). A racing coordinator that
// loses either one rebuilds or reuses; nothing is corrupted.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const QUEUE_LABEL = "merge-queue";
/** Refuse a bootstrap candidate that could never receive its required push gate. */
export function assertCandidateWorkflow(source) {
  const workflow = source.replaceAll("\r\n", "\n");
  const windows = workflow.match(/^ {2}windows:\n([\s\S]*?)(?=^ {2}[a-zA-Z][\w-]*:|$(?![\s\S]))/m)?.[1] ?? "";
  if (
    !/ {2}push:\n(?:\s+#.*\n)* {4}branches: \[(?:main, )?"merge-train\/\*\*"\]/.test(workflow) ||
    !/ {4}runs-on: \[self-hosted, Windows, kalcode-gate(?:, kalcode-main-pc)?\]\n/.test(windows) ||
    !windows.includes("name: Gate\n") ||
    !windows.includes("trailers:key=Merge-Train-Base,valueonly")
  ) {
    throw new Error(
      "candidate gate workflow must trigger merge-train pushes on the main Windows PC and gate its recorded base",
    );
  }
  // A split gate's second-PC half must gate the same recorded base on the second PC's runner.
  const pc2 = workflow.match(/^ {2}pc2:\n([\s\S]*?)(?=^ {2}[a-zA-Z][\w-]*:|$(?![\s\S]))/m)?.[1];
  if (
    pc2 !== undefined &&
    (!/ {4}runs-on: \[self-hosted, Windows, kalcode-gate-pc2\]\n/.test(pc2) ||
      !pc2.includes("name: Gate\n") ||
      !pc2.includes("trailers:key=Merge-Train-Base,valueonly"))
  ) {
    throw new Error(
      "candidate gate workflow: its second-PC half must run on kalcode-gate-pc2 and gate the same recorded base",
    );
  }
}

export const GATE_JOB = "Gate (Windows)";
export const BRANCH_PREFIX = "merge-train/";
export const MANIFEST_SCHEMA = "kalcode-merge-train/v1";
const TRAILER_BASE = "Merge-Train-Base";
const TRAILER_PR = "Merge-Train-PR";
const TRAILER_HEAD = "Merge-Train-Head";
const CANDIDATE = /^merge-train\/([0-9a-f]{12})-([0-9a-f]{8})$/;
const SHA = /^[0-9a-f]{40}$/;

export class GitError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitError";
  }
}

/** An async git runner bound to one repository. Resolves { code, stdout, stderr }; throws unless allowFail. */
export function makeGit(repo, { env = {}, timeoutMs = 120_000 } = {}) {
  return (args, { allowFail = false, input } = {}) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(
        "git",
        ["-C", repo, "-c", "core.quotepath=off", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args],
        {
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
          windowsHide: true,
          timeout: timeoutMs,
          // Only a command given input gets a stdin pipe.
          stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d) => {
        stdout += d;
      });
      child.stderr.setEncoding("utf8").on("data", (d) => {
        stderr += d;
      });
      child.on("error", (error) => reject(new GitError(`git ${args[0]}: ${error.message}`)));
      child.on("close", (code) => {
        if (code !== 0 && !allowFail) {
          reject(new GitError(`git ${args.join(" ")}: ${stderr.trim().split("\n")[0] || `exit ${code}`}`));
        } else resolvePromise({ code, stdout, stderr });
      });
      if (input !== undefined) {
        // A git that exits (or is killed at timeoutMs) before reading its input closes the pipe: the
        // write then fails with EPIPE/EOF. Its exit code above is the result; an unhandled stream error
        // would instead crash the coordinator (gate 37410227962, a slow second PC).
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      }
    });
}

const short = (sha) => sha.slice(0, 12);
const prList = (items) => items.map((i) => `#${i.number}`).join(", ") || "none";

/** The candidate id: a function of the exact PR heads it contains, so racers building the same set collide. */
export function candidateBranch(base, included) {
  const id = createHash("sha1")
    .update(included.map((i) => `${i.number}:${i.head}`).join(","))
    .digest("hex")
    .slice(0, 8);
  return `${BRANCH_PREFIX}${short(base)}-${id}`;
}

export function mergeMessage(pr, base, resolvedBy = null) {
  const lines = [
    `Merge pull request #${pr.number}${pr.headRef ? ` from ${pr.headRef}` : ""} (merge train)`,
    "",
    pr.title || `PR #${pr.number}`,
    "",
    `${TRAILER_BASE}: ${base}`,
    `${TRAILER_PR}: ${pr.number}`,
    `${TRAILER_HEAD}: ${pr.head}`,
  ];
  if (resolvedBy) lines.push(`Merge-Train-Resolved-By: ${resolvedBy}`);
  return `${lines.join("\n")}\n`;
}

// ------------------------------------------------------------------------------------------- lanes
// Owner rule 2026-10-05 (AGENTS.md "high-concurrency merge + release architecture"): no single global queue.
// Ready PRs are partitioned into independent lanes; each lane builds and gates its own exact candidate on the
// same captured main SHA, so the gate pool validates them concurrently and a conflict blocks only its lane.

/**
 * Risky zones: two PRs that touch the same zone integrate in the same group even when git would merge them
 * cleanly, because their combination needs one validation (shared state, schema, CI, dependencies).
 */
export const RISK_ZONES = [
  ["ci", /^\.github\/workflows\//],
  ["lockfile", /(^|\/)(pnpm-lock\.yaml|Cargo\.lock|package-lock\.json)$/],
  ["migrations", /(^|\/)migrations?\/|\.sql$/],
  ["protocol", /^packages\/protocol\/src\/generated\//],
  ["agent-state", /^crates\/contracts\/src\/(agent_state|threads|resources)\.rs$|^crates\/threads\/src\/runtime\.rs$/],
  ["provider-session", /^crates\/providers\/src\/(interactive|registry)/],
  ["resource-governor", /^crates\/resources\/|^apps\/desktop\/src-tauri\/src\/resource_commands/],
  ["merge-train", /^tooling\/(merge-train|runners)\//],
];

export function riskZones(path) {
  return RISK_ZONES.filter(([, pattern]) => pattern.test(path)).map(([zone]) => zone);
}

/** Files gate.yml never gates (its pull_request paths filter): a base delta of only these changes no check. */
export function isUngatedPath(path) {
  if (path.startsWith("docs/releases/")) return false;
  return path.endsWith(".md") || path.startsWith("docs/") || path.startsWith("marketing/");
}

/**
 * Partitions queued PRs (queue order; each { number, head, files, ancestors }) into independent lanes.
 * Same lane when: one stacks on the other, they share a risky zone, or they touch a common file and
 * `conflicts(a, b)` (a real `git merge-tree` of both heads) reports a conflict. Everything else is independent.
 */
export async function planLanes(prs, { conflicts = async () => false } = {}) {
  const parent = new Map(prs.map((pr) => [pr.number, pr.number]));
  const find = (n) => {
    while (parent.get(n) !== n) {
      parent.set(n, parent.get(parent.get(n)));
      n = parent.get(n);
    }
    return n;
  };
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  const reasons = [];
  for (let i = 0; i < prs.length; i++) {
    for (let j = i + 1; j < prs.length; j++) {
      const [a, b] = [prs[i], prs[j]];
      if (a.ancestors?.has(b.head) || b.ancestors?.has(a.head)) {
        union(a.number, b.number);
        reasons.push({ pair: [a.number, b.number], why: "stacked" });
        continue;
      }
      const zonesA = new Set(a.files.flatMap(riskZones));
      const zone = b.files.flatMap(riskZones).find((z) => zonesA.has(z));
      if (zone) {
        union(a.number, b.number);
        reasons.push({ pair: [a.number, b.number], why: `risk:${zone}` });
        continue;
      }
      const filesA = new Set(a.files);
      if (b.files.some((f) => filesA.has(f)) && (await conflicts(a, b))) {
        union(a.number, b.number);
        reasons.push({ pair: [a.number, b.number], why: "conflict" });
      }
    }
  }
  const lanes = new Map();
  for (const pr of prs) {
    const root = find(pr.number);
    if (!lanes.has(root)) lanes.set(root, []);
    lanes.get(root).push(pr.number);
  }
  return {
    lanes: [...lanes.values()].map((numbers) => ({
      id: laneId(prs.filter((p) => numbers.includes(p.number))),
      numbers,
    })),
    reasons,
  };
}

/** A lane's id: the exact PR heads it groups, so every coordinator names the same lane the same way. */
export function laneId(prs) {
  return createHash("sha1")
    .update(
      [...prs]
        .sort((a, b) => a.number - b.number)
        .map((p) => `${p.number}:${p.head ?? ""}`)
        .join(","),
    )
    .digest("hex")
    .slice(0, 8);
}

/** Paths every release lands on main (the website's release record and release notes). */
export function isReleaseRecordPath(path) {
  return path === "apps/website/src/data/releases.json" || path.startsWith("docs/releases/");
}

/**
 * Whether a main move of `deltaFiles` leaves a lane's gate evidence valid: every moved file is a release
 * record or a path gate.yml never gates, and the lane itself touches none of the gates those files feed
 * (the website and release notes). Then the lane's selected checks and all their inputs are unchanged.
 */
export function deltaPreservesEvidence(deltaFiles, laneFiles) {
  if (!deltaFiles.length) return true;
  if (!deltaFiles.every((f) => isReleaseRecordPath(f) || isUngatedPath(f))) return false;
  return !laneFiles.some((f) => f.startsWith("apps/website/") || f.startsWith("docs/releases/"));
}

const buildNumber = (version) => {
  const m = /\+(\d+)$/.exec(version ?? "");
  return m ? Number(m[1]) : -1;
};

/**
 * Mechanical resolver for the release record: when both sides changed apps/website/src/data/releases.json,
 * take the side whose `latest.version` build is higher (the newest published record). Refuses (null) when
 * anything else conflicts or either side changed more than the release record (`latest`).
 */
export const releaseRecordResolver = {
  name: "release-record",
  async resolve({ git, tip, pr, files, conflictTree, writeTree }) {
    const path = "apps/website/src/data/releases.json";
    if (files.length !== 1 || files[0] !== path || !conflictTree || !writeTree) return null;
    const read = async (ref) => {
      const r = await git(["show", `${ref}:${path}`], { allowFail: true });
      if (r.code !== 0) return null;
      try {
        return { text: r.stdout, json: JSON.parse(r.stdout) };
      } catch {
        return null;
      }
    };
    const [ours, theirs] = [await read(tip), await read(pr.head)];
    if (!ours || !theirs) return null;
    const rest = ({ latest: _latest, ...other }) => JSON.stringify(other);
    if (rest(ours.json) !== rest(theirs.json)) return null;
    const winner = buildNumber(theirs.json.latest?.version) > buildNumber(ours.json.latest?.version) ? pr.head : tip;
    const blob = (await git(["rev-parse", `${winner}:${path}`])).stdout.trim();
    return writeTree(conflictTree, [{ path, blob }]);
  },
};

/** Per-PR pipeline states reported by `status --json`. */
export const PR_STATES = [
  "BUILDING",
  "READY FOR INTEGRATION",
  "MERGE GROUP",
  "GATING",
  "GREEN",
  "LANDING",
  "MERGED",
  "SUPERSEDED",
  "FAILED",
];

/** Exclusive, short-lived local lock file. Stale after staleMs (a crashed holder never blocks forever). */
export async function withLock(path, fn, { staleMs = 120_000, waitMs = 60_000, sleep, now = Date.now } = {}) {
  if (!path) return fn();
  mkdirSync(dirname(path), { recursive: true });
  const start = now();
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, `${process.pid} ${new Date(now()).toISOString()}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = now() - statSync(path).mtimeMs;
      } catch {
        continue; // released between our open and stat
      }
      if (age > staleMs) {
        try {
          unlinkSync(path);
        } catch {}
        continue;
      }
      if (now() - start > waitMs) throw new Error(`timed out waiting for ${path}`);
      await sleep(200);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}

/**
 * The merge train. `provider` is the GitHub seam (see github.mjs): listQueue, getPr, addLabel, removeLabel,
 * ensureLabel, comment, optional hasComment, and gateStatus(sha) -> { state: success|failure|pending|missing|
 * stale, url }. Tests inject a fake provider and local bare repositories.
 *
 * `resolvers` is the auto-resolution seam: [{ name, resolve({ git, base, tip, pr, files }) -> tree | null }].
 * Only provably safe mechanical resolutions may be registered; none are today, so every conflict skips the PR.
 */
export function createTrain({
  repo,
  provider,
  git = makeGit(repo),
  remote = "origin",
  mainBranch = "main",
  log = (line) => process.stdout.write(`${line}\n`),
  resolvers = [],
  lanesDir = null,
  mergeLog = null,
  onLanded = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  hooks = {},
  abandonAfterMs = 20 * 60_000,
  leaseMs = 5 * 60_000,
  leasePath = null,
  leaseOwner = null,
  isProcessAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  },
}) {
  // Pipeline state (timings, lane membership, supersession): local and advisory. Landing decisions never
  // depend on it except the docs-only evidence equivalence, which it records and land() re-verifies.
  const statePath = lanesDir && join(lanesDir, "merge-train", "state.json");
  let memoryState = { prs: {}, candidates: {} };
  const loadState = () => {
    if (!statePath) return memoryState;
    try {
      return JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      return { prs: {}, candidates: {} };
    }
  };
  const saveState = (state) => {
    if (!statePath) {
      memoryState = state;
      return;
    }
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      `${JSON.stringify(state, null, 2)}
`,
    );
  };
  const updateState = (fn) => {
    const state = loadState();
    state.prs ??= {};
    state.candidates ??= {};
    fn(state);
    saveState(state);
    return state;
  };
  const prEvent = (state, number, event, at = now()) => {
    state.prs[number] ??= {};
    const pr = state.prs[number];
    pr[event] ??= at;
    pr.last = event;
    pr.lastAt = at;
  };
  const lines = async (args) =>
    (await git(args)).stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  const rev = async (ref) => {
    const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const isAncestor = async (a, b) => (await git(["merge-base", "--is-ancestor", a, b], { allowFail: true })).code === 0;

  async function fetchRetry(refspecs) {
    for (let attempt = 1; ; attempt++) {
      const r = await git(["fetch", "--no-tags", "--no-write-fetch-head", remote, ...refspecs], { allowFail: true });
      if (r.code === 0) return true;
      // Concurrent agents share one object store; a transient lock collision is retried, anything else is final.
      if (attempt >= 5 || !/lock|exists/i.test(r.stderr)) return false;
      await sleep(100 * attempt + Math.floor(Math.random() * 200));
    }
  }

  /** A private ref namespace per command, so concurrent coordinators never write the same local ref. */
  async function withNamespace(fn) {
    const ns = `refs/merge-train/run-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      return await fn(ns);
    } finally {
      const refs = await lines(["for-each-ref", "--format=%(refname)", ns]).catch(() => []);
      if (refs.length) {
        await git(["update-ref", "--stdin"], { allowFail: true, input: refs.map((r) => `delete ${r}\n`).join("") });
      }
    }
  }

  /** origin/main and every candidate branch, as of one fetch. */
  async function snapshot(ns) {
    const ok = await fetchRetry([`+refs/heads/${mainBranch}:${ns}/main`, `+refs/heads/${BRANCH_PREFIX}*:${ns}/c/*`]);
    if (!ok) throw new GitError(`could not fetch ${remote}`);
    const base = await rev(`${ns}/main`);
    if (!base) throw new GitError(`${remote}/${mainBranch} is missing`);
    const candidates = [];
    for (const line of await lines(["for-each-ref", "--format=%(objectname) %(refname)", `${ns}/c/`])) {
      const [sha, ref] = line.split(" ");
      const branch = BRANCH_PREFIX + ref.slice(`${ns}/c/`.length);
      candidates.push((await parseCandidate(branch, sha)) ?? { branch, sha, invalid: true });
    }
    return { base, candidates };
  }

  /**
   * Reads a candidate's structure from git alone: a first-parent chain of merge commits on BASE, each
   * carrying the trailers this train writes. Returns null for anything else, which is never reused or landed.
   */
  async function parseCandidate(branch, sha) {
    const m = CANDIDATE.exec(branch);
    if (!m) return null;
    const fmt = `%H%x1f%P%x1f%(trailers:key=${TRAILER_PR},valueonly,separator=%x2c)%x1f%(trailers:key=${TRAILER_BASE},valueonly,separator=%x2c)%x1e`;
    const out = (await git(["log", "--first-parent", "--max-count=201", `--format=${fmt}`, sha])).stdout;
    const included = [];
    let base = null;
    let claimed = null;
    // Walk the first-parent chain down to the base the tip claims. Main itself is full of earlier train
    // merges, so the walk stops at that exact commit, never at "the first commit without trailers".
    for (const record of out.split("\x1e")) {
      const fields = record.replace(/^\s+/, "").split("\x1f");
      if (fields.length < 4) continue;
      const [commit, parents, prField, baseField] = fields.map((f) => f.trim());
      if (claimed && commit === claimed) {
        base = commit;
        break;
      }
      const parentList = parents.split(" ");
      if (!prField || parentList.length !== 2 || !/^\d+$/.test(prField) || !SHA.test(baseField)) return null;
      claimed ??= baseField;
      if (baseField !== claimed) return null;
      included.unshift({ number: Number(prField), head: parentList[1], merge: commit });
    }
    if (!base || included.length === 0 || !base.startsWith(m[1])) return null;
    // The first-parent chain: a stacked lane level's lower levels are commits on it, so after one of them
    // lands, main is on this chain and the candidate still fast-forwards with its exact gated tree.
    return { branch, sha, base, included, chain: included.map((i) => i.merge) };
  }

  async function mergeTrees(tip, head) {
    const r = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", tip, head], {
      allowFail: true,
    });
    const parts = r.stdout.split("\0").filter(Boolean);
    if (r.code === 0) return { tree: parts[0] };
    if (r.code === 1) return { conflicts: [...new Set(parts.slice(1))].sort(), conflictTree: parts[0] };
    throw new GitError(`git merge-tree ${short(tip)} ${short(head)}: ${r.stderr.trim()}`);
  }

  /** A tree equal to `tree` with some paths replaced by existing blobs (a private index; no worktree). */
  async function writeTree(tree, entries) {
    const index = join(lanesDir ?? repo, `.merge-train-index-${process.pid}-${randomBytes(4).toString("hex")}`);
    mkdirSync(dirname(index), { recursive: true });
    const scoped = makeGit(repo, { env: { GIT_INDEX_FILE: index } });
    try {
      await scoped(["read-tree", tree]);
      for (const { path, blob } of entries) await scoped(["update-index", "--cacheinfo", `100644,${blob},${path}`]);
      return (await scoped(["write-tree"])).stdout.trim();
    } finally {
      try {
        unlinkSync(index);
      } catch {}
    }
  }

  /** Applies registered mechanical resolvers to a conflicted merge; returns { tree, resolvedBy } or null. */
  async function resolveConflict({ base, tip, pr, merged }) {
    for (const resolver of resolvers) {
      const tree = await resolver.resolve({
        git,
        base,
        tip,
        pr,
        files: merged.conflicts,
        conflictTree: merged.conflictTree,
        writeTree,
      });
      if (tree) return { tree, resolvedBy: resolver.name };
    }
    return null;
  }

  async function changedFiles(base, head) {
    return (await git(["diff", "--name-only", "-z", `${base}...${head}`])).stdout.split("\0").filter(Boolean);
  }

  async function deleteRemote(branch, sha) {
    const r = await git(
      ["push", "--porcelain", remote, `--force-with-lease=refs/heads/${branch}:${sha}`, `:refs/heads/${branch}`],
      { allowFail: true },
    );
    return r.code === 0;
  }

  async function commentOnce(number, marker, body) {
    try {
      if (marker && provider.hasComment && (await provider.hasComment(number, marker))) return;
      await provider.comment(number, marker ? `${body}\n\n<!-- merge-train:${marker} -->` : body);
    } catch (error) {
      log(`warning: could not comment on #${number}: ${error.message}`);
    }
  }

  function writeManifest(manifest) {
    if (!lanesDir) return null;
    const path = join(lanesDir, "merge-train", `${manifest.branch.slice(BRANCH_PREFIX.length)}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return path;
  }

  async function fetchHeads(ns, queue) {
    const ref = (pr) => `${ns}/pr/${pr.number}`;
    const specs = queue.map((pr) => `+${pr.fetchRef}:${ref(pr)}`);
    if (specs.length && !(await fetchRetry(specs))) {
      for (const [i, spec] of specs.entries()) {
        if (!(await fetchRetry([spec]))) log(`warning: could not fetch #${queue[i].number} (${queue[i].fetchRef})`);
      }
    }
    for (const pr of queue) pr.head = await rev(ref(pr));
  }

  const fresh = (candidate, active) => candidate.included.every((i) => active.get(i.number)?.head === i.head);
  // A failed fetch is uncertainty, not evidence that an immutable candidate is obsolete.
  const obsolete = (candidate, active) =>
    candidate.included.some(
      (i) => !active.has(i.number) || (active.get(i.number).head && active.get(i.number).head !== i.head),
    );

  async function retire(candidate, reason, { supersededBy = null } = {}) {
    log(`${supersededBy ? "superseding" : "retiring"} ${candidate.branch}: ${reason}`);
    await provider.cancelGates?.(candidate.sha, candidate.branch);
    await deleteRemote(candidate.branch, candidate.sha);
    updateState((state) => {
      state.candidates[candidate.branch] = {
        ...state.candidates[candidate.branch],
        sha: candidate.sha,
        retiredAt: now(),
        reason,
        supersededBy,
      };
      if (supersededBy)
        for (const i of candidate.included ?? []) {
          state.prs[i.number] ??= {};
          state.prs[i.number].supersededFrom = candidate.branch;
        }
    });
  }

  async function eject(candidate) {
    const { number, head } = candidate.included[0];
    log(`gate failed for ${candidate.branch} (only #${number}); removing #${number} from the queue`);
    await commentOnce(
      number,
      `eject:${short(candidate.sha)}`,
      `Removed from the merge queue: the gate failed for merge-train candidate \`${candidate.branch}\` (${short(candidate.sha)}), which contained only this PR at head ${short(head)}.${candidate.gate?.url ? ` Gate: ${candidate.gate.url}` : ""}\n\nFix the failure, then resubmit with \`node tooling/merge-train/train.mjs submit ${number}\`.`,
    );
    try {
      await provider.removeLabel(number);
    } catch (error) {
      log(`warning: could not unlabel #${number}: ${error.message}`);
    }
    await deleteRemote(candidate.branch, candidate.sha);
  }

  function manifestFor(candidate, action, skipped = []) {
    return {
      schema: MANIFEST_SCHEMA,
      action,
      branch: candidate.branch,
      base: candidate.base,
      candidate: candidate.sha,
      createdAt: new Date(now()).toISOString(),
      included: candidate.included,
      skipped,
    };
  }

  /**
   * Builds (or reuses) one candidate on the current main. With `lane`, only that lane's queued PRs and the
   * candidates made entirely of them are considered: other lanes' candidates are never touched, so lanes
   * prepare, gate and fail independently.
   */
  async function build({ lane = null } = {}) {
    return withNamespace(async (ns) => {
      const snap = await snapshot(ns);
      const { base } = snap;
      const fullQueue = await provider.listQueue();
      const queue = lane ? fullQueue.filter((pr) => lane.has(pr.number)) : fullQueue;
      if (lane)
        snap.candidates = snap.candidates.filter((c) => !c.invalid && c.included.every((i) => lane.has(i.number)));
      await fetchHeads(ns, queue);
      const active = new Map(queue.map((pr) => [pr.number, pr]));

      // Candidates on an older main can never land (main's lease would refuse them); retire them.
      const current = [];
      for (const c of snap.candidates) {
        if (c.invalid) continue;
        if (c.base === base && !obsolete(c, active)) current.push(c);
        else if (c.base === base || (await isAncestor(c.base, base))) {
          await retire(c, c.base === base ? "queued PR head or eligibility changed" : "main advanced");
        }
      }
      for (const c of current) c.gate = await provider.gateStatus(c.sha, c.branch);

      // A lane that grew since a candidate was built integrates as one group: a still-unverified candidate
      // covering only the old part is SUPERSEDED. A green one is kept; it can land first at no extra cost.
      if (lane) {
        const recorded = loadState().candidates;
        for (const c of [...current]) {
          const builtFor = recorded[c.branch]?.lane;
          const grown = builtFor && [...lane].some((n) => active.get(n)?.head && !builtFor.includes(n));
          if (grown && c.gate.state !== "success" && fresh(c, active)) {
            await retire(c, `lane grew to ${[...lane].map((n) => `#${n}`).join(", ")}`, { supersededBy: "lane" });
            current.splice(current.indexOf(c), 1);
          }
        }
      }

      // A candidate whose gate never started (or was cancelled) is re-pushed so the push trigger fires again.
      for (const c of current) {
        const state = c.gate.state;
        const age = now() - Number((await git(["log", "-1", "--format=%ct", c.sha])).stdout.trim()) * 1000;
        if (state === "stale" || (state === "missing" && age > abandonAfterMs)) {
          log(`re-triggering ${c.branch}: gate ${state}`);
          await deleteRemote(c.branch, c.sha);
          c.gate = { state: "deleted" };
        }
      }

      const rank = { success: 0, pending: 1, missing: 2 };
      const reusable = current
        .filter((c) => c.gate.state in rank && fresh(c, active))
        .sort((a, b) => rank[a.gate.state] - rank[b.gate.state] || b.included.length - a.included.length);
      const reuse = () => {
        if (!reusable.length) return null;
        const manifest = manifestFor(reusable[0], "reused");
        writeManifest(manifest);
        log(`reusing ${manifest.branch} (${short(manifest.candidate)}; gate ${reusable[0].gate.state})`);
        return manifest;
      };
      // A verified candidate can advance main immediately; prepare the next
      // group against that new snapshot rather than spend a worker on old BASE.
      if (reusable[0]?.gate.state === "success") return reuse();

      // Reserve only the PR heads covered by valid candidates. New independent work can
      // use another worker immediately; adding it never invalidates an existing gate.
      const covered = new Set(reusable.flatMap((c) => c.included.map((i) => i.number)));
      const failed = current
        .filter((c) => c.gate.state === "failure" && fresh(c, active))
        .sort((a, b) => a.included.length - b.included.length);
      for (const c of failed) {
        if (c.included.length === 1 && !covered.has(c.included[0].number)) {
          await eject(c);
          active.delete(c.included[0].number);
        }
      }
      // Ejecting a failing singleton invalidates larger failed groups containing it.
      // Their remaining independent PRs must become eligible again immediately.
      const failedHeads = new Set(
        failed.filter((c) => fresh(c, active)).flatMap((c) => c.included.map((i) => i.number)),
      );
      let selection = new Set([...active.keys()].filter((n) => !covered.has(n) && !failedHeads.has(n)));
      if (!selection.size) {
        for (const c of failed) {
          if (!fresh(c, active)) continue;
          const uncovered = c.included.filter((i) => !covered.has(i.number));
          if (!uncovered.length) continue;
          selection = new Set(uncovered.slice(0, Math.ceil(c.included.length / 2)).map((i) => i.number));
          log(`bisecting failed ${c.branch}: trying ${[...selection].map((n) => `#${n}`).join(", ")}`);
          break;
        }
      }
      if (!selection.size && reusable.length) return reuse();

      // A newly queued stacked PR can already contain a pending PR's commit. Keep
      // that dependency in the manifest so landing rechecks BOTH exact heads.
      // One history query per selected head avoids an O(PRs squared) process fan-out.
      const ancestry = new Map();
      const ancestorsOf = async (head) => {
        if (!ancestry.has(head)) ancestry.set(head, new Set(await lines(["rev-list", head, `^${base}`])));
        return ancestry.get(head);
      };
      const selectedAncestors = new Set();
      for (const number of selection) {
        const head = active.get(number)?.head;
        if (head) for (const ancestor of await ancestorsOf(head)) selectedAncestors.add(ancestor);
      }
      for (const pr of active.values()) {
        if (!pr.head || selection.has(pr.number)) continue;
        if (selectedAncestors.has(pr.head)) selection.add(pr.number);
      }

      const dependencies = new Map();
      // A failed head fetch must not erase a dependency already captured by another
      // immutable candidate. Hold only children containing that head until its current
      // queue eligibility and head can be checked; independent PRs still proceed.
      const captured = snap.candidates
        .filter((candidate) => !candidate.invalid)
        .flatMap((candidate) => candidate.included);
      const unavailableCaptured = new Map();
      const remaining = [...active.values()].filter((pr) => selection.has(pr.number));
      for (const pr of remaining) {
        const ancestors = pr.head ? await ancestorsOf(pr.head) : new Set();
        unavailableCaptured.set(pr.number, [
          ...new Set(
            captured
              .filter(
                (other) => other.number !== pr.number && !active.get(other.number)?.head && ancestors.has(other.head),
              )
              .map((other) => other.number),
          ),
        ]);
        const needed = remaining
          .filter((other) => other.head !== pr.head && ancestors.has(other.head))
          .map((other) => other.number);
        dependencies.set(pr.number, needed);
      }
      const ordered = [];
      while (remaining.length) {
        const next = remaining.findIndex((pr) =>
          dependencies.get(pr.number).every((n) => ordered.some((p) => p.number === n)),
        );
        if (next < 0) throw new Error("queued PR dependency cycle");
        ordered.push(...remaining.splice(next, 1));
      }

      let tip = base;
      const included = [];
      const skipped = [];
      for (const pr of ordered) {
        if (!pr.head) {
          skipped.push({ number: pr.number, reason: "head-unavailable", files: [], conflictsWith: [] });
          continue;
        }
        if (await isAncestor(pr.head, base)) {
          skipped.push({ number: pr.number, head: pr.head, reason: "already-in-main", files: [], conflictsWith: [] });
          continue;
        }
        const unavailable = [
          ...unavailableCaptured.get(pr.number),
          ...dependencies.get(pr.number).filter((n) => !included.some((i) => i.number === n)),
        ];
        if (unavailable.length) {
          skipped.push({
            number: pr.number,
            head: pr.head,
            reason: "dependency-unavailable",
            files: [],
            conflictsWith: unavailable,
          });
          continue;
        }
        let merged = await mergeTrees(tip, pr.head);
        let resolvedBy = null;
        if (merged.conflicts) {
          const resolved = await resolveConflict({ base, tip, pr, merged });
          if (resolved) {
            merged = { tree: resolved.tree };
            resolvedBy = resolved.resolvedBy;
          }
        }
        if (merged.conflicts) {
          const alone = await mergeTrees(base, pr.head);
          if (alone.conflicts) {
            skipped.push({
              number: pr.number,
              head: pr.head,
              reason: "conflicts-with-main",
              files: alone.conflicts,
              conflictsWith: [],
            });
          } else {
            const conflictsWith = [];
            for (const other of included) {
              const files = new Set(await changedFiles(base, other.head));
              if (merged.conflicts.some((f) => files.has(f))) conflictsWith.push(other.number);
            }
            skipped.push({
              number: pr.number,
              head: pr.head,
              reason: "conflicts-with-batch",
              files: merged.conflicts,
              conflictsWith: conflictsWith.length ? conflictsWith : included.map((i) => i.number),
            });
          }
          continue;
        }
        const message = mergeMessage(pr, base, resolvedBy);
        tip = (
          await git(["commit-tree", merged.tree, "-p", tip, "-p", pr.head, "-F", "-"], { input: message })
        ).stdout.trim();
        included.push({ number: pr.number, head: pr.head, title: pr.title ?? "" });
      }

      for (const s of skipped) {
        if (s.reason === "already-in-main" || s.reason === "head-unavailable") continue;
        const why =
          s.reason === "dependency-unavailable"
            ? `depends on queued ${s.conflictsWith.map((n) => `#${n}`).join(", ")}, which could not be included safely; it retries when that dependency is ready`
            : s.reason === "conflicts-with-main"
              ? `conflicts with main ${short(base)}; rebase or merge main into the PR (the label stays, so it retries automatically after your push)`
              : `conflicts with ${s.conflictsWith.map((n) => `#${n}`).join(", ")}, which are ahead of it in this train; it retries on the next train once they land`;
        await commentOnce(
          s.number,
          `skip:${short(base)}:${short(s.head)}`,
          `Merge train skipped this PR at head ${short(s.head)}: it ${why}.\n\nConflicting files:\n${s.files.map((f) => `- \`${f}\``).join("\n")}`,
        );
      }

      if (included.length === 0) {
        if (reusable.length) return reuse();
        log(`nothing to build on ${short(base)} (queue ${queue.length}, skipped ${skipped.length})`);
        return { schema: MANIFEST_SCHEMA, action: "idle", base, included, skipped };
      }

      const workflow = await git(["show", `${tip}:.github/workflows/gate.yml`], { allowFail: true });
      assertCandidateWorkflow(workflow.code === 0 ? workflow.stdout : "");
      const branch = candidateBranch(base, included);
      const candidate = { branch, sha: tip, base, included };
      await hooks.beforePush?.(candidate);
      const push = await git(
        ["push", "--porcelain", remote, `${tip}:refs/heads/${branch}`, `--force-with-lease=refs/heads/${branch}:`],
        { allowFail: true },
      );
      if (push.code !== 0) {
        // Another coordinator created the same candidate (same base, same PR heads) first: use theirs.
        const raced = (await fetchRetry([`+refs/heads/${branch}:${ns}/race`])) && (await rev(`${ns}/race`));
        const theirs = raced && (await parseCandidate(branch, raced));
        if (
          !theirs ||
          JSON.stringify(theirs.included.map(({ number, head }) => ({ number, head }))) !==
            JSON.stringify(included.map(({ number, head }) => ({ number, head })))
        ) {
          throw new GitError(`could not push ${branch}: ${push.stderr.trim() || push.stdout.trim()}`);
        }
        const manifest = manifestFor(theirs, "reused", skipped);
        writeManifest(manifest);
        log(`reusing ${branch} (${short(theirs.sha)}), created concurrently by another coordinator`);
        return manifest;
      }

      const manifest = manifestFor(candidate, "built", skipped);
      updateState((state) => {
        state.candidates[branch] = {
          sha: tip,
          base,
          builtAt: now(),
          lane: lane ? [...lane].sort((a, b) => a - b) : null,
        };
        for (const i of included) prEvent(state, i.number, "groupedAt");
        for (const sk of skipped)
          if (sk.reason.startsWith("conflicts")) {
            state.prs[sk.number] ??= {};
            state.prs[sk.number].conflictSince ??= now();
          }
      });
      const path = writeManifest(manifest);
      log(`built ${branch} (${short(tip)}) on main ${short(base)}: ${prList(included)}; skipped ${prList(skipped)}`);
      if (path) log(`manifest: ${path}`);
      const details = `<details><summary>Manifest</summary>\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n</details>`;
      for (const pr of included) {
        await commentOnce(
          pr.number,
          `candidate:${branch}`,
          `Merge train candidate \`${branch}\` (${short(tip)}) on main ${short(base)} contains this PR at head ${short(pr.head)} with ${prList(included.filter((i) => i !== pr))}. Gating the exact candidate now.\n\n${details}`,
        );
      }
      return manifest;
    });
  }

  /** The lane plan for the queued PRs on one captured main SHA (inside an existing ref namespace). */
  async function planIn(ns, snap) {
    const queue = await provider.listQueue();
    await fetchHeads(ns, queue);
    const prs = [];
    const byNumber = new Map();
    for (const pr of queue) {
      byNumber.set(pr.number, pr);
      if (!pr.head) continue;
      if (await isAncestor(pr.head, snap.base)) continue;
      prs.push({
        number: pr.number,
        title: pr.title,
        headRef: pr.headRef,
        head: pr.head,
        files: await changedFiles(snap.base, pr.head),
        ancestors: new Set(await lines(["rev-list", pr.head, `^${snap.base}`])),
      });
    }
    const conflicts = async (a, b) => Boolean((await mergeTrees(a.head, b.head)).conflicts);
    const { lanes, reasons } = await planLanes(prs, { conflicts });
    return { queue, byNumber, prs, lanes, reasons };
  }

  async function plan() {
    return withNamespace(async (ns) => {
      const snap = await snapshot(ns);
      const planned = await planIn(ns, snap);
      return { base: snap.base, lanes: planned.lanes, reasons: planned.reasons, candidates: snap.candidates };
    });
  }

  const headsKey = (items) => items.map((i) => `${i.number}:${i.head}`).join(",");

  /**
   * One round for every lane at once, as speculative stacked levels on ONE captured main SHA:
   *   level 1 = main + lane 1,  level 2 = level 1 + lane 2,  ...
   * Every level is an exact candidate pushed in this round, so the gate pool validates all of them
   * concurrently. The deepest green level lands in one fast-forward (compatible lanes batch); when a lower
   * level lands, the deeper ones still fast-forward with their exact gated trees (main is on their chain).
   * A lane's conflict skips only its own PRs; a red level is attributed to its own lane (see run()).
   */
  async function buildAll() {
    return withNamespace(async (ns) => {
      const snap = await snapshot(ns);
      const main = snap.base;
      const planned = await planIn(ns, snap);
      const state = loadState();
      const bisect = state.bisect ?? {};
      const valid = new Map();
      const onMain = (c) => !c.invalid && (c.base === main || c.chain?.includes(main));
      for (const c of snap.candidates) if (onMain(c)) valid.set(c.branch, c);
      const allOnMain = new Map(valid);

      // Speculative evidence: green levels from an older main, for minimum refresh of identical lanes.
      const greenOld = [];
      for (const c of snap.candidates) {
        if (c.invalid || onMain(c)) continue;
        if ((await provider.gateStatus(c.sha, c.branch)).state === "success") greenOld.push(c);
      }

      // A stack still gating from an earlier main (a lower level of it already landed, so main is on its
      // chain) keeps its original base: new lanes extend it with the same Merge-Train-Base trailer, so every
      // level stays one exact, parseable candidate that fast-forwards from today's main.
      let stackBase = main;
      let tip = main;
      let included = [];
      const anchor = [...valid.values()]
        .filter((c) => c.base !== main)
        .sort((a, b) => b.included.length - a.included.length)[0];
      if (anchor) {
        stackBase = anchor.base;
        included = anchor.included
          .slice(0, anchor.chain.indexOf(main) + 1)
          .map(({ number, head }) => ({ number, head, title: "" }));
        for (const [branch, c] of valid) if (c.base !== stackBase) valid.delete(branch);
      } else {
        for (const [branch, c] of valid) if (c.base !== main) valid.delete(branch);
      }
      const levels = [];
      const skipped = [];
      const deltaCache = new Map();
      for (const lane of planned.lanes) {
        const lanePrs = planned.prs.filter((p) => lane.numbers.includes(p.number));
        const ordered = [];
        const pending = [...lanePrs];
        while (pending.length) {
          const next = pending.findIndex((pr) =>
            pending.every((other) => other === pr || !pr.ancestors.has(other.head)),
          );
          ordered.push(...pending.splice(next < 0 ? 0 : next, 1));
        }
        const limit = bisect[headsKey(ordered)]?.limit ?? ordered.length;
        const added = [];
        for (const pr of ordered.slice(0, limit)) {
          if (included.some((i) => i.number === pr.number)) continue;
          const missingParent = lanePrs.find(
            (other) => other !== pr && pr.ancestors.has(other.head) && !included.some((i) => i.number === other.number),
          );
          if (missingParent) {
            skipped.push({
              number: pr.number,
              head: pr.head,
              reason: "dependency-unavailable",
              files: [],
              conflictsWith: [missingParent.number],
            });
            continue;
          }
          let merged = await mergeTrees(tip, pr.head);
          let resolvedBy = null;
          if (merged.conflicts) {
            const resolved = await resolveConflict({ base: main, tip, pr, merged });
            if (resolved) {
              merged = { tree: resolved.tree };
              resolvedBy = resolved.resolvedBy;
            }
          }
          if (merged.conflicts) {
            const alone = await mergeTrees(main, pr.head);
            skipped.push({
              number: pr.number,
              head: pr.head,
              reason: alone.conflicts ? "conflicts-with-main" : "conflicts-with-batch",
              files: alone.conflicts ?? merged.conflicts,
              conflictsWith: alone.conflicts ? [] : included.map((i) => i.number),
            });
            continue;
          }
          // Reuse the existing commit for this exact prefix, so levels chain on SHAs other coordinators and
          // the gate pool already know (a fresh commit-tree would differ only in its timestamp).
          const want = [...included, { number: pr.number, head: pr.head }];
          const existing = [...valid.values()].find(
            (c) => c.included.length >= want.length && headsKey(c.included.slice(0, want.length)) === headsKey(want),
          );
          if (existing) tip = existing.chain[want.length - 1];
          else {
            const message = mergeMessage(pr, stackBase, resolvedBy);
            tip = (
              await git(["commit-tree", merged.tree, "-p", tip, "-p", pr.head, "-F", "-"], { input: message })
            ).stdout.trim();
          }
          included = [...included, { number: pr.number, head: pr.head, title: pr.title ?? "" }];
          added.push(pr.number);
        }
        if (!added.length) continue;
        const branch = candidateBranch(stackBase, included);
        const level = {
          branch,
          sha: tip,
          base: stackBase,
          included: [...included],
          lane: lane.id,
          laneNumbers: lane.numbers,
          added,
        };
        if (valid.get(branch)?.sha === tip) level.action = "reused";
        else {
          const workflow = await git(["show", `${tip}:.github/workflows/gate.yml`], { allowFail: true });
          assertCandidateWorkflow(workflow.code === 0 ? workflow.stdout : "");
          await hooks.beforePush?.(level);
          const push = await git(
            ["push", "--porcelain", remote, `${tip}:refs/heads/${branch}`, `--force-with-lease=refs/heads/${branch}:`],
            { allowFail: true },
          );
          if (push.code !== 0) {
            const raced = (await fetchRetry([`+refs/heads/${branch}:${ns}/race`])) && (await rev(`${ns}/race`));
            const theirs = raced && (await parseCandidate(branch, raced));
            if (!theirs || headsKey(theirs.included) !== headsKey(included)) {
              throw new GitError(`could not push ${branch}: ${push.stderr.trim() || push.stdout.trim()}`);
            }
            tip = theirs.sha;
            level.sha = theirs.sha;
            level.action = "reused";
          } else level.action = "built";
        }
        levels.push(level);
        valid.delete(branch);
        // Minimum refresh: an identical stack (same PR heads) that was green on an older main may land on
        // that evidence when main moved only by release records / ungated paths this lane's gates ignore.
        const prior = greenOld.find((c) => headsKey(c.included) === headsKey(included));
        if (prior && level.action === "built") {
          if (!deltaCache.has(prior.base)) {
            deltaCache.set(
              prior.base,
              (await isAncestor(prior.base, main))
                ? (await git(["diff", "--name-only", "-z", prior.base, main])).stdout.split("\0").filter(Boolean)
                : null,
            );
          }
          const delta = deltaCache.get(prior.base);
          const laneFiles = planned.prs
            .filter((p) => included.some((i) => i.number === p.number))
            .flatMap((p) => p.files);
          if (delta && deltaPreservesEvidence(delta, laneFiles)) {
            updateState((st) => {
              st.candidates[branch] = {
                ...st.candidates[branch],
                equivalentTo: {
                  branch: prior.branch,
                  sha: prior.sha,
                  base: prior.base,
                  included: included.map(({ number, head }) => ({ number, head })),
                },
              };
            });
            log(`${branch}: main moved only by release records / ungated paths; reusing ${short(prior.sha)}'s gate`);
          }
        }
      }

      // Anything on main that no level is (an older plan, an obsolete head) stops gating: SUPERSEDED, unless
      // it is green and still exact, in which case it may land first.
      const used = new Set(levels.map((l) => l.branch));
      for (const c of allOnMain.values()) {
        if (used.has(c.branch)) continue;
        const gate = await provider.gateStatus(c.sha, c.branch);
        const position = c.base === main ? 0 : c.chain.indexOf(main) + 1;
        const stillExact = c.included.slice(position).every((i) => planned.byNumber.get(i.number)?.head === i.head);
        if (gate.state === "success" && stillExact) {
          levels.unshift({
            branch: c.branch,
            sha: c.sha,
            base: c.base,
            included: c.included,
            lane: "carried",
            laneNumbers: [],
            added: [],
            action: "reused",
          });
          continue;
        }
        await retire(c, "superseded by the current lane plan", { supersededBy: "plan" });
      }
      // Candidates on an older main can never land; retire them (green ones were remembered above).
      for (const c of snap.candidates)
        if (!c.invalid && !onMain(c) && (await isAncestor(c.base, main))) await retire(c, "main advanced");

      updateState((st) => {
        for (const level of levels) {
          st.candidates[level.branch] = {
            ...st.candidates[level.branch],
            sha: level.sha,
            base: level.base,
            lane: level.laneNumbers,
            builtAt: st.candidates[level.branch]?.builtAt ?? now(),
          };
          for (const i of level.included) prEvent(st, i.number, "groupedAt");
        }
        for (const sk of skipped) {
          st.prs[sk.number] ??= {};
          if (sk.reason.startsWith("conflicts")) st.prs[sk.number].conflictSince ??= now();
        }
      });
      for (const sk of skipped) {
        if (sk.reason === "dependency-unavailable") continue;
        const why =
          sk.reason === "conflicts-with-main"
            ? `conflicts with main ${short(main)}; rebase or merge main into the PR (the label stays, so it retries automatically after your push)`
            : `conflicts with ${sk.conflictsWith.map((n) => `#${n}`).join(", ")} in an earlier lane level; only this PR waits, every other lane proceeds`;
        await commentOnce(
          sk.number,
          `skip:${short(main)}:${short(sk.head)}`,
          `Merge train skipped this PR at head ${short(sk.head)}: it ${why}.\n\nConflicting files:\n${sk.files.map((f) => `- \`${f}\``).join("\n")}`,
        );
      }
      log(
        `lanes on ${short(main)}: ${planned.lanes.map((l) => `[${l.numbers.map((n) => `#${n}`).join(" ")}]`).join(" ") || "none"}; levels ${levels.map((l) => `${l.branch}(${l.action})`).join(", ") || "none"}`,
      );
      return { schema: MANIFEST_SCHEMA, base: main, lanes: planned.lanes, levels, skipped, reasons: planned.reasons };
    });
  }

  async function land(branch) {
    if (!CANDIDATE.test(branch)) return { landed: false, reason: "invalid-candidate", detail: branch };
    return withNamespace(async (ns) => {
      const ok = await fetchRetry([`+refs/heads/${mainBranch}:${ns}/main`, `+refs/heads/${branch}:${ns}/land`]);
      const main = ok && (await rev(`${ns}/main`));
      const sha = ok && (await rev(`${ns}/land`));
      if (!main || !sha) return { landed: false, reason: "missing-candidate", detail: branch };
      const c = await parseCandidate(branch, sha);
      if (!c) return { landed: false, reason: "invalid-candidate", detail: branch };
      const refuse = (reason, detail) => {
        log(`refusing to land ${branch} (${short(sha)}): ${reason}${detail ? ` (${detail})` : ""}`);
        return { landed: false, reason, detail, branch, candidate: sha, base: c.base };
      };

      const gate = await provider.gateStatus(sha, branch);
      let evidence = gate.state === "success" ? "gate" : null;
      if (!evidence) {
        // Minimum refresh: re-verify the recorded equivalence (same PR heads, prior exact candidate green,
        // and the bases differ only by release records / ungated paths this lane's gates never read).
        const from = loadState().candidates[branch]?.equivalentTo;
        if (
          from?.sha &&
          SHA.test(from.sha) &&
          SHA.test(from.base ?? "") &&
          headsKey(from.included ?? []) === headsKey(c.included)
        ) {
          const prior = await provider.gateStatus(from.sha, from.branch);
          if (prior.state === "success" && (await isAncestor(from.base, c.base))) {
            const delta = (await git(["diff", "--name-only", "-z", from.base, c.base])).stdout
              .split("\0")
              .filter(Boolean);
            const laneFiles = [];
            for (const i of c.included) laneFiles.push(...(await changedFiles(c.base, i.head)));
            if (deltaPreservesEvidence(delta, laneFiles)) evidence = `equivalent:${short(from.sha)}`;
          }
        }
      }
      if (!evidence) return refuse("gate-not-green", `${GATE_JOB} for ${short(sha)} is ${gate.state}`);
      // main is the candidate's base, or a lower level of the same stack that already landed: either way the
      // update is a fast-forward to the exact tree that was gated.
      const position = main === c.base ? 0 : c.chain.indexOf(main) + 1;
      if (position === 0 && main !== c.base) {
        return refuse("main-moved", `main is ${short(main)}, candidate base ${short(c.base)}`);
      }
      if (position === c.included.length) return refuse("already-landed", `main is already ${short(sha)}`);
      for (const i of c.included.slice(position)) {
        const pr = await provider.getPr(i.number);
        if (
          !pr?.open ||
          pr.head !== i.head ||
          !pr.queued ||
          pr.draft ||
          pr.crossRepository ||
          pr.baseRef !== mainBranch
        ) {
          return refuse(
            "stale-pr",
            `#${i.number} ${!pr?.open ? "is closed" : !pr.queued ? "left the queue" : pr.draft || pr.crossRepository || pr.baseRef !== mainBranch ? "is no longer eligible for main" : `moved to ${short(pr.head)}`}`,
          );
        }
      }

      updateState((state) => {
        for (const i of c.included.slice(position)) prEvent(state, i.number, "landingAt");
      });
      // The lease is the atomic compare-and-swap: main moves to the candidate only if it is still what we saw.
      const push = await pushMain(sha, main, c);
      if (push.code !== 0) return refuse("main-moved", "main changed during landing; the lease refused the update");
      await deleteRemote(branch, sha);
      const landedHere = c.included.slice(position);
      writeManifest({ ...manifestFor(c, "landed"), main: sha, evidence, lockMs: push.lockMs });
      // Every other candidate whose PRs main now contains is SUPERSEDED: cancel its gate and drop it.
      const contained = new Set(c.included.map((i) => `${i.number}:${i.head}`));
      const others = await snapshot(ns).catch(() => ({ candidates: [] }));
      for (const other of others.candidates) {
        if (other.invalid || other.branch === branch) continue;
        if (other.included.every((i) => contained.has(`${i.number}:${i.head}`))) {
          await retire(other, `contained in landed ${branch}`, { supersededBy: branch });
        }
      }
      updateState((state) => {
        for (const i of landedHere) prEvent(state, i.number, "mergedAt");
        state.candidates[branch] = { ...state.candidates[branch], sha, landedAt: now(), main: sha, evidence };
        for (const key of Object.keys(state.bisect ?? {}))
          if (landedHere.some((i) => key.includes(`${i.number}:${i.head}`))) delete state.bisect[key];
      });
      return afterLanding({ main: sha, base: main, branch, included: landedHere, evidence, lockMs: push.lockMs });
    });
  }

  /**
   * The atomic main update: main moves to `sha` only if it is still `base`. The lock covers this one push and
   * nothing else (no fetch, no gate query); how long it was held is measured and logged.
   */
  async function pushMain(sha, base, context) {
    let heldAt = 0;
    const result = await withLock(
      lanesDir && join(lanesDir, "main-update.lock"),
      async () => {
        heldAt = now();
        await hooks.beforeLandPush?.(context);
        return git(
          [
            "push",
            "--porcelain",
            remote,
            `${sha}:refs/heads/${mainBranch}`,
            `--force-with-lease=refs/heads/${mainBranch}:${base}`,
          ],
          { allowFail: true },
        );
      },
      { sleep, now },
    );
    const lockMs = Math.max(0, now() - heldAt);
    log(`main lock held ${lockMs} ms`);
    return { ...result, lockMs };
  }

  async function afterLanding(event) {
    const { main, base, branch, included } = event;
    log(`landed ${branch}: main ${short(base)} -> ${short(main)} (${prList(included)})`);
    for (const i of included) {
      await commentOnce(i.number, null, `Landed in main ${main} via merge train \`${branch}\`.`);
      try {
        const pr = await provider.getPr(i.number);
        if (pr?.queued) await provider.removeLabel(i.number);
      } catch (error) {
        log(`warning: could not unlabel #${i.number}: ${error.message}`);
      }
    }
    if (mergeLog) {
      try {
        mkdirSync(dirname(mergeLog), { recursive: true });
        appendFileSync(
          mergeLog,
          `${new Date(now()).toISOString()} | merge-train | LANDED ${main} SHIP | ${branch} on ${short(base)}: ${included.map((i) => `#${i.number}@${short(i.head)}`).join(" ")}\n`,
        );
      } catch (error) {
        log(`warning: could not append ${mergeLog}: ${error.message}`);
      }
    }
    log(`SHIP ${main}`);
    let hookError = null;
    if (onLanded) {
      try {
        await onLanded({ ...event, log });
      } catch (error) {
        hookError = error.message;
        log(`warning: on-landed hook failed: ${error.message}`);
      }
    }
    return { landed: true, ...event, hookError };
  }

  // A PR-specific landing would bypass compatible queued work and exact candidate gating.
  async function landPr() {
    throw new Error("land --pr is disabled; submit the PR to the shared merge queue and run the train");
  }

  async function waitForGate(sha, { branch, timeoutMs = 150 * 60_000, pollMs = 30_000 } = {}) {
    const start = now();
    const candidate = branch ? await parseCandidate(branch, sha) : null;
    let last = null;
    for (;;) {
      if (candidate) {
        const main = await withNamespace(async (ns) => {
          if (!(await fetchRetry([`+refs/heads/${mainBranch}:${ns}/main`]))) return null;
          return rev(`${ns}/main`);
        });
        let reason = main && main !== candidate.base ? "main advanced while gating" : null;
        for (const item of reason ? [] : candidate.included) {
          const pr = await provider.getPr(item.number);
          if (
            pr &&
            (!pr.open ||
              !pr.queued ||
              pr.draft ||
              pr.crossRepository ||
              pr.baseRef !== mainBranch ||
              pr.head !== item.head)
          ) {
            reason = `#${item.number} changed while gating`;
            break;
          }
        }
        if (reason) {
          await retire(candidate, reason);
          return { state: "stale", reason };
        }
      }
      const gate = await provider.gateStatus(sha, branch);
      if (gate.state !== last) log(`gate for ${short(sha)}: ${gate.state}${gate.url ? ` ${gate.url}` : ""}`);
      last = gate.state;
      if (gate.state === "success" || gate.state === "failure" || gate.state === "stale") return gate;
      if (now() - start >= timeoutMs) return { ...gate, timedOut: true };
      await sleep(pollMs);
    }
  }

  /**
   * One coordinator per machine, many lanes. `run`, `build` and `land` all take this lease, so a second
   * coordinator refuses instead of racing (two rogue loops once re-pushed stale candidates for hours, and on
   * 2026-10-06 a second account's `build` loop cancelled the coordinator's gates for hours). The CLI keeps it at
   * one machine-wide path (`machineLeasePath`), never per checkout. The lease carries a heartbeat; a dead or
   * silent holder is replaced. Processes that share a non-empty `leaseOwner` (KALCODE_TRAIN_OWNER) act under one
   * lease, so a coordinator's own hand-driven `build`/`land` are not refused by its `run`.
   */
  function acquireLease() {
    const noop = Object.assign(() => {}, { beat: () => {} });
    const path = leasePath ?? (lanesDir && join(lanesDir, "coordinator.lock"));
    if (!path) return noop;
    mkdirSync(dirname(path), { recursive: true });
    const read = () => {
      try {
        return JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return null;
      }
    };
    // A coordinator still on the per-checkout lease (target/lanes/coordinator.lock, before the machine-wide path)
    // is honoured too, so a mixed rollout can never run two coordinators.
    const legacyPath = lanesDir && join(lanesDir, "coordinator.lock");
    if (legacyPath && resolve(legacyPath) !== resolve(path)) {
      let legacy = null;
      try {
        legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
      } catch {}
      if (
        legacy &&
        legacy.pid !== process.pid &&
        isProcessAlive(legacy.pid) &&
        now() - Number(legacy.heartbeatAt) < leaseMs
      ) {
        throw new Error(
          `coordinator already running (pid ${legacy.pid}, since ${new Date(legacy.startedAt).toISOString()}); ` +
            `one coordinator per machine: ${legacyPath}`,
        );
      }
    }
    const held = read();
    const sharedOwner = Boolean(leaseOwner) && held?.owner === leaseOwner;
    const live = held && isProcessAlive(held.pid) && now() - Number(held.heartbeatAt) < leaseMs;
    if (live && held.pid !== process.pid && !sharedOwner) {
      const who = [held.owner && `owner ${held.owner}`, held.cwd && `in ${held.cwd}`].filter(Boolean).join(", ");
      throw new Error(
        `coordinator already running (pid ${held.pid}${who ? `, ${who}` : ""}, since ${new Date(held.startedAt).toISOString()}); ` +
          `one coordinator per machine: ${path}`,
      );
    }
    if (live && sharedOwner && held.pid !== process.pid) {
      // Borrow the owner's lease: keep it fresh, never release it on the holder's behalf.
      return Object.assign(() => {}, {
        beat: () => {
          const current = read();
          if (current?.owner === leaseOwner)
            writeFileSync(path, `${JSON.stringify({ ...current, heartbeatAt: now() })}\n`);
        },
      });
    }
    const lease = { pid: process.pid, owner: leaseOwner || null, cwd: repo, startedAt: now(), heartbeatAt: now() };
    // Write then re-read: of two simultaneous takers, only the one whose record survives proceeds.
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, `${JSON.stringify(lease)}\n`);
    renameSync(tmp, path);
    if (read()?.pid !== process.pid)
      throw new Error(`coordinator lease taken concurrently; one coordinator per machine: ${path}`);
    const release = () => {
      try {
        if (read()?.pid === process.pid) unlinkSync(path);
      } catch {}
    };
    return Object.assign(release, {
      beat: () => writeFileSync(path, `${JSON.stringify({ ...lease, heartbeatAt: now() })}\n`),
    });
  }

  /**
   * Advances every lane at once: build or reuse all stacked levels (they gate concurrently), land the deepest
   * green level (it supersedes the levels below it), and attribute a red level to its own lane only:
   * bisect a multi-PR lane, eject a single PR. Never re-pushes a candidate whose base is no longer main.
   */
  async function run({ maxRounds = 24, timeoutMs = 150 * 60_000, pollMs = 30_000 } = {}) {
    const release = acquireLease();
    const landed = [];
    const start = now();
    try {
      for (let round = 1; round <= maxRounds; round++) {
        release.beat();
        const all = await buildAll();
        if (!all.levels.length) return { status: "idle", landed, skipped: all.skipped };
        const gates = [];
        for (const level of all.levels) gates.push(await provider.gateStatus(level.sha, level.branch));
        updateState((state) => {
          all.levels.forEach((level, k) => {
            for (const i of level.included) {
              if (gates[k].state === "pending") prEvent(state, i.number, "gateStartedAt");
              if (gates[k].state === "success") prEvent(state, i.number, "greenAt");
            }
          });
        });

        // Attribute a red level to its own lane when everything below it is green (or it is the bottom).
        let attributed = false;
        for (let k = 0; k < all.levels.length && !attributed; k++) {
          if (gates[k].state !== "failure") continue;
          if (k > 0 && gates[k - 1].state !== "success") break;
          attributed = true;
          const level = all.levels[k];
          const lanePrs = level.included.filter((i) => level.added.includes(i.number));
          if (lanePrs.length === 1) {
            await ejectPr(lanePrs[0], level);
          } else {
            updateState((state) => {
              state.bisect ??= {};
              const laneKey = headsKey(
                level.laneNumbers
                  .map((n) => ({ number: n, head: level.included.find((i) => i.number === n)?.head }))
                  .filter((i) => i.head),
              );
              const limit = Math.ceil(lanePrs.length / 2);
              state.bisect[laneKey] = { limit, at: now() };
              log(`bisecting lane [${level.laneNumbers.map((n) => `#${n}`).join(" ")}]: trying the first ${limit}`);
            });
          }
          // Every level built on the red one is now pointless: SUPERSEDED.
          for (const above of all.levels.slice(k))
            await retire(above, `built on red ${level.branch}`, { supersededBy: "bisect" });
        }
        if (attributed) continue;

        const green = all.levels
          .map((level, k) => ({ level, gate: gates[k] }))
          .filter((g) => g.gate.state === "success");
        const deepest = green.at(-1)?.level;
        if (deepest) {
          const result = await land(deepest.branch);
          if (result.landed) {
            landed.push(result);
            continue; // levels above it still fast-forward from the new main without re-gating
          }
          if (
            !["main-moved", "stale-pr", "gate-not-green", "missing-candidate", "already-landed"].includes(result.reason)
          ) {
            return { status: "refused", landed, result };
          }
          continue;
        }
        if (now() - start >= timeoutMs) return { status: "timeout", landed, levels: all.levels };
        await sleep(pollMs);
      }
      return { status: "max-rounds", landed };
    } finally {
      release();
    }
  }

  async function ejectPr(item, level) {
    log(
      `gate failed for ${level.branch} with only #${item.number} new in its lane; removing #${item.number} from the queue`,
    );
    await commentOnce(
      item.number,
      `eject:${short(level.sha)}`,
      `Removed from the merge queue: the gate failed for merge-train candidate \`${level.branch}\` (${short(level.sha)}), where this PR (head ${short(item.head)}) was the only new change on a green base.\n\nFix the failure, then resubmit with \`node tooling/merge-train/train.mjs submit ${item.number}\`.`,
    );
    try {
      await provider.removeLabel(item.number);
    } catch (error) {
      log(`warning: could not unlabel #${item.number}: ${error.message}`);
    }
    updateState((state) => prEvent(state, item.number, "failedAt"));
  }

  /** Queue, candidates, and every PR's pipeline state with its timings (ms). */
  async function status() {
    return withNamespace(async (ns) => {
      const snap = await snapshot(ns);
      const queue = await provider.listQueue();
      const candidates = [];
      for (const c of snap.candidates) {
        candidates.push({
          ...c,
          current: !c.invalid && (c.base === snap.base || c.chain?.includes(snap.base)),
          gate: c.invalid ? null : await provider.gateStatus(c.sha, c.branch),
        });
      }
      const state = loadState();
      const span = (a, b) => (a && b ? b - a : null);
      const seen = new Set([...queue.map((p) => p.number), ...Object.keys(state.prs).map(Number)]);
      const prs = [];
      for (const number of [...seen].sort((a, b) => a - b)) {
        const events = state.prs[number] ?? {};
        const queued = queue.find((p) => p.number === number);
        const candidate = candidates.find(
          (c) =>
            !c.invalid &&
            c.current &&
            c.included.some((i) => i.number === number && (!queued?.head || i.head === queued.head)),
        );
        let name;
        if (events.mergedAt && !queued) name = "MERGED";
        else if (events.landingAt && !events.mergedAt) name = "LANDING";
        else if (candidate?.gate?.state === "success") name = "GREEN";
        else if (candidate?.gate?.state === "failure") name = "FAILED";
        else if (candidate?.gate?.state === "pending") name = "GATING";
        else if (candidate) name = `MERGE GROUP ${candidate.branch.slice(BRANCH_PREFIX.length)}`;
        else if (events.supersededFrom && !queued) name = "SUPERSEDED";
        else if (queued) name = "READY FOR INTEGRATION";
        else name = "BUILDING";
        const queuedAt = queued?.queuedAt ? Date.parse(queued.queuedAt) : null;
        prs.push({
          number,
          state: name,
          head: queued?.head ?? null,
          candidate: candidate?.branch ?? null,
          supersededFrom: events.supersededFrom ?? null,
          timings: {
            queueWaitMs: span(queuedAt, events.groupedAt),
            conflictWaitMs: span(events.conflictSince, events.groupedAt),
            gateMs: span(events.gateStartedAt ?? events.groupedAt, events.greenAt ?? events.failedAt),
            toLandMs: span(queuedAt ?? events.groupedAt, events.mergedAt),
          },
        });
      }
      return { main: snap.base, queue, candidates, prs };
    });
  }

  async function submit(number) {
    await provider.ensureLabel();
    const pr = await provider.getPr(number);
    if (!pr?.open) throw new Error(`#${number} is not an open pull request`);
    if (pr.draft) throw new Error(`#${number} is a draft; mark it ready first`);
    if (pr.crossRepository) throw new Error(`#${number} comes from a fork; the train never runs fork code`);
    if (pr.baseRef !== mainBranch) throw new Error(`#${number} targets ${pr.baseRef}, not ${mainBranch}`);
    if (!pr.queued) await provider.addLabel(number);
    const queue = await provider.listQueue();
    const position = queue.findIndex((p) => p.number === number) + 1;
    if (!pr.queued) {
      await commentOnce(
        number,
        null,
        `Submitted to the merge train at head ${short(pr.head)} (queue position ${position || "?"}). Any agent's \`node tooling/merge-train/train.mjs run\` will batch, gate and land it.`,
      );
    }
    log(`#${number} ${pr.queued ? "was already" : "is now"} queued (position ${position || "?"} of ${queue.length})`);
    return { number, position, head: pr.head };
  }

  return { submit, build, buildAll, plan, land, landPr, run, status, waitForGate, parseCandidate, acquireLease };
}

// ---------------------------------------------------------------------------------------------- CLI

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The machine-wide coordinator lease: one file for every checkout, clone, worktree and account on this machine
 * (the per-checkout target/lanes lease let a second coordinator run beside the first). KALCODE_TRAIN_LOCK_DIR
 * overrides the directory.
 */
export function machineLeasePath({ env = process.env, platform = process.platform } = {}) {
  const dir =
    env.KALCODE_TRAIN_LOCK_DIR ||
    (platform === "win32"
      ? join(env.ProgramData || "C:\\ProgramData", "KalCode", "merge-train")
      : platform === "darwin"
        ? "/Users/Shared/KalCode/merge-train"
        : "/var/tmp/kalcode-merge-train");
  return join(dir, "coordinator.lock");
}

/** Shared lanes dir: the primary checkout's target/lanes when it exists (all worktrees see it), else local. */
export function resolveLanesDir(toplevel, commonDir) {
  const primary = join(dirname(resolve(commonDir)), "target", "lanes");
  return existsSync(primary) ? primary : join(toplevel, "target", "lanes");
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") opts.json = true;
    else if (a === "--pr") {
      throw new Error("land --pr is disabled; submit the PR to the shared merge queue and run the train");
    } else if (["--timeout-min", "--poll-sec", "--max-rounds"].includes(a)) {
      const v = Number(rest[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`${a} needs a positive number`);
      opts[a.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = v;
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else opts.positional.push(a);
  }
  const need = { submit: 1, land: opts.pr ? 0 : 1, build: 0, plan: 0, run: 0, status: 0 }[command];
  if (need === undefined || opts.positional.length !== need || (opts.pr && command !== "land")) {
    throw new Error("usage: train.mjs submit <pr> | plan | build | land <merge-train/branch> | run | status [--json]");
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const cwdGit = makeGit(process.cwd());
  const toplevel = (await cwdGit(["rev-parse", "--show-toplevel"])).stdout.trim();
  const commonDir = (await cwdGit(["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const lanesDir = resolveLanesDir(toplevel, commonDir);
  const { createGitHubProvider } = await import("./github.mjs");
  const provider = await createGitHubProvider({ repo: toplevel });
  const hookPath = join(HERE, "on-landed.mjs");
  const onLanded = existsSync(hookPath)
    ? async (event) =>
        (await import(pathToFileURL(hookPath).href)).default({ ...event, mainCheckout: dirname(resolve(commonDir)) })
    : null;
  const train = createTrain({
    repo: toplevel,
    provider,
    lanesDir,
    mergeLog: join(lanesDir, "merge-log.md"),
    onLanded,
    resolvers: [releaseRecordResolver],
    leasePath: machineLeasePath(),
    leaseOwner: process.env.KALCODE_TRAIN_OWNER || null,
  });
  if (opts.command === "submit") {
    const n = Number(opts.positional[0].replace(/^#/, ""));
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("submit needs a PR number");
    await train.submit(n);
    return 0;
  }
  if (opts.command === "plan") {
    const p = await train.plan();
    if (opts.json)
      process.stdout.write(`${JSON.stringify({ base: p.base, lanes: p.lanes, reasons: p.reasons }, null, 2)}\n`);
    else
      for (const lane of p.lanes)
        process.stdout.write(`lane ${lane.id}: ${lane.numbers.map((n) => `#${n}`).join(" ")}\n`);
    return 0;
  }
  // build and land push candidates or main, so they take the machine-wide coordinator lease, as run does.
  if (opts.command === "build" || opts.command === "land") {
    const release = train.acquireLease();
    try {
      if (opts.command === "build") {
        const m = await train.buildAll();
        if (opts.json) process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
        return 0;
      }
      const result = opts.pr ? await train.landPr(opts.pr) : await train.land(opts.positional[0]);
      return result.landed ? 0 : 1;
    } finally {
      release();
    }
  }
  if (opts.command === "run") {
    const r = await train.run({
      maxRounds: opts.maxRounds,
      timeoutMs: opts.timeoutMin && opts.timeoutMin * 60_000,
      pollMs: opts.pollSec && opts.pollSec * 1000,
    });
    process.stdout.write(
      `merge train: ${r.status}; landed ${r.landed.map((l) => short(l.main)).join(", ") || "nothing"}\n`,
    );
    return r.status === "idle" ? 0 : 1;
  }
  const s = await train.status();
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`main ${short(s.main)}\nqueue (${s.queue.length}):\n`);
  for (const pr of s.queue)
    process.stdout.write(`  #${pr.number} ${short(pr.head ?? "?".repeat(12))} ${pr.title ?? ""}\n`);
  process.stdout.write(`candidates (${s.candidates.length}):\n`);
  for (const c of s.candidates) {
    const what = c.invalid
      ? "not a train candidate"
      : `${prList(c.included)}; gate ${c.gate.state}${c.current ? "" : "; stale base"}`;
    process.stdout.write(`  ${c.branch} ${short(c.sha)}: ${what}\n`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`[merge-train] ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
