// The merge train's GitHub seam, through the `gh` CLI the agents are already signed in to. Every call is
// small and bounded; nothing here touches git.
import { spawn } from "node:child_process";
import { GATE_JOB, QUEUE_LABEL } from "./train.mjs";

export const GATE_WORKFLOW = "gate.yml";

export function makeGh({ cwd, timeoutMs = 60_000 } = {}) {
  return (args, { input, allowFail = false } = {}) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn("gh", args, {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d) => {
        stdout += d;
      });
      child.stderr.setEncoding("utf8").on("data", (d) => {
        stderr += d;
      });
      child.on("error", (error) => reject(new Error(`gh ${args[0]}: ${error.message}`)));
      child.on("close", (code) => {
        if (code !== 0 && !allowFail)
          reject(new Error(`gh ${args.slice(0, 2).join(" ")}: ${stderr.trim() || `exit ${code}`}`));
        else resolvePromise({ code, stdout, stderr });
      });
      child.stdin.end(input ?? "");
    });
}

/** owner/name from a GitHub remote URL (https or ssh). */
export function parseSlug(url) {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!m) throw new Error(`origin is not a GitHub remote: ${url.trim()}`);
  return `${m[1]}/${m[2]}`;
}

/**
 * Gate evidence for an exact commit: the latest gate.yml run whose head_sha is that commit, and its
 * "Gate (Windows)" job. Anything but a completed successful job is not green.
 */
export function isCandidateRun(run, sha, branch) {
  return (
    /^[0-9a-f]{40}$/.test(sha ?? "") &&
    /^merge-train\/[0-9a-f]{12}-[0-9a-f]{8}$/.test(branch ?? "") &&
    run.head_sha === sha &&
    run.head_branch === branch &&
    run.event === "push" &&
    run.path === ".github/workflows/gate.yml"
  );
}

export function isMainPcJob(job, sha) {
  return (
    job.head_sha === sha &&
    job.runner_name === "kalcode-win-gate" &&
    job.labels?.includes("kalcode-gate") &&
    !job.labels.includes("kalcode-gate-2")
  );
}

export function gateStateFrom(runs, jobs, sha, branch) {
  const run = runs[0];
  if (!run || !isCandidateRun(run, sha, branch)) return { state: "missing" };
  const matching = jobs.filter((j) => j.name === GATE_JOB);
  if (!matching.length) return { state: "pending", url: run.html_url };
  if (matching.length !== 1) return { state: "stale", url: run.html_url };
  const job = matching[0];
  const url = job.html_url ?? run.html_url;
  if (job.status !== "completed") return { state: "pending", url };
  if (!isMainPcJob(job, sha)) return { state: "stale", url };
  if (job.conclusion === "success") {
    const gate = job.steps?.find((step) => step.name === "Gate");
    return { state: gate?.status === "completed" && gate.conclusion === "success" ? "success" : "stale", url };
  }
  if (job.conclusion === "failure" || job.conclusion === "timed_out") return { state: "failure", url };
  return { state: "stale", url, conclusion: job.conclusion };
}

/**
 * What a pull_request "Gate (Windows)" job actually tested, from its log: actions/checkout fetches the exact
 * merge commit (`+<sha>:refs/remotes/pull/<n>/merge`) and reports `Merge <head> into <base>`; the gate prints
 * how many changed files it checked (`gate: lanes ...; N changed file(s)`), which exposes a vacuous pass.
 */
export function parseGateLog(text, number) {
  const merge = new RegExp(`\\+([0-9a-f]{40}):refs/remotes/pull/${Number(number)}/merge\\b`).exec(text);
  const parents = /HEAD is now at [0-9a-f]+ Merge ([0-9a-f]{40}) into ([0-9a-f]{40})/.exec(text);
  const counts = [...text.matchAll(/gate: lanes [^;\n]*; (\d+) changed file/g)].map((m) => Number(m[1]));
  return {
    testedMerge: merge?.[1] ?? null,
    testedHead: parents?.[1] ?? null,
    testedBase: parents?.[2] ?? null,
    changedFiles: counts.length === 1 ? counts[0] : 0,
  };
}

/** Queue order: when the `merge-queue` label was (last) added; PR number breaks ties. */
export function queueFromGraphql(data, mainBranch = "main") {
  const nodes = data?.data?.repository?.pullRequests?.nodes ?? [];
  return nodes
    .filter((n) => !n.isDraft && !n.isCrossRepository && n.baseRefName === mainBranch)
    .map((n) => {
      const labeled = (n.timelineItems?.nodes ?? [])
        .filter((e) => e?.label?.name === QUEUE_LABEL)
        .map((e) => e.createdAt);
      return {
        number: n.number,
        title: n.title,
        head: n.headRefOid,
        headRef: n.headRefName,
        fetchRef: `refs/pull/${n.number}/head`,
        queuedAt: labeled.sort().at(-1) ?? "",
      };
    })
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.number - b.number);
}

const QUEUE_QUERY = `query($owner:String!,$name:String!,$label:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,labels:[$label],first:100){nodes{number title isDraft isCrossRepository baseRefName headRefName headRefOid timelineItems(itemTypes:[LABELED_EVENT],last:20){nodes{... on LabeledEvent{createdAt label{name}}}}}}}}`;

export async function createGitHubProvider({ repo, slug = null, gh = makeGh({ cwd: repo }), mainBranch = "main" }) {
  if (!slug) {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf8", windowsHide: true });
    slug = parseSlug(r.stdout ?? "");
  }
  const [owner, name] = slug.split("/");
  const json = async (args) => JSON.parse((await gh(args)).stdout);

  return {
    slug,
    async listQueue() {
      const data = await json([
        "api",
        "graphql",
        "-f",
        `query=${QUEUE_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `label=${QUEUE_LABEL}`,
      ]);
      return queueFromGraphql(data, mainBranch);
    },
    async getPr(number) {
      const r = await gh(
        [
          "pr",
          "view",
          String(number),
          "-R",
          slug,
          "--json",
          "number,title,state,isDraft,isCrossRepository,baseRefName,headRefOid,labels",
        ],
        { allowFail: true },
      );
      if (r.code !== 0) return null;
      const p = JSON.parse(r.stdout);
      return {
        number: p.number,
        title: p.title,
        open: p.state === "OPEN",
        draft: p.isDraft,
        crossRepository: p.isCrossRepository,
        baseRef: p.baseRefName,
        head: p.headRefOid,
        queued: p.labels.some((l) => l.name === QUEUE_LABEL),
        fetchRef: `refs/pull/${p.number}/head`,
        mergeRef: `refs/pull/${p.number}/merge`,
      };
    },
    async ensureLabel() {
      const r = await gh(
        [
          "label",
          "create",
          QUEUE_LABEL,
          "-R",
          slug,
          "--color",
          "0E8A16",
          "--description",
          "Ready to land via the KalCode merge train (batched, exact candidate gated)",
        ],
        { allowFail: true },
      );
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) throw new Error(`gh label create: ${r.stderr.trim()}`);
    },
    addLabel: (number) => gh(["pr", "edit", String(number), "-R", slug, "--add-label", QUEUE_LABEL]),
    removeLabel: (number) => gh(["pr", "edit", String(number), "-R", slug, "--remove-label", QUEUE_LABEL]),
    comment: (number, body) => gh(["pr", "comment", String(number), "-R", slug, "--body-file", "-"], { input: body }),
    async hasComment(number, marker) {
      const r = await gh(["api", "--paginate", `repos/${slug}/issues/${number}/comments`, "--jq", ".[].body"]);
      return r.stdout.includes(`<!-- merge-train:${marker} -->`);
    },
    async gateStatus(sha, branch) {
      const runs = (
        await json(["api", `repos/${slug}/actions/workflows/${GATE_WORKFLOW}/runs?head_sha=${sha}&per_page=20`])
      ).workflow_runs
        .filter((r) => isCandidateRun(r, sha, branch))
        .sort((a, b) => b.id - a.id);
      if (!runs.length) return { state: "missing" };
      const jobs = (await json(["api", `repos/${slug}/actions/runs/${runs[0].id}/jobs?per_page=50`])).jobs;
      return gateStateFrom(runs, jobs, sha, branch);
    },
  };
}
