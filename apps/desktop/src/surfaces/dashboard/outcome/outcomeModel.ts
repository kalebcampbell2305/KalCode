/**
 * An agent's outcome: what its work amounted to, as separate stages that never borrow each
 * other's truth. AGENT (the shared agent state), CHANGES (files and where they live), TESTS (a
 * linked Operations test run), MERGE (the agent worktree's Git facts) and RELEASE (a linked
 * Operations release or deployment). Each row comes from observed state only: a stage KalCode
 * hasn't observed says so (`known: false`) or is left out, and nothing is inferred from another
 * stage — an agent being DONE never implies its change was verified, merged or shipped.
 */
import {
  AGENT_STATE_LABEL,
  AGENT_STATE_TEXT,
  AGENT_STATE_TONE,
  agentStateOf,
  type OperationEnvironment,
  type OperationRecord,
  type OperationTestResult,
  type StatusTone,
  type ThreadSummary,
  type ThreadWorktreeState,
} from "@kalcode/protocol";
import { mergeReadiness } from "../fleet/fleetModel.ts";

export type OutcomeStage = "agent" | "changes" | "tests" | "merge" | "release";

/** Status tones, plus `accent` for "ready for the next step" (KalCode's electric blue). */
export type OutcomeTone = StatusTone | "accent";

export interface OutcomeRow {
  stage: OutcomeStage;
  /** The stage's name ("Tests"). */
  label: string;
  /** What was observed ("19/19 passed"), or why nothing is known ("No test run recorded"). */
  value: string;
  /** The stage in the one-line summary, readable without its label ("Tests 19/19 passed"). */
  short: string;
  /** Secondary facts (branch, base, version). */
  detail: string | null;
  tone: OutcomeTone;
  /** Observed. Unknown rows are shown only in the full list, never in the one-line summary. */
  known: boolean;
}

/** A row before its one-line form is derived. */
type Draft = Omit<OutcomeRow, "short">;

export interface OutcomeEvidence {
  /** Operations runs (any; only those linked to this agent's thread are used). */
  runs?: readonly OperationRecord[];
  /** Results of the agent's latest linked test run, when its detail has been read. */
  tests?: readonly OperationTestResult[] | null;
  /** Environments Operations observed (only those a linked run deployed are used). */
  environments?: readonly OperationEnvironment[];
}

export const STAGE_LABEL: Record<OutcomeStage, string> = {
  agent: "Agent",
  changes: "Changed",
  tests: "Tests",
  merge: "Merge",
  release: "Release",
};

const ENVIRONMENT_LABEL: Record<OperationEnvironment["kind"], string> = {
  local: "Local",
  preview: "Preview",
  staging: "Staging",
  production: "Production",
};

function at(record: OperationRecord): number {
  const t = Date.parse(record.startedAt ?? record.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/** The agent's linked runs of the given kinds, newest first. */
export function linkedRuns(
  threadId: string,
  runs: readonly OperationRecord[] | undefined,
  kinds: readonly OperationRecord["spec"]["kind"][],
): OperationRecord[] {
  return (runs ?? [])
    .filter((r) => r.threadId === threadId && kinds.includes(r.spec.kind))
    .sort((a, b) => at(b) - at(a));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function agentRow(thread: ThreadSummary): Draft {
  const state = agentStateOf(thread);
  return {
    stage: "agent",
    label: STAGE_LABEL.agent,
    value: AGENT_STATE_LABEL[state],
    detail: null,
    tone: AGENT_STATE_TONE[state],
    known: true,
  };
}

function changesRow(thread: ThreadSummary, worktree: ThreadWorktreeState | undefined): Draft {
  const where = thread.worktreeId
    ? `${thread.branch ?? worktree?.branch ?? "its own branch"} · own worktree`
    : thread.branch
      ? `${thread.branch} · workspace folder`
      : "Workspace folder";
  const dirty = worktree ? worktree.changed + worktree.untracked : 0;
  const uncommitted = dirty > 0 ? ` · ${dirty} uncommitted` : "";
  if (thread.filesChanged === null) {
    return {
      stage: "changes",
      label: STAGE_LABEL.changes,
      value: dirty > 0 ? `${dirty} uncommitted` : "Not reported",
      detail: where,
      tone: "muted",
      known: dirty > 0,
    };
  }
  return {
    stage: "changes",
    label: STAGE_LABEL.changes,
    value: thread.filesChanged === 0 ? "No files" : plural(thread.filesChanged, "file"),
    detail: `${where}${uncommitted}`,
    tone: thread.filesChanged === 0 ? "muted" : "working",
    known: true,
  };
}

const PASSED = new Set(["passed", "succeeded", "success", "ok"]);

function testsRow(thread: ThreadSummary, evidence: OutcomeEvidence): Draft {
  const [latest] = linkedRuns(thread.id, evidence.runs, ["test"]);
  const none: Draft = {
    stage: "tests",
    label: STAGE_LABEL.tests,
    value: "No test run recorded",
    detail: null,
    tone: "muted",
    known: false,
  };
  if (!latest) return none;
  const name = latest.spec.name || null;
  const results = evidence.tests ?? null;
  if (results && results.length > 0 && (latest.status === "succeeded" || latest.status === "failed")) {
    const passed = results.filter((r) => PASSED.has(r.status.toLowerCase())).length;
    const failed = results.length - passed;
    return {
      stage: "tests",
      label: STAGE_LABEL.tests,
      value: failed === 0 ? `${passed}/${results.length} passed` : `${failed} of ${results.length} failed`,
      detail: name,
      tone: failed === 0 ? "done" : "failed",
      known: true,
    };
  }
  switch (latest.status) {
    case "queued":
    case "starting":
    case "running":
      return { ...none, value: "Running", detail: name, tone: "working", known: true };
    case "succeeded":
      return { ...none, value: "Passed", detail: name, tone: "done", known: true };
    case "failed":
      return { ...none, value: "Failed", detail: latest.outcome ?? name, tone: "failed", known: true };
    case "cancelled":
    case "interrupted":
      return { ...none, value: "Didn't finish", detail: name, tone: "muted", known: true };
    default:
      return { ...none, value: "Result unknown", detail: name, known: false };
  }
}

function mergeRow(thread: ThreadSummary, worktree: ThreadWorktreeState | undefined): Draft {
  const row = (value: string, tone: OutcomeTone, known: boolean, detail: string | null = null): Draft => ({
    stage: "merge",
    label: STAGE_LABEL.merge,
    value,
    detail,
    tone,
    known,
  });
  if (!thread.worktreeId) return row("No separate branch", "muted", false, "It works in the workspace folder");
  if (!worktree) return row("Not checked yet", "muted", false);
  const base = worktree.baseBranch ?? "the base branch";
  const readiness = mergeReadiness(thread, worktree);
  if (readiness.ready) return row("Ready to merge", "accent", true, `${plural(readiness.ahead, "commit")} → ${base}`);
  const dirty = worktree.changed + worktree.untracked;
  if (worktree.conflicts === true) return row("Would conflict", "failed", true, `With ${base}`);
  if (readiness.reason === "Still working") return row("Not yet", "muted", false, "The agent is still working");
  if (dirty > 0) return row("Uncommitted changes", "waiting", true, plural(dirty, "change"));
  // Every commit on the branch is in the base, and the agent did change files: its work landed
  // (or was folded into another branch that landed). Said as the Git fact, never "shipped".
  if (worktree.ahead === 0 && (thread.filesChanged ?? 0) > 0) {
    return row("No unmerged commits", "done", true, `Everything on ${worktree.branch} is in ${base}`);
  }
  if (worktree.ahead === 0) return row("No commits yet", "muted", true);
  return row(readiness.reason, "muted", !/couldn't|No base/.test(readiness.reason));
}

function releaseRow(thread: ThreadSummary, evidence: OutcomeEvidence): Draft | null {
  const [latest] = linkedRuns(thread.id, evidence.runs, ["release", "deploy"]);
  if (!latest) return null;
  const verb = latest.spec.kind === "release" ? "Released" : "Deployed";
  const version = latest.version ? ` ${latest.version}` : "";
  const row = (value: string, tone: OutcomeTone, detail: string | null): Draft => ({
    stage: "release",
    label: STAGE_LABEL.release,
    value,
    detail,
    tone,
    known: true,
  });
  switch (latest.status) {
    case "queued":
    case "starting":
    case "running":
      return row(latest.spec.kind === "release" ? "Releasing" : "Deploying", "working", latest.spec.name || null);
    case "failed":
      return row(`${latest.spec.kind === "release" ? "Release" : "Deploy"} failed`, "failed", latest.outcome);
    case "succeeded": {
      const environment = (evidence.environments ?? []).find((e) => e.runId === latest.id);
      if (!environment) return row(`${verb}${version}`, "done", latest.outcome);
      const where = ENVIRONMENT_LABEL[environment.kind];
      const verified = environment.health === "healthy";
      return row(
        `${verb} to ${where}${version}`,
        verified ? "done" : "accent",
        verified ? "Health check passed" : "Not verified yet",
      );
    }
    default:
      return row("Didn't finish", "muted", latest.spec.name || null);
  }
}

/** Every outcome stage for an agent, in order. A release row appears only with a linked run. */
export function agentOutcome(
  thread: ThreadSummary,
  worktree?: ThreadWorktreeState,
  evidence: OutcomeEvidence = {},
): OutcomeRow[] {
  const release = releaseRow(thread, evidence);
  const drafts = [
    agentRow(thread),
    changesRow(thread, worktree),
    testsRow(thread, evidence),
    mergeRow(thread, worktree),
  ];
  return (release ? [...drafts, release] : drafts).map((row) => ({
    ...row,
    short: shortOf(row.stage, row.value, thread),
  }));
}

/** The one-line form of a stage: agent and tests carry their stage name, the others read alone. */
function shortOf(stage: OutcomeStage, value: string, thread: ThreadSummary): string {
  if (stage === "agent") return `Agent ${AGENT_STATE_TEXT[agentStateOf(thread)].toLowerCase()}`;
  if (stage === "tests") return `Tests ${value.charAt(0).toLowerCase()}${value.slice(1)}`;
  return value;
}

/**
 * Whether the outcome says more than the agent's state (worth a strip of its own). "No files"
 * only counts once the agent has finished: before that it is just a fresh agent.
 */
export function hasOutcome(rows: readonly OutcomeRow[]): boolean {
  const finished = rows.some((row) => row.stage === "agent" && FINISHED.has(row.value));
  return rows.some(
    (row) => row.stage !== "agent" && row.known && (finished || row.stage !== "changes" || row.value !== "No files"),
  );
}

const FINISHED: ReadonlySet<string> = new Set([
  AGENT_STATE_LABEL.done,
  AGENT_STATE_LABEL.failed,
  AGENT_STATE_LABEL.stopped,
]);
