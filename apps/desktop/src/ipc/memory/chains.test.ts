import type { Chain, ChainStartRequest, ChainStepDefinition, ChainsSnapshot } from "@kalcode/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChainsMemory } from "./chains.ts";
import { createOperationsMemory } from "./operations.ts";

const WORKSPACE = "00000000-0000-4000-8000-000000000010";

function def(key: string, intent: ChainStepDefinition["intent"], dependsOn: string[] = []): ChainStepDefinition {
  return {
    key,
    name: key.charAt(0).toUpperCase() + key.slice(1),
    intent,
    providerId: "codex",
    providerAccountId: "0192f3c4-0000-7000-8000-000000000201",
    model: "gpt-5.6-sol",
    effort: "high",
    instructions: null,
    dependsOn,
  };
}

const PRESET = [
  def("implement", "implement"),
  def("review", "review", ["implement"]),
  def("fix", "fix", ["review"]),
  def("test", "test", ["fix"]),
];

function request(steps: ChainStepDefinition[] = PRESET, patch: Partial<ChainStartRequest> = {}): ChainStartRequest {
  return {
    requestId: "req-1",
    workspaceId: WORKSPACE,
    name: "Billing fix",
    goal: "Fix the billing rounding bug",
    acceptance: ["Tests pass"],
    worktree: "shared",
    steps,
    sourceThreadId: null,
    ...patch,
  };
}

function setup(autoAdvanceMs: number | null = null) {
  const operations = createOperationsMemory({
    empty: true,
    workspaces: [
      {
        id: WORKSPACE,
        name: "kalcode-site",
        rootPath: "C:\\Projects\\kalcode-site",
        displayPath: "~\\Projects\\kalcode-site",
        createdAt: "2026-09-30T12:00:00Z",
        lastOpenedAt: "2026-09-30T12:00:00Z",
        activeTerminalId: null,
        available: true,
      },
    ],
    requireCore() {},
  });
  const tasks: string[] = [];
  let panes = 0;
  const memory = createChainsMemory({
    requireCore() {},
    operations: operations.agents,
    autoAdvanceMs,
    async createPane(step, workspaceId) {
      panes += 1;
      const id = `00000000-0000-4000-8000-${String(panes).padStart(12, "0")}`;
      return {
        id,
        providerId: step.providerId,
        workspaceId,
        branch: "kal/chain",
        terminalId: id,
        accountLabel: "Personal",
      } as never;
    },
    async sendTask(threadId, task) {
      tasks.push(`${threadId}:${task}`);
    },
  });
  const call = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const handler = memory.handlers[command as keyof typeof memory.handlers];
    if (!handler) throw new Error(`Missing ${command}`);
    return (await handler(args)) as T;
  };
  const start = (steps?: ChainStepDefinition[], patch?: Partial<ChainStartRequest>) =>
    call<Chain>("chains_start", { request: request(steps, patch) });
  const snapshot = () => call<ChainsSnapshot>("chains_snapshot", { workspaceId: null });
  const phases = (chain: Chain) => chain.steps.map((step) => step.phase);
  return { memory, operations, tasks, call, start, snapshot, phases };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("chains_start validation", () => {
  const reject = async (steps: ChainStepDefinition[], code: string, patch?: Partial<ChainStartRequest>) => {
    const f = setup();
    await expect(f.start(steps, patch)).rejects.toMatchObject({ code });
  };

  it("needs at least one step", () => reject([], "chain_steps_required"));
  it("needs unique keys", () => reject([def("a", "implement"), def("a", "review", ["a"])], "chain_step_key_duplicate"));
  it("rejects unknown dependencies", () => reject([def("a", "implement", ["ghost"])], "chain_dependency_unknown"));
  it("rejects cycles", () =>
    reject([def("a", "implement", ["b"]), def("b", "review", ["a"])], "chain_cycle", { worktree: "project" }));
  it("rejects a dependency on a later step", () =>
    reject([def("a", "review", ["b"]), def("b", "implement")], "chain_dependency_order", { worktree: "project" }));
  it("requires a name and goal", async () => {
    await reject(PRESET, "chain_name_invalid", { name: "  " });
    await reject(PRESET, "chain_goal_invalid", { goal: "" });
  });

  it("rejects two writers that can run in parallel in a shared worktree", async () => {
    const steps = [def("a", "implement"), def("b", "fix")];
    await reject(steps, "chain_parallel_writers");
  });

  it("allows parallel writers when each has its own checkout, and parallel readers in a shared tree", async () => {
    const project = setup();
    await expect(
      project.start([def("a", "implement"), def("b", "fix")], { worktree: "project" }),
    ).resolves.toBeTruthy();
    const shared = setup();
    await expect(
      shared.start([def("a", "implement"), def("r1", "review", ["a"]), def("r2", "review", ["a"])]),
    ).resolves.toBeTruthy();
  });

  it("allows writers ordered through a transitive dependency", async () => {
    const f = setup();
    await expect(
      f.start([def("a", "implement"), def("r", "review", ["a"]), def("b", "fix", ["r"])]),
    ).resolves.toBeTruthy();
  });
});

describe("chains_start", () => {
  it("is idempotent by requestId and rejects a different chain under the same id", async () => {
    const f = setup();
    const first = await f.start();
    const again = await f.start();
    expect(again.id).toBe(first.id);
    expect((await f.snapshot()).chains).toHaveLength(1);
    await expect(f.start(PRESET, { goal: "Something else" })).rejects.toMatchObject({
      code: "chain_request_conflict",
    });
  });

  it("creates one Operation and one agent per step and starts only the first", async () => {
    const f = setup();
    const chain = await f.start();
    const snap = await f.snapshot();
    expect(snap.operations.map((operation) => operation.id)).toEqual(chain.steps.map((step) => step.operationId));
    expect(snap.operations.every((operation) => operation.threadId !== null)).toBe(true);
    expect(f.phases(chain)).toEqual(["working", "waiting", "waiting", "waiting"]);
    expect(f.tasks).toHaveLength(1);
    expect(f.tasks[0]).toContain("step 1 of 4");
    const review = snap.operations.find((operation) => operation.id === chain.steps[1]?.operationId);
    expect(review?.spec.dependencies).toEqual([chain.steps[0]?.operationId]);
    expect(review?.status).toBe("queued");
  });

  it("filters by workspace", async () => {
    const f = setup();
    await f.start();
    const other = await f.call<ChainsSnapshot>("chains_snapshot", { workspaceId: "someone-else" });
    expect(other.chains).toEqual([]);
    expect(other.operations).toEqual([]);
  });
});

describe("phase derivation", () => {
  it("walks Implement -> Review -> Fix -> Test with waiting reasons and next actions", async () => {
    const f = setup();
    let chain = await f.start();
    expect(chain.phase).toBe("running");
    expect(chain.steps[1]?.waitingReason).toBe("Waiting for Implement");
    expect(chain.nextAction).toBe("Waiting for Implement to finish");

    chain = f.memory.controls.advance(chain.id, "implement", "passed");
    expect(f.phases(chain)).toEqual(["passed", "working", "waiting", "waiting"]);
    expect(chain.steps[2]?.waitingReason).toBe("Waiting for Review");

    chain = f.memory.controls.advance(chain.id, "review", "changes_requested");
    expect(f.phases(chain)).toEqual(["passed", "changes_requested", "working", "waiting"]);

    chain = f.memory.controls.advance(chain.id, "fix", "passed");
    chain = f.memory.controls.advance(chain.id, "test", "passed");
    expect(chain.phase).toBe("ready_to_merge");
    expect(chain.nextAction).toContain("merge");
    expect(chain.branch).toBeTruthy();
  });

  it("skips Fix automatically when every review predecessor passed, and says why", async () => {
    const f = setup();
    let chain = await f.start();
    chain = f.memory.controls.advance(chain.id, "implement", "passed");
    chain = f.memory.controls.advance(chain.id, "review", "passed");
    expect(f.phases(chain)).toEqual(["passed", "passed", "skipped", "working"]);
    expect(chain.steps[2]?.waitingReason).toBe("Review passed; nothing to fix");
    expect(chain.steps[2]?.report).toBeNull();
  });

  it("a finished turn without a report needs a report, and recording it settles the step", async () => {
    const f = setup();
    let chain = await f.start();
    chain = f.memory.controls.advance(chain.id, "implement", "no_report");
    expect(f.phases(chain)).toEqual(["needs_report", "waiting", "waiting", "waiting"]);
    expect(chain.phase).toBe("needs_you");
    expect(chain.nextAction).toBe("Open Implement to record its outcome");
    chain = await f.call<Chain>("chains_record_step", {
      id: chain.id,
      stepKey: "implement",
      result: "passed",
      summary: "Checked by hand",
    });
    expect(chain.steps[0]?.report).toMatchObject({ result: "passed", source: "you" });
    expect(f.phases(chain)).toEqual(["passed", "working", "waiting", "waiting"]);
  });

  it("only records a step that is waiting for a report", async () => {
    const f = setup();
    const chain = await f.start();
    await expect(
      f.call("chains_record_step", { id: chain.id, stepKey: "implement", result: "passed", summary: "x" }),
    ).rejects.toMatchObject({ code: "chain_step_not_waiting_for_report" });
  });

  it("a failed step blocks only its dependents", async () => {
    const f = setup();
    let chain = await f.start([
      def("implement", "implement"),
      def("review", "review", ["implement"]),
      def("docs", "review", ["implement"]),
      def("fix", "fix", ["review"]),
    ]);
    chain = f.memory.controls.advance(chain.id, "implement", "passed");
    expect(f.phases(chain)).toEqual(["passed", "working", "working", "waiting"]);
    chain = f.memory.controls.advance(chain.id, "review", "failed");
    expect(f.phases(chain)).toEqual(["passed", "failed", "working", "blocked"]);
    expect(chain.steps[3]?.waitingReason).toBe("Blocked by Review");
    expect(chain.phase).toBe("blocked");
    expect(chain.nextAction).toBe("Retry or skip Review");
    const snap = await f.snapshot();
    expect(snap.operations.find((operation) => operation.id === chain.steps[3]?.operationId)?.status).toBe("blocked");
    expect(snap.operations.find((operation) => operation.id === chain.steps[2]?.operationId)?.status).toBe("running");
  });

  it("supersedes steps that have not started", async () => {
    const f = setup();
    let chain = await f.start();
    chain = f.memory.controls.supersede(chain.id);
    expect(f.phases(chain)).toEqual(["working", "superseded", "superseded", "superseded"]);
    expect(chain.phase).toBe("superseded");
    expect(chain.steps[1]?.waitingReason).toBe(chain.supersededReason);
  });
});

describe("decisions", () => {
  it("retry rewires dependents to a new attempt and lets them continue", async () => {
    const f = setup();
    let chain = await f.start();
    chain = f.memory.controls.advance(chain.id, "implement", "failed");
    expect(f.phases(chain)).toEqual(["failed", "blocked", "blocked", "blocked"]);
    const failedOperation = chain.steps[0]?.operationId;
    chain = await f.call<Chain>("chains_retry_step", { id: chain.id, stepKey: "implement", route: null });
    expect(chain.steps[0]?.attempt).toBe(2);
    expect(chain.steps[0]?.operationId).not.toBe(failedOperation);
    expect(chain.steps[0]?.report).toBeNull();
    expect(f.phases(chain)).toEqual(["working", "waiting", "waiting", "waiting"]);
    const snap = await f.snapshot();
    expect(
      snap.operations.find((operation) => operation.id === chain.steps[1]?.operationId)?.spec.dependencies,
    ).toEqual([chain.steps[0]?.operationId]);
    expect(snap.operations.some((operation) => operation.id === failedOperation)).toBe(false);
  });

  it("retry can move the step to another route, and refuses a step that did not stop", async () => {
    const f = setup();
    let chain = await f.start();
    await expect(f.call("chains_retry_step", { id: chain.id, stepKey: "implement" })).rejects.toMatchObject({
      code: "chain_step_not_retryable",
    });
    f.memory.controls.advance(chain.id, "implement", "failed");
    chain = await f.call<Chain>("chains_retry_step", {
      id: chain.id,
      stepKey: "implement",
      route: { providerId: "claude-code", providerAccountId: "acct", model: "sonnet", effort: "high" },
    });
    const snap = await f.snapshot();
    expect(snap.operations.find((operation) => operation.id === chain.steps[0]?.operationId)?.spec).toMatchObject({
      providerId: "claude-code",
      model: "sonnet",
    });
  });

  it("skip lets dependents continue without the step", async () => {
    const f = setup();
    let chain = await f.start();
    chain = f.memory.controls.advance(chain.id, "implement", "passed");
    chain = f.memory.controls.advance(chain.id, "review", "failed");
    chain = await f.call<Chain>("chains_skip_step", { id: chain.id, stepKey: "review" });
    expect(chain.steps[1]?.phase).toBe("skipped");
    // Fix has no passed review predecessor (it was skipped), so it runs.
    expect(f.phases(chain)).toEqual(["passed", "skipped", "working", "waiting"]);
    await expect(f.call("chains_skip_step", { id: chain.id, stepKey: "implement" })).rejects.toMatchObject({
      code: "chain_step_not_skippable",
    });
  });

  it("reroute changes a step that has not started, never one that has", async () => {
    const f = setup();
    const chain = await f.start();
    const route = { providerId: "claude-code", providerAccountId: "acct", model: "sonnet", effort: "low" };
    await expect(f.call("chains_reroute_step", { id: chain.id, stepKey: "implement", route })).rejects.toMatchObject({
      code: "chain_step_started",
    });
    await f.call("chains_reroute_step", { id: chain.id, stepKey: "review", route });
    const snap = await f.snapshot();
    expect(snap.operations.find((operation) => operation.id === chain.steps[1]?.operationId)?.spec).toMatchObject({
      providerId: "claude-code",
      effort: "low",
    });
    await expect(
      f.call("chains_reroute_step", { id: chain.id, stepKey: "review", route: { ...route, model: "" } }),
    ).rejects.toMatchObject({ code: "chain_route_invalid" });
  });

  it("pause holds steps that have not started; resume releases them; running steps keep running", async () => {
    const f = setup();
    let chain = await f.start();
    chain = await f.call<Chain>("chains_pause", { id: chain.id });
    expect(chain.phase).toBe("paused");
    expect(f.phases(chain)).toEqual(["working", "paused", "paused", "paused"]);
    // The running step finishes while paused; its dependent does not start.
    chain = f.memory.controls.advance(chain.id, "implement", "passed");
    expect(f.phases(chain)).toEqual(["passed", "paused", "paused", "paused"]);
    chain = await f.call<Chain>("chains_resume", { id: chain.id });
    expect(chain.phase).toBe("running");
    expect(f.phases(chain)).toEqual(["passed", "working", "waiting", "waiting"]);
  });

  it("cancel stops steps that have not started and leaves started ones alone", async () => {
    const f = setup();
    let chain = await f.start();
    chain = await f.call<Chain>("chains_cancel", { id: chain.id });
    expect(chain.phase).toBe("cancelled");
    expect(f.phases(chain)).toEqual(["working", "cancelled", "cancelled", "cancelled"]);
    chain = f.memory.controls.advance(chain.id, "implement", "passed");
    expect(f.phases(chain)).toEqual(["passed", "cancelled", "cancelled", "cancelled"]);
    await expect(f.call("chains_pause", { id: chain.id })).rejects.toMatchObject({ code: "chain_cancelled" });
    await expect(f.call("chains_cancel", { id: "ghost" })).rejects.toMatchObject({ code: "chain_not_found" });
  });
});

describe("auto-advance", () => {
  it("runs every step to ready_to_merge on a timer, and can be turned off", async () => {
    vi.useFakeTimers();
    const f = setup(1500);
    const chain = await f.start([def("implement", "implement"), def("review", "review", ["implement"])]);
    expect(f.phases(chain)).toEqual(["working", "waiting"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.phases((await f.snapshot()).chains[0] as Chain)).toEqual(["passed", "working"]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(((await f.snapshot()).chains[0] as Chain).phase).toBe("ready_to_merge");

    const manual = setup(1500);
    const held = await manual.start();
    manual.memory.controls.setAutoAdvance(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(manual.phases((await manual.snapshot()).chains[0] as Chain)).toEqual(manual.phases(held));
  });
});
