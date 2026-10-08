/**
 * Handoff Chains adapter for unit tests and the ui-test build. Production uses the native chain
 * store over canonical Operations. This module mirrors its validation and phase derivation and
 * keeps every step as a real in-memory Agent Operation (and, when the transport supplies panes,
 * a real fake coding agent) so Runs, Queue, Code, Fleet and Needs You see the same rows.
 *
 * Phases are derived on every read from step state; nothing stores a phase.
 */
import type {
  Chain,
  ChainPhase,
  ChainReportSource,
  ChainStartRequest,
  ChainStep,
  ChainStepDefinition,
  ChainStepIntent,
  ChainStepPhase,
  ChainStepReport,
  ChainStepResult,
  ChainStepRoute,
  ChainsSnapshot,
  OperationRecord,
  OperationSpec,
  ThreadStatus,
  ThreadSummary,
} from "@kalcode/protocol";
import type { DashboardHandlers } from "./dashboard.ts";
import type { AgentOperationHooks } from "./operations.ts";

interface ChainsMemoryOptions {
  requireCore: () => void;
  operations: AgentOperationHooks;
  /** Creates the step's fake coding agent pane. Omitted in pure unit tests. */
  createPane?: (step: ChainStepDefinition, workspaceId: string, isolate: boolean) => Promise<ThreadSummary>;
  sendTask?: (threadId: string, task: string) => Promise<void>;
  setPaneStatus?: (threadId: string, status: ThreadStatus, activity: string | null) => void;
  /** Milliseconds a working step takes before its fake agent reports `passed`; null disables. */
  autoAdvanceMs?: number | null;
}

/** What a test can make a working step's agent do. */
export type ChainAdvanceOutcome = "passed" | "failed" | "changes_requested" | "no_report";

export interface ChainsControls {
  /** Settles a working step like its agent would; `no_report` ends the turn without a report. */
  advance(chainId: string, stepKey: string, outcome: ChainAdvanceOutcome): Chain;
  /** Newer merged work makes every step that has not started obsolete. */
  supersede(chainId: string): Chain;
  /** Turns the timer-driven progress on or off. Existing timers keep their schedule. */
  setAutoAdvance(enabled: boolean): void;
}

export interface ChainsMemory {
  handlers: DashboardHandlers;
  controls: ChainsControls;
}

interface StepState {
  def: ChainStepDefinition;
  operationId: string;
  attempt: number;
  started: boolean;
  /** The agent's turn ended (with or without a report). */
  finished: boolean;
  report: ChainStepReport | null;
  skipReason: string | null;
  cancelled: boolean;
  superseded: boolean;
}

interface ChainState {
  id: string;
  request: StoredRequest;
  name: string;
  goal: string;
  acceptance: string[];
  workspaceId: string;
  worktree: ChainStartRequest["worktree"];
  branch: string | null;
  createdAt: string;
  paused: boolean;
  cancelled: boolean;
  supersededReason: string | null;
  steps: StepState[];
}

interface StoredRequest {
  requestId: string;
  fingerprint: string;
}

const KEY = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;
const WRITERS: readonly ChainStepIntent[] = ["implement", "fix", "continue"];
const MAX_STEPS = 12;
const INTENT_LABELS: Record<ChainStepIntent, string> = {
  implement: "Implement",
  review: "Review",
  fix: "Fix",
  test: "Test",
  continue: "Continue",
};
const FIX_SKIP_REASON = "Review passed; nothing to fix";

function fail(code: string, message: string): never {
  throw { category: "validation", code, message, retryable: false };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function text(value: unknown, code: string, noun: string, max: number, optional = false): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw && !optional) fail(code, `${noun} is required.`);
  if ([...raw].length > max) fail(code, `${noun} can be at most ${max} characters.`);
  return raw;
}

function join(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function createChainsMemory(options: ChainsMemoryOptions): ChainsMemory {
  const chains: ChainState[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let autoMs = options.autoAdvanceMs ?? null;
  const now = () => new Date().toISOString();

  const find = (id: unknown): ChainState => {
    options.requireCore();
    const chain = chains.find((candidate) => candidate.id === id);
    if (!chain) fail("chain_not_found", "That chain no longer exists.");
    return chain;
  };
  const stepOf = (chain: ChainState, key: unknown): StepState => {
    const step = chain.steps.find((candidate) => candidate.def.key === key);
    if (!step) fail("chain_step_not_found", "That step is not part of this chain.");
    return step;
  };

  /** Phases for every step, in order. Dependencies always come earlier, so one pass suffices. */
  const derive = (chain: ChainState): ChainStepPhase[] => {
    const phases: ChainStepPhase[] = [];
    const byKey = new Map<string, ChainStepPhase>();
    for (const step of chain.steps) {
      const deps = step.def.dependsOn.map((key) => byKey.get(key) ?? "waiting");
      let phase: ChainStepPhase;
      if (step.skipReason !== null) phase = "skipped";
      else if (step.report) phase = step.report.result;
      else if (step.finished) phase = "needs_report";
      else if (step.started) phase = "working";
      else if (step.superseded) phase = "superseded";
      else if (step.cancelled) phase = "cancelled";
      else if (deps.some((dep) => ["failed", "blocked", "cancelled", "superseded"].includes(dep))) phase = "blocked";
      else if (chain.paused) phase = "paused";
      else
        phase = deps.every((dep) => dep === "passed" || dep === "changes_requested" || dep === "skipped")
          ? "starting"
          : "waiting";
      phases.push(phase);
      byKey.set(step.def.key, phase);
    }
    return phases;
  };

  const nameOf = (chain: ChainState, key: string) => chain.steps.find((step) => step.def.key === key)?.def.name ?? key;

  const view = (chain: ChainState): Chain => {
    const phases = derive(chain);
    const stepPhase = new Map(chain.steps.map((step, index) => [step.def.key, phases[index] as ChainStepPhase]));
    const steps: ChainStep[] = chain.steps.map((step, index) => {
      const phase = phases[index] as ChainStepPhase;
      const unmet = step.def.dependsOn.filter((key) => {
        const dep = stepPhase.get(key);
        return dep !== "passed" && dep !== "changes_requested" && dep !== "skipped";
      });
      const stopped = step.def.dependsOn.filter((key) =>
        ["failed", "blocked", "cancelled", "superseded"].includes(stepPhase.get(key) ?? ""),
      );
      let waitingReason: string | null = null;
      if (phase === "waiting") waitingReason = `Waiting for ${join(unmet.map((key) => nameOf(chain, key)))}`;
      else if (phase === "blocked") waitingReason = `Blocked by ${join(stopped.map((key) => nameOf(chain, key)))}`;
      else if (phase === "paused") waitingReason = "The chain is paused";
      else if (phase === "cancelled") waitingReason = "Cancelled before it started";
      else if (phase === "superseded") waitingReason = chain.supersededReason;
      else if (phase === "skipped") waitingReason = step.skipReason;
      return {
        key: step.def.key,
        name: step.def.name,
        intent: step.def.intent,
        instructions: step.def.instructions,
        dependsOn: [...step.def.dependsOn],
        position: index,
        operationId: step.operationId,
        attempt: step.attempt,
        phase,
        waitingReason,
        report: step.report ? clone(step.report) : null,
      };
    });
    const satisfied = (phase: ChainStepPhase) =>
      phase === "passed" || phase === "changes_requested" || phase === "skipped";
    const needsReport = steps.find((step) => step.phase === "needs_report");
    const failed = steps.find((step) => step.phase === "failed");
    let phase: ChainPhase;
    let nextAction: string | null;
    if (chain.cancelled) {
      phase = "cancelled";
      nextAction = null;
    } else if (chain.supersededReason !== null) {
      phase = "superseded";
      nextAction = "Start a new chain if this work still matters";
    } else if (steps.every((step) => satisfied(step.phase))) {
      phase = "ready_to_merge";
      nextAction = chain.branch ? `Review ${chain.branch} and merge it` : "Review the changes and merge them";
    } else if (needsReport) {
      phase = "needs_you";
      nextAction = `Open ${needsReport.name} to record its outcome`;
    } else if (
      steps.some((step) => step.phase === "failed" || step.phase === "blocked" || step.phase === "cancelled")
    ) {
      phase = "blocked";
      nextAction = failed ? `Retry or skip ${failed.name}` : "Retry or skip the stopped step";
    } else if (chain.paused) {
      phase = "paused";
      nextAction = "Resume the chain to continue";
    } else {
      phase = "running";
      const active = steps.find((step) => step.phase === "working" || step.phase === "starting");
      nextAction = active ? `Waiting for ${active.name} to finish` : null;
    }
    return {
      id: chain.id,
      name: chain.name,
      goal: chain.goal,
      acceptance: [...chain.acceptance],
      workspaceId: chain.workspaceId,
      worktree: chain.worktree,
      branch: chain.branch,
      createdAt: chain.createdAt,
      paused: chain.paused,
      cancelled: chain.cancelled,
      supersededReason: chain.supersededReason,
      phase,
      nextAction,
      steps,
    };
  };

  const specFor = (chain: ChainState, step: StepState, operationIds: ReadonlyMap<string, string>): OperationSpec => ({
    name: step.def.name,
    workspaceId: chain.workspaceId,
    kind: "agent",
    command: null,
    prompt: null,
    providerId: step.def.providerId,
    providerAccountId: step.def.providerAccountId,
    model: step.def.model,
    effort: step.def.effort,
    dependencies: step.def.dependsOn.map((key) => operationIds.get(key) ?? ""),
    priority: 5,
    lane: "next",
    environment: "local",
    urls: [],
    envKeys: [],
  });

  const operationMap = (chain: ChainState) =>
    new Map(chain.steps.map((step) => [step.def.key, step.operationId] as const));

  /** The fake handoff package: small, structured, never raw terminal history. */
  const brief = (chain: ChainState, step: StepState, phases: readonly ChainStepPhase[]): string => {
    const index = chain.steps.indexOf(step);
    const earlier = chain.steps
      .map((candidate, i) => ({ candidate, phase: phases[i] as ChainStepPhase }))
      .filter(({ candidate }) => step.def.dependsOn.includes(candidate.def.key))
      .map(({ candidate, phase }) => `- ${candidate.def.name} (${candidate.def.intent}): ${phase}`);
    return [
      `Chain: ${chain.name}, step ${index + 1} of ${chain.steps.length} (${INTENT_LABELS[step.def.intent]})`,
      `Goal: ${chain.goal}`,
      chain.acceptance.length > 0 ? `Acceptance: ${chain.acceptance.join("; ")}` : "",
      chain.branch ? `Branch: ${chain.branch}` : "",
      earlier.length > 0 ? `Earlier steps:\n${earlier.join("\n")}` : "",
      step.def.instructions ?? "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  const paneStatus = (step: StepState, status: ThreadStatus, activity: string | null) => {
    const threadId = options.operations.exact([step.operationId])[0]?.threadId;
    if (threadId) options.setPaneStatus?.(threadId, status, activity);
  };

  const settleStep = (step: StepState, outcome: ChainAdvanceOutcome) => {
    if (outcome === "no_report") {
      step.finished = true;
      options.operations.finish(step.operationId, "succeeded", "The agent finished without a step report.");
      paneStatus(step, "waiting_for_user", "Finished without a step report");
      return;
    }
    const failed = outcome === "failed";
    step.report = {
      result: outcome,
      summary: failed ? `${step.def.name} could not finish.` : `${step.def.name} finished as asked.`,
      tests: step.def.intent === "test" ? [{ command: "pnpm test", passed: !failed }] : [],
      blockers: failed ? ["The step reported a failure."] : [],
      source: "agent",
      recordedAt: now(),
    };
    step.finished = true;
    options.operations.finish(step.operationId, failed ? "failed" : "succeeded", step.report.summary);
    paneStatus(step, failed ? "failed" : "completed", failed ? "Step failed" : "Step finished");
  };

  const schedule = (chain: ChainState, step: StepState) => {
    if (autoMs === null) return;
    const operationId = step.operationId;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (autoMs === null || step.operationId !== operationId || !step.started || step.finished) return;
      settleStep(step, "passed");
      tick(chain);
    }, autoMs);
    timers.add(timer);
  };

  /** Starts every step that is ready; repeats because a skipped Fix frees its dependents. */
  const tick = (chain: ChainState) => {
    for (let guard = 0; guard < chain.steps.length + 1; guard += 1) {
      const phases = derive(chain);
      let changed = false;
      for (const [index, step] of chain.steps.entries()) {
        if (phases[index] !== "starting") continue;
        changed = true;
        const reviews = step.def.dependsOn
          .map((key) => chain.steps.findIndex((candidate) => candidate.def.key === key))
          .filter((i) => chain.steps[i]?.def.intent === "review");
        if (step.def.intent === "fix" && reviews.length > 0 && reviews.every((i) => phases[i] === "passed")) {
          step.skipReason = FIX_SKIP_REASON;
          options.operations.finish(step.operationId, "succeeded", FIX_SKIP_REASON);
          paneStatus(step, "idle", FIX_SKIP_REASON);
          continue;
        }
        step.started = true;
        if (chain.worktree === "shared" && chain.branch === null) {
          const bound = options.operations.exact([step.operationId])[0]?.branch;
          chain.branch = bound ?? `chain/${chain.id.slice(0, 8)}`;
        }
        options.operations.activate(step.operationId, true);
        const threadId = options.operations.exact([step.operationId])[0]?.threadId;
        if (threadId) {
          options.setPaneStatus?.(threadId, "active", `Working on ${step.def.name}`);
          void options.sendTask?.(threadId, brief(chain, step, phases))?.catch(() => undefined);
        }
        schedule(chain, step);
      }
      if (!changed) break;
    }
    // Keep Operations rows truthful for steps that have not started.
    const phases = derive(chain);
    const ops = operationMap(chain);
    for (const [index, step] of chain.steps.entries()) {
      const phase = phases[index];
      if (phase !== "waiting" && phase !== "blocked") continue;
      const blockers = step.def.dependsOn.map((key) => ops.get(key) ?? "");
      const record = options.operations.exact([step.operationId])[0];
      if (!record) continue;
      const wanted = phase === "blocked" ? "blocked" : "queued";
      if (record.status === wanted && record.blockers.length === blockers.length) continue;
      if (phase === "blocked") options.operations.block(step.operationId, blockers, "Blocked by an earlier step");
      else options.operations.wait(step.operationId, blockers);
      paneStatus(step, "waiting_for_dependency", phase === "blocked" ? "Blocked by an earlier step" : "Waiting");
    }
  };

  const route = (value: unknown): ChainStepRoute => {
    const raw = (value ?? {}) as Partial<ChainStepRoute>;
    return {
      providerId: text(raw.providerId, "chain_route_invalid", "The provider", 63),
      providerAccountId: text(raw.providerAccountId, "chain_route_invalid", "The provider account", 128),
      model: text(raw.model, "chain_route_invalid", "The model", 128),
      // Empty means the provider's default effort, exactly as native normalizes it.
      effort: text(raw.effort, "chain_route_invalid", "The effort", 32, true),
    };
  };

  const bindPane = async (chain: ChainState, step: StepState) => {
    if (!options.createPane) return;
    try {
      const thread = await options.createPane(step.def, chain.workspaceId, chain.worktree === "shared");
      options.operations.prepare(step.operationId, {
        threadId: thread.id,
        terminalId: thread.terminalId ?? thread.id,
        branch: thread.branch,
        accountLabel: thread.accountLabel,
      });
      options.setPaneStatus?.(thread.id, "waiting_for_dependency", "Waiting");
    } catch {
      // The step stays without an agent; Retry creates a fresh attempt.
    }
  };

  const validate = (args: Record<string, unknown>) => {
    const raw = (args.request ?? {}) as Partial<ChainStartRequest>;
    const requestId = text(raw.requestId, "chain_request_invalid", "The request id", 128);
    const workspaceId = text(raw.workspaceId, "chain_request_invalid", "The workspace", 128);
    const name = text(raw.name, "chain_name_invalid", "The chain name", 120);
    const goal = text(raw.goal, "chain_goal_invalid", "The goal", 16_384);
    const acceptance = (Array.isArray(raw.acceptance) ? raw.acceptance : [])
      .map((item) => text(item, "chain_acceptance_invalid", "Acceptance criteria", 500, true))
      .filter(Boolean);
    if (raw.worktree !== "shared" && raw.worktree !== "project")
      fail("chain_worktree_invalid", "Choose a shared worktree or the project checkout.");
    const worktree = raw.worktree;
    const input = Array.isArray(raw.steps) ? raw.steps : [];
    if (input.length === 0) fail("chain_steps_required", "Add at least one step.");
    if (input.length > MAX_STEPS) fail("chain_steps_too_many", `A chain can have at most ${MAX_STEPS} steps.`);
    const steps: ChainStepDefinition[] = input.map((entry) => {
      const step = entry as Partial<ChainStepDefinition>;
      const key = typeof step.key === "string" ? step.key : "";
      if (!KEY.test(key)) fail("chain_step_key_invalid", "Each step needs a short key of letters, numbers, - or _.");
      if (!(step.intent && step.intent in INTENT_LABELS))
        fail("chain_step_intent_invalid", "Choose what each step should do.");
      const instructions = text(step.instructions, "chain_instructions_invalid", "Instructions", 8_000, true);
      return {
        key,
        name: text(step.name, "chain_step_name_invalid", "Each step name", 120),
        intent: step.intent,
        ...route(step),
        instructions: instructions || null,
        dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [],
      };
    });
    const index = new Map<string, number>();
    for (const [i, step] of steps.entries()) {
      if (index.has(step.key)) fail("chain_step_key_duplicate", `Step key "${step.key}" is used twice.`);
      index.set(step.key, i);
    }
    for (const step of steps) {
      for (const dep of step.dependsOn) {
        if (!index.has(dep)) fail("chain_dependency_unknown", `${step.name} depends on a step that does not exist.`);
        if (dep === step.key) fail("chain_cycle", `${step.name} cannot depend on itself.`);
      }
    }
    // Cycle check by depth-first search, then the order rule.
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (key: string) => {
      if (done.has(key)) return;
      if (visiting.has(key)) fail("chain_cycle", "Steps cannot depend on each other in a loop.");
      visiting.add(key);
      for (const dep of steps[index.get(key) as number]?.dependsOn ?? []) visit(dep);
      visiting.delete(key);
      done.add(key);
    };
    for (const step of steps) visit(step.key);
    for (const [i, step] of steps.entries()) {
      for (const dep of step.dependsOn) {
        if ((index.get(dep) as number) >= i)
          fail("chain_dependency_order", `${step.name} must depend only on steps listed before it.`);
      }
    }
    if (worktree === "shared") {
      const ancestors = steps.map(() => new Set<string>());
      for (const [i, step] of steps.entries()) {
        for (const dep of step.dependsOn) {
          ancestors[i]?.add(dep);
          for (const inherited of ancestors[index.get(dep) as number] ?? []) ancestors[i]?.add(inherited);
        }
      }
      for (const [i, step] of steps.entries()) {
        if (!WRITERS.includes(step.intent)) continue;
        for (let j = 0; j < i; j += 1) {
          const other = steps[j] as ChainStepDefinition;
          if (WRITERS.includes(other.intent) && !ancestors[i]?.has(other.key))
            fail(
              "chain_parallel_writers",
              `${other.name} and ${step.name} could edit the shared worktree at the same time. Make ${step.name} wait for ${other.name}.`,
            );
        }
      }
    }
    const sourceThreadId = typeof raw.sourceThreadId === "string" && raw.sourceThreadId ? raw.sourceThreadId : null;
    const request: ChainStartRequest = {
      requestId,
      workspaceId,
      name,
      goal,
      acceptance,
      worktree,
      steps,
      sourceThreadId,
    };
    return { request, fingerprint: JSON.stringify({ ...request, requestId: undefined }) };
  };

  const register = (chain: ChainState) => {
    chains.unshift(chain);
  };

  const mutate = (chain: ChainState): Chain => {
    tick(chain);
    return view(chain);
  };

  const handlers: DashboardHandlers = {
    chains_snapshot: (args) => {
      options.requireCore();
      for (const chain of chains) tick(chain);
      const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId : null;
      const included = chains.filter((chain) => workspaceId === null || chain.workspaceId === workspaceId);
      const operations: OperationRecord[] = [];
      for (const chain of included) {
        const ops = operationMap(chain);
        for (const step of chain.steps) {
          const record = options.operations.exact([step.operationId])[0];
          if (!record) continue;
          // Rerouted routes and retried dependencies live on the step, not the Operations hooks.
          record.spec = { ...record.spec, ...specFor(chain, step, ops), prompt: record.spec.prompt };
          operations.push(record);
        }
      }
      const snapshot: ChainsSnapshot = { chains: included.map(view), operations };
      return clone(snapshot);
    },
    chains_start: async (args) => {
      options.requireCore();
      const { request, fingerprint } = validate(args);
      const existing = chains.find((chain) => chain.request.requestId === request.requestId);
      if (existing) {
        if (existing.request.fingerprint !== fingerprint)
          fail("chain_request_conflict", "That request id was already used for a different chain.");
        return view(existing);
      }
      const chain: ChainState = {
        id: crypto.randomUUID(),
        request: { requestId: request.requestId, fingerprint },
        name: request.name,
        goal: request.goal,
        acceptance: request.acceptance,
        workspaceId: request.workspaceId,
        worktree: request.worktree,
        branch: null,
        createdAt: now(),
        paused: false,
        cancelled: false,
        supersededReason: null,
        steps: request.steps.map((def) => ({
          def,
          operationId: crypto.randomUUID(),
          attempt: 1,
          started: false,
          finished: false,
          report: null,
          skipReason: null,
          cancelled: false,
          superseded: false,
        })),
      };
      // Register first so a retried start with the same request id replays this chain.
      register(chain);
      const ops = operationMap(chain);
      for (const step of chain.steps) options.operations.create(step.operationId, specFor(chain, step, ops));
      await Promise.all(chain.steps.map((step) => bindPane(chain, step)));
      return mutate(chain);
    },
    chains_pause: (args) => {
      const chain = find(args.id);
      if (chain.cancelled) fail("chain_cancelled", "This chain was cancelled.");
      chain.paused = true;
      return mutate(chain);
    },
    chains_resume: (args) => {
      const chain = find(args.id);
      if (chain.cancelled) fail("chain_cancelled", "This chain was cancelled.");
      chain.paused = false;
      return mutate(chain);
    },
    chains_cancel: (args) => {
      const chain = find(args.id);
      const phases = derive(chain);
      for (const [index, step] of chain.steps.entries()) {
        const phase = phases[index];
        if (phase === "waiting" || phase === "starting" || phase === "paused" || phase === "blocked")
          step.cancelled = true;
      }
      chain.cancelled = true;
      return mutate(chain);
    },
    chains_retry_step: async (args) => {
      const chain = find(args.id);
      const step = stepOf(chain, args.stepKey);
      const phase = derive(chain)[chain.steps.indexOf(step)];
      if (phase !== "failed" && phase !== "blocked" && phase !== "cancelled")
        fail("chain_step_not_retryable", "Only a failed, blocked or cancelled step can run again.");
      const next = args.route == null ? null : route(args.route);
      if (next) step.def = { ...step.def, ...next };
      step.operationId = crypto.randomUUID();
      step.attempt += 1;
      step.started = false;
      step.finished = false;
      step.report = null;
      step.skipReason = null;
      step.cancelled = false;
      step.superseded = false;
      chain.cancelled = false;
      options.operations.create(step.operationId, specFor(chain, step, operationMap(chain)));
      await bindPane(chain, step);
      return mutate(chain);
    },
    chains_skip_step: (args) => {
      const chain = find(args.id);
      const step = stepOf(chain, args.stepKey);
      const phase = derive(chain)[chain.steps.indexOf(step)];
      if (phase === "passed" || phase === "changes_requested" || phase === "skipped" || phase === "superseded")
        fail("chain_step_not_skippable", "This step already finished or was replaced.");
      step.skipReason = "Skipped by you";
      step.cancelled = false;
      return mutate(chain);
    },
    chains_reroute_step: (args) => {
      const chain = find(args.id);
      const step = stepOf(chain, args.stepKey);
      if (step.started || step.report || step.skipReason !== null)
        fail("chain_step_started", "This step already started. Retry it on another provider instead.");
      step.def = { ...step.def, ...route(args.route) };
      return mutate(chain);
    },
    chains_record_step: (args) => {
      const chain = find(args.id);
      const step = stepOf(chain, args.stepKey);
      const phase = derive(chain)[chain.steps.indexOf(step)];
      if (phase !== "needs_report")
        fail("chain_step_not_waiting_for_report", "Only a step that finished without a report can be recorded.");
      const result = args.result as ChainStepResult;
      if (result !== "passed" && result !== "failed" && result !== "changes_requested")
        fail("chain_result_invalid", "Choose passed, failed or changes requested.");
      const summary = text(args.summary, "chain_summary_invalid", "The summary", 8_000);
      const source: ChainReportSource = "you";
      step.report = {
        result,
        summary,
        tests: [],
        blockers: result === "failed" ? [summary] : [],
        source,
        recordedAt: now(),
      };
      return mutate(chain);
    },
  };

  const controls: ChainsControls = {
    advance(chainId, stepKey, outcome) {
      const chain = find(chainId);
      const step = stepOf(chain, stepKey);
      const phase = derive(chain)[chain.steps.indexOf(step)];
      if (phase !== "working") fail("chain_step_not_working", "That step is not running.");
      settleStep(step, outcome);
      return mutate(chain);
    },
    supersede(chainId) {
      const chain = find(chainId);
      chain.supersededReason = "Newer work already merged this branch into its base.";
      const phases = derive(chain);
      for (const [index, step] of chain.steps.entries()) {
        const phase = phases[index];
        if (phase === "waiting" || phase === "starting" || phase === "paused" || phase === "blocked")
          step.superseded = true;
      }
      return mutate(chain);
    },
    setAutoAdvance(enabled) {
      autoMs = enabled ? (options.autoAdvanceMs ?? 1500) : null;
      if (!enabled) {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      }
    },
  };

  return { handlers, controls };
}
