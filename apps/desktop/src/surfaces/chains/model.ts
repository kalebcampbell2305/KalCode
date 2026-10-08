import type {
  Chain,
  ChainPhase,
  ChainStartRequest,
  ChainStep,
  ChainStepDefinition,
  ChainStepIntent,
  ChainStepPhase,
  ChainStepRoute,
  ChainWorktree,
  OperationRecord,
} from "@kalcode/protocol";

/**
 * Pure view model for Agent Handoff Chains. Every phase, reason and next action comes from the
 * native snapshot (derived there on read); this module only names, colours and lays them out.
 */

/** The visual tone of a step: one meaning per colour (AGENTS.md space design system). */
export type StepTone = "active" | "waiting" | "attention" | "failed" | "blocked" | "passed" | "muted";

export interface StepPhaseMeta {
  label: string;
  tone: StepTone;
}

export const STEP_PHASE_META: Record<ChainStepPhase, StepPhaseMeta> = {
  waiting: { label: "Waiting", tone: "waiting" },
  starting: { label: "Starting", tone: "active" },
  working: { label: "Working", tone: "active" },
  needs_report: { label: "Needs report", tone: "attention" },
  passed: { label: "Passed", tone: "passed" },
  changes_requested: { label: "Changes requested", tone: "passed" },
  failed: { label: "Failed", tone: "failed" },
  blocked: { label: "Blocked", tone: "blocked" },
  paused: { label: "Paused", tone: "waiting" },
  skipped: { label: "Skipped", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "muted" },
  superseded: { label: "Superseded", tone: "muted" },
};

export type ChainTone = "accent" | "waiting" | "danger" | "success" | "outline" | "paused";

export const CHAIN_PHASE_META: Record<ChainPhase, { label: string; tone: ChainTone }> = {
  running: { label: "Running", tone: "accent" },
  needs_you: { label: "Needs you", tone: "waiting" },
  paused: { label: "Paused", tone: "paused" },
  blocked: { label: "Blocked", tone: "danger" },
  ready_to_merge: { label: "Ready to merge", tone: "success" },
  cancelled: { label: "Cancelled", tone: "outline" },
  superseded: { label: "Superseded", tone: "outline" },
};

export const INTENT_LABEL: Record<ChainStepIntent, string> = {
  implement: "Implement",
  review: "Review",
  fix: "Fix",
  test: "Test",
  continue: "Continue",
};

export const INTENTS: readonly ChainStepIntent[] = ["implement", "review", "fix", "test", "continue"];

/** Implement, Fix and Continue edit the tree; at most one may run at a time in a shared worktree. */
export const WRITER_INTENTS: ReadonlySet<ChainStepIntent> = new Set(["implement", "fix", "continue"]);

export const SATISFIED: ReadonlySet<ChainStepPhase> = new Set(["passed", "changes_requested", "skipped"]);
const SETTLED_CHAIN: ReadonlySet<ChainPhase> = new Set(["cancelled", "superseded"]);

/** Cancelled and superseded chains go to the short history; everything else stays in view. */
export function inChainHistory(chain: Pick<Chain, "phase">): boolean {
  return SETTLED_CHAIN.has(chain.phase);
}

/* ---------------- Layout: columns by dependency depth ---------------- */

export interface RailCell {
  step: ChainStep;
  /** 0-based column: one more than the deepest dependency. */
  column: number;
  /** 0-based row inside the column (parallel steps stack). */
  row: number;
}

/** Steps placed in columns by dependency depth; parallel steps share a column. */
export function railLayout(steps: readonly ChainStep[]): { cells: RailCell[]; columns: number; rows: number } {
  const depth = new Map<string, number>();
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  for (const step of ordered) {
    const deps = step.dependsOn.map((key) => depth.get(key) ?? 0);
    depth.set(step.key, deps.length === 0 ? 0 : Math.max(...deps) + 1);
  }
  const rowsUsed = new Map<number, number>();
  const cells = ordered.map((step) => {
    const column = depth.get(step.key) ?? 0;
    const row = rowsUsed.get(column) ?? 0;
    rowsUsed.set(column, row + 1);
    return { step, column, row };
  });
  return {
    cells,
    columns: cells.reduce((max, cell) => Math.max(max, cell.column + 1), 0),
    rows: Math.max(1, ...rowsUsed.values()),
  };
}

/** Whether every dependency of a step is satisfied (its incoming connector lights up). */
export function dependenciesSatisfied(step: ChainStep, steps: readonly ChainStep[]): boolean {
  if (step.dependsOn.length === 0) return true;
  return step.dependsOn.every((key) => {
    const dep = steps.find((candidate) => candidate.key === key);
    return dep ? SATISFIED.has(dep.phase) : false;
  });
}

/* ---------------- Route identity (from the step's Operation) ---------------- */

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
};

export function providerName(providerId: string | null | undefined): string {
  if (!providerId) return "Agent";
  return PROVIDER_NAMES[providerId] ?? providerId;
}

export interface StepRoute {
  providerId: string | null;
  providerName: string;
  /** The exact model id, or null when the operation runs the provider default. */
  model: string | null;
  effort: string | null;
  accountLabel: string | null;
}

export function stepRoute(operation: OperationRecord | undefined): StepRoute {
  const spec = operation?.spec;
  return {
    providerId: spec?.providerId ?? null,
    providerName: providerName(spec?.providerId),
    // Native stores no model (or an empty one) for the provider default.
    model: spec?.model || null,
    effort: spec?.effort || null,
    accountLabel: operation?.accountLabel ?? null,
  };
}

/** "Codex gpt-5" for labels; "Codex" when no exact model is known. */
export function routeLabel(route: StepRoute): string {
  return route.model ? `${route.providerName} ${route.model}` : route.providerName;
}

/** The detail line under a node: the waiting reason, or the recorded outcome summary. */
export function stepDetail(step: ChainStep): string | null {
  if (step.report?.summary) return step.report.summary;
  return step.waitingReason ?? null;
}

/** "Step 2 of 4, Review, Codex gpt-5, working" (screen readers; never colour alone). */
export function stepAriaLabel(step: ChainStep, total: number, route: StepRoute): string {
  const parts = [
    `Step ${step.position + 1} of ${total}`,
    step.name === INTENT_LABEL[step.intent] ? step.name : `${INTENT_LABEL[step.intent]}: ${step.name}`,
    routeLabel(route),
    STEP_PHASE_META[step.phase].label.toLowerCase(),
  ];
  const detail = stepDetail(step);
  if (detail) parts.push(detail);
  return parts.join(", ");
}

/* ---------------- Actions offered per phase (only when safe) ---------------- */

export type StepAction = "open" | "record" | "retry" | "skip" | "reroute";

const OPEN: ReadonlySet<ChainStepPhase> = new Set([
  "starting",
  "working",
  "needs_report",
  "passed",
  "changes_requested",
  "failed",
]);
const RECORD: ReadonlySet<ChainStepPhase> = new Set(["needs_report", "working"]);
// Native retries only a step whose own attempt failed, was cancelled or was interrupted (shown as
// failed). A step blocked by an earlier failure is resolved by retrying that earlier step.
const RETRY: ReadonlySet<ChainStepPhase> = new Set(["failed", "cancelled", "needs_report", "changes_requested"]);
const SKIP: ReadonlySet<ChainStepPhase> = new Set([
  "waiting",
  "blocked",
  "paused",
  "failed",
  "cancelled",
  "needs_report",
]);
const REROUTE: ReadonlySet<ChainStepPhase> = new Set(["waiting", "paused"]);

/** A step held for its own reason (for example a signed-out account), not by an earlier step. */
function heldForItself(step: Pick<ChainStep, "phase" | "waitingReason">): boolean {
  return step.phase === "blocked" && !(step.waitingReason ?? "").startsWith("Blocked until");
}

/**
 * The step actions that are safe for a phase, in the order they appear. Nothing that changes the
 * chain is offered once the chain was cancelled or superseded; opening the agent always is.
 */
export function stepActions(
  step: Pick<ChainStep, "phase" | "waitingReason">,
  chain?: Pick<Chain, "phase">,
): StepAction[] {
  const actions: StepAction[] = [];
  const closed = chain ? inChainHistory(chain) : false;
  if (OPEN.has(step.phase)) actions.push("open");
  if (closed) return actions;
  if (RECORD.has(step.phase)) actions.push("record");
  if (RETRY.has(step.phase)) actions.push("retry");
  if (REROUTE.has(step.phase) || heldForItself(step)) actions.push("reroute");
  if (SKIP.has(step.phase)) actions.push("skip");
  return actions;
}

/** Chain-level controls that are safe right now. */
export function chainActions(chain: Pick<Chain, "phase" | "paused">): {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
} {
  const live = chain.phase !== "cancelled" && chain.phase !== "superseded" && chain.phase !== "ready_to_merge";
  return { pause: live && !chain.paused, resume: live && chain.paused, cancel: live };
}

/** The step that most needs the person, else the one running, else the first unsatisfied one. */
export function focusStep(chain: Pick<Chain, "steps">): ChainStep | null {
  const order: ChainStepPhase[][] = [
    ["needs_report"],
    ["failed"],
    ["blocked"],
    ["working", "starting"],
    ["paused", "waiting"],
  ];
  for (const phases of order) {
    const step = chain.steps.find((candidate) => phases.includes(candidate.phase));
    if (step) return step;
  }
  return null;
}

/** Satisfied steps out of all steps. */
export function chainProgress(chain: Pick<Chain, "steps">): { done: number; total: number } {
  return { done: chain.steps.filter((step) => SATISFIED.has(step.phase)).length, total: chain.steps.length };
}

/* ---------------- Composer: drafts, presets, validation ---------------- */

export interface DraftRoute {
  providerId: string;
  /** Empty until an account is known or chosen. */
  providerAccountId: string;
  /** Exact model id; empty means the account's reported default (resolved before start). */
  model: string;
  /** Provider-native effort; empty means the model's default (resolved before start). */
  effort: string;
}

export interface DraftStep {
  /** Stable React key for the row (not the chain step key). */
  id: string;
  intent: ChainStepIntent;
  instructions: string;
  /** Runs alongside the previous step (a parallel branch sharing its dependencies). */
  parallel: boolean;
  /** Null: the default route (the source agent's or the remembered launch), resolved late. */
  route: DraftRoute | null;
}

export interface ChainPreset {
  id: string;
  label: string;
  intents: readonly ChainStepIntent[];
}

export const PRESETS: readonly ChainPreset[] = [
  { id: "full", label: "Implement → Review → Fix → Test", intents: ["implement", "review", "fix", "test"] },
  { id: "review-fix", label: "Review → Fix", intents: ["review", "fix"] },
];

let draftCounter = 0;
export function draftStepId(): string {
  draftCounter += 1;
  return `draft-${draftCounter}`;
}

export function presetSteps(preset: ChainPreset, route: DraftRoute | null = null): DraftStep[] {
  return preset.intents.map((intent) => ({
    id: draftStepId(),
    intent,
    instructions: "",
    parallel: false,
    route: route ? { ...route } : null,
  }));
}

/** Step names: the intent, numbered when an intent repeats ("Review", "Review 2"). */
export function draftNames(steps: readonly Pick<DraftStep, "intent">[]): string[] {
  const seen = new Map<ChainStepIntent, number>();
  return steps.map((step) => {
    const count = (seen.get(step.intent) ?? 0) + 1;
    seen.set(step.intent, count);
    return count === 1 ? INTENT_LABEL[step.intent] : `${INTENT_LABEL[step.intent]} ${count}`;
  });
}

/** Step keys: the intent, suffixed when it repeats ("review", "review-2"). */
export function draftKeys(steps: readonly Pick<DraftStep, "intent">[]): string[] {
  const seen = new Map<ChainStepIntent, number>();
  return steps.map((step) => {
    const count = (seen.get(step.intent) ?? 0) + 1;
    seen.set(step.intent, count);
    return count === 1 ? step.intent : `${step.intent}-${count}`;
  });
}

/** Groups rows into dependency levels: a parallel row joins the previous row's level. */
export function draftLevels(steps: readonly Pick<DraftStep, "parallel">[]): number[] {
  let level = -1;
  return steps.map((step, index) => {
    if (index === 0 || !step.parallel) level += 1;
    return level;
  });
}

/** Every row depends on all rows of the previous level. */
export function draftDependencies(steps: readonly Pick<DraftStep, "intent" | "parallel">[]): string[][] {
  const keys = draftKeys(steps);
  const levels = draftLevels(steps);
  return steps.map((_, index) => {
    const level = levels[index] ?? 0;
    if (level === 0) return [];
    return keys.filter((_, other) => levels[other] === level - 1);
  });
}

const TRAILING = new Set(["and", "or", "the", "a", "an", "to", "with", "for", "of", "in", "on", "so", "then"]);

/** A short chain name from the goal: its first clause, at most six words. */
export function suggestName(goal: string): string {
  const clause =
    goal
      .replace(/\([^)]*\)/g, " ")
      .trim()
      .split(/[.\n!?;:]/)[0]
      ?.trim() ?? "";
  const words = clause.split(/\s+/).filter(Boolean).slice(0, 6);
  // Never end on a joining word ("Review the work and").
  while (words.length > 1 && TRAILING.has((words[words.length - 1] as string).toLowerCase())) words.pop();
  const name = words.join(" ").replace(/[,–—-]+$/, "");
  if (!name) return "";
  return name.length > 60 ? `${name.slice(0, 59).trimEnd()}…` : name[0]?.toUpperCase() + name.slice(1);
}

export interface DraftIssue {
  /** "goal", "name", "steps", or a step row id. */
  field: string;
  message: string;
}

export const MAX_STEPS = 12;
export const MAX_ACCEPTANCE = 20;

/**
 * Mirrors native `chains_start` validation so the person sees a clear message before submitting.
 * Native stays the authority (it also checks every route is signed in and supports delivery).
 */
export function validateDraft(input: {
  name: string;
  goal: string;
  worktree: ChainWorktree;
  acceptance?: readonly string[];
  /** The shared tree already exists (the chain continues an agent's own worktree). */
  existingWorktree?: boolean;
  steps: readonly DraftStep[];
}): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (!input.goal.trim()) issues.push({ field: "goal", message: "Describe the goal so every step knows the task." });
  if (!input.name.trim()) issues.push({ field: "name", message: "Name the chain." });
  if (input.steps.length === 0) issues.push({ field: "steps", message: "Add at least one step." });
  if (input.steps.length > MAX_STEPS)
    issues.push({ field: "steps", message: `A chain can have at most ${MAX_STEPS} steps.` });
  if ((input.acceptance ?? []).filter((item) => item.trim()).length > MAX_ACCEPTANCE)
    issues.push({ field: "acceptance", message: `A chain can list at most ${MAX_ACCEPTANCE} acceptance criteria.` });
  const names = draftNames(input.steps);
  for (const [index, step] of input.steps.entries()) {
    if (!step.route?.providerAccountId)
      issues.push({ field: step.id, message: `Choose an account for ${names[index]}.` });
  }
  if (input.worktree === "shared") {
    const levels = draftLevels(input.steps);
    // The chain's first step creates its worktree, so a chain-made tree starts with one step.
    // (A chain continuing an agent joins that agent's existing tree instead.)
    const second = input.steps.findIndex((_, index) => index > 0 && levels[index] === levels[0]);
    if (!input.existingWorktree && second >= 0) {
      const step = input.steps[second] as DraftStep;
      issues.push({
        field: step.id,
        message: `A shared worktree chain starts with one step. Run ${names[second]} after ${names[0]}, or use the project checkout.`,
      });
    }
    for (const [index, step] of input.steps.entries()) {
      if (!WRITER_INTENTS.has(step.intent)) continue;
      const clash = input.steps.findIndex(
        (other, j) => j < index && levels[j] === levels[index] && WRITER_INTENTS.has(other.intent),
      );
      if (clash >= 0)
        issues.push({
          field: step.id,
          message: `${names[clash]} and ${names[index]} would edit the shared worktree at the same time. Run ${names[index]} after ${names[clash]}, or use the project checkout.`,
        });
    }
  }
  return issues;
}

/** The start request for a valid draft. Routes must already be concrete (see `resolveRoute`). */
export function buildStartRequest(input: {
  requestId: string;
  workspaceId: string;
  name: string;
  goal: string;
  acceptance: readonly string[];
  worktree: ChainWorktree;
  /** The agent whose work the chain continues; native runs every step where that work is. */
  sourceThreadId?: string | null;
  steps: readonly { intent: ChainStepIntent; instructions: string; parallel: boolean; route: ChainStepRoute }[];
}): ChainStartRequest {
  const keys = draftKeys(input.steps);
  const names = draftNames(input.steps);
  const deps = draftDependencies(input.steps);
  const steps: ChainStepDefinition[] = input.steps.map((step, index) => ({
    key: keys[index] as string,
    name: names[index] as string,
    intent: step.intent,
    providerId: step.route.providerId,
    providerAccountId: step.route.providerAccountId,
    model: step.route.model,
    effort: step.route.effort,
    instructions: step.instructions.trim() || null,
    dependsOn: deps[index] ?? [],
  }));
  return {
    requestId: input.requestId,
    workspaceId: input.workspaceId,
    name: input.name.trim(),
    goal: input.goal.trim(),
    acceptance: input.acceptance.map((item) => item.trim()).filter(Boolean),
    worktree: input.worktree,
    steps,
    sourceThreadId: input.sourceThreadId ?? null,
  };
}

/** Compares two start payloads ignoring the request id (a retry of the same draft reuses its id). */
export function requestFingerprint(request: Omit<ChainStartRequest, "requestId">): string {
  return JSON.stringify(request);
}
