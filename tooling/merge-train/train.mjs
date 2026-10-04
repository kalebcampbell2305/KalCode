#!/usr/bin/env node
// KalCode's shared merge train (AGENTS.md "Permanent parallel integration rule"). Every agent, Claude Code or
// Codex, lands work on main only through this train:
//
//   node tooling/merge-train/train.mjs submit <pr>       queue a validated PR (adds the `merge-queue` label)
//   node tooling/merge-train/train.mjs build             merge the queue onto one main snapshot, push the candidate
//   node tooling/merge-train/train.mjs land <branch>     fast-forward main to a candidate whose exact SHA gated green
//   node tooling/merge-train/train.mjs run               build -> wait for the gate -> land, until the queue is done
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
    !/ {2}push:\n(?:\s+#.*\n)* {4}branches: \[main, "merge-train\/\*\*"\]/.test(workflow) ||
    !/ {4}runs-on: \[self-hosted, Windows, kalcode-gate\]\n/.test(windows) ||
    !windows.includes("name: Gate\n") ||
    !windows.includes("trailers:key=Merge-Train-Base,valueonly")
  ) {
    throw new Error(
      "candidate gate workflow must trigger merge-train pushes on the main Windows PC and gate its recorded base",
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
        { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env }, windowsHide: true, timeout: timeoutMs },
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
      child.stdin.end(input ?? "");
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
}) {
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
      included.unshift({ number: Number(prField), head: parentList[1] });
    }
    if (!base || included.length === 0 || !base.startsWith(m[1])) return null;
    return { branch, sha, base, included };
  }

  async function mergeTrees(tip, head) {
    const r = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", tip, head], {
      allowFail: true,
    });
    const parts = r.stdout.split("\0").filter(Boolean);
    if (r.code === 0) return { tree: parts[0] };
    if (r.code === 1) return { conflicts: [...new Set(parts.slice(1))].sort() };
    throw new GitError(`git merge-tree ${short(tip)} ${short(head)}: ${r.stderr.trim()}`);
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

  async function build() {
    return withNamespace(async (ns) => {
      const snap = await snapshot(ns);
      const { base } = snap;
      const queue = await provider.listQueue();
      await fetchHeads(ns, queue);
      const active = new Map(queue.map((pr) => [pr.number, pr]));

      // Candidates on an older main can never land (main's lease would refuse them); retire them.
      const current = [];
      for (const c of snap.candidates) {
        if (c.invalid) continue;
        if (c.base === base) current.push(c);
        else if (await isAncestor(c.base, base)) await deleteRemote(c.branch, c.sha);
      }
      for (const c of current) c.gate = await provider.gateStatus(c.sha, c.branch);

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
      if (reusable.length) {
        const manifest = manifestFor(reusable[0], "reused");
        writeManifest(manifest);
        log(`reusing ${manifest.branch} (${short(manifest.candidate)}; gate ${reusable[0].gate.state})`);
        return manifest;
      }

      // Gate failures bisect: the smallest failed candidate whose PRs are all still queued at the same heads
      // is halved; a failed single-PR candidate ejects that PR. One failing PR never blocks the others for long.
      let selection = null;
      for (;;) {
        const failed = current
          .filter((c) => c.gate.state === "failure" && fresh(c, active))
          .sort((a, b) => a.included.length - b.included.length)[0];
        if (!failed) break;
        if (failed.included.length === 1) {
          await eject(failed);
          active.delete(failed.included[0].number);
          continue;
        }
        selection = new Set(failed.included.slice(0, Math.ceil(failed.included.length / 2)).map((i) => i.number));
        log(`bisecting failed ${failed.branch}: trying ${[...selection].map((n) => `#${n}`).join(", ")}`);
        break;
      }

      let tip = base;
      const included = [];
      const skipped = [];
      for (const pr of active.values()) {
        if (selection && !selection.has(pr.number)) continue;
        if (!pr.head) {
          skipped.push({ number: pr.number, reason: "head-unavailable", files: [], conflictsWith: [] });
          continue;
        }
        if (await isAncestor(pr.head, base)) {
          skipped.push({ number: pr.number, head: pr.head, reason: "already-in-main", files: [], conflictsWith: [] });
          continue;
        }
        let merged = await mergeTrees(tip, pr.head);
        let resolvedBy = null;
        for (const resolver of merged.conflicts ? resolvers : []) {
          const tree = await resolver.resolve({ git, base, tip, pr, files: merged.conflicts });
          if (tree) {
            merged = { tree };
            resolvedBy = resolver.name;
            break;
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
          s.reason === "conflicts-with-main"
            ? `conflicts with main ${short(base)}; rebase or merge main into the PR (the label stays, so it retries automatically after your push)`
            : `conflicts with ${s.conflictsWith.map((n) => `#${n}`).join(", ")}, which are ahead of it in this train; it retries on the next train once they land`;
        await commentOnce(
          s.number,
          `skip:${short(base)}:${short(s.head)}`,
          `Merge train skipped this PR at head ${short(s.head)}: it ${why}.\n\nConflicting files:\n${s.files.map((f) => `- \`${f}\``).join("\n")}`,
        );
      }

      if (included.length === 0) {
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
          JSON.stringify(theirs.included) !== JSON.stringify(included.map(({ number, head }) => ({ number, head })))
        ) {
          throw new GitError(`could not push ${branch}: ${push.stderr.trim() || push.stdout.trim()}`);
        }
        const manifest = manifestFor(theirs, "reused", skipped);
        writeManifest(manifest);
        log(`reusing ${branch} (${short(theirs.sha)}), created concurrently by another coordinator`);
        return manifest;
      }

      const manifest = manifestFor(candidate, "built", skipped);
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
      if (gate.state !== "success") return refuse("gate-not-green", `${GATE_JOB} for ${short(sha)} is ${gate.state}`);
      for (const i of c.included) {
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
      if (main !== c.base) return refuse("main-moved", `main is ${short(main)}, candidate base ${short(c.base)}`);

      // The lease is the atomic compare-and-swap: main moves to the candidate only if it is still BASE.
      const push = await pushMain(sha, c.base, c);
      if (push.code !== 0) return refuse("main-moved", "main changed during landing; the lease refused the update");
      await deleteRemote(branch, sha);
      writeManifest({ ...manifestFor(c, "landed"), main: sha });
      return afterLanding({ main: sha, base: c.base, branch, included: c.included });
    });
  }

  /** The atomic main update: main moves to `sha` only if it is still `base`. */
  function pushMain(sha, base, context) {
    return withLock(
      lanesDir && join(lanesDir, "main-update.lock"),
      async () => {
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
    let last = null;
    for (;;) {
      const gate = await provider.gateStatus(sha, branch);
      if (gate.state !== last) log(`gate for ${short(sha)}: ${gate.state}${gate.url ? ` ${gate.url}` : ""}`);
      last = gate.state;
      if (gate.state === "success" || gate.state === "failure" || gate.state === "stale") return gate;
      if (now() - start >= timeoutMs) return { ...gate, timedOut: true };
      await sleep(pollMs);
    }
  }

  async function run({ maxRounds = 12, timeoutMs, pollMs } = {}) {
    const landed = [];
    for (let round = 1; round <= maxRounds; round++) {
      const built = await build();
      if (built.action === "idle") return { status: "idle", landed, skipped: built.skipped };
      const gate = await waitForGate(built.candidate, { branch: built.branch, timeoutMs, pollMs });
      if (gate.timedOut) return { status: "timeout", landed, branch: built.branch, candidate: built.candidate };
      if (gate.state !== "success") continue; // the next build bisects or re-triggers it
      const result = await land(built.branch);
      if (result.landed) landed.push(result);
      else if (!["main-moved", "stale-pr", "gate-not-green", "missing-candidate"].includes(result.reason)) {
        return { status: "refused", landed, result };
      }
    }
    return { status: "max-rounds", landed };
  }

  async function status() {
    return withNamespace(async (ns) => {
      const snap = await snapshot(ns);
      const queue = await provider.listQueue();
      const candidates = [];
      for (const c of snap.candidates) {
        candidates.push({
          ...c,
          current: c.base === snap.base,
          gate: c.invalid ? null : await provider.gateStatus(c.sha, c.branch),
        });
      }
      return { main: snap.base, queue, candidates };
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

  return { submit, build, land, landPr, run, status, waitForGate, parseCandidate };
}

// ---------------------------------------------------------------------------------------------- CLI

const HERE = dirname(fileURLToPath(import.meta.url));

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
  const need = { submit: 1, land: opts.pr ? 0 : 1, build: 0, run: 0, status: 0 }[command];
  if (need === undefined || opts.positional.length !== need || (opts.pr && command !== "land")) {
    throw new Error("usage: train.mjs submit <pr> | build | land <merge-train/branch> | run | status [--json]");
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
  });
  if (opts.command === "submit") {
    const n = Number(opts.positional[0].replace(/^#/, ""));
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error("submit needs a PR number");
    await train.submit(n);
    return 0;
  }
  if (opts.command === "build") {
    const m = await train.build();
    if (opts.json) process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
    return 0;
  }
  if (opts.command === "land") {
    const result = opts.pr ? await train.landPr(opts.pr) : await train.land(opts.positional[0]);
    return result.landed ? 0 : 1;
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
