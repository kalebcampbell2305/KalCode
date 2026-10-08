import type { Chain, ChainStep, Notification, OperationRecord, ThreadSummary } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { waitingAgents } from "../../runtime/actions.ts";
import {
  type AttentionOperation,
  attentionItems,
  attentionSummary,
  REVIEW_WINDOW_MS,
  STALLED_AFTER_MS,
  sourceOf,
} from "./model.ts";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function agent(patch: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "a1",
    name: "Billing Fix",
    providerId: "codex",
    providerName: "Codex",
    model: "gpt-5",
    effort: null,
    providerAccountId: null,
    accountLabel: null,
    workspaceId: "w1",
    workspaceName: "kalcode",
    permissionMode: "bypass",
    status: "running_command",
    currentActivity: null,
    createdAt: ago(60_000),
    lastActivityAt: ago(1_000),
    pendingApprovals: 0,
    unreadMessages: 0,
    filesChanged: null,
    branch: null,
    error: null,
    archivedAt: null,
    resumable: true,
    permissionProfileId: null,
    runtimeKind: "interactive_pty",
    terminalId: "t1",
    worktreeId: null,
    ...patch,
  } as ThreadSummary;
}

function signOut(patch: Partial<Notification> = {}): Notification {
  return {
    id: "n1",
    kind: "provider_disconnected",
    severity: "warning",
    title: "Claude Code is signed out",
    body: "Threads that use Claude Code can't start until you sign in again.",
    entityKind: "provider",
    entityId: "claude-code",
    workspaceId: null,
    createdAt: ago(5_000),
    updatedAt: ago(5_000),
    readAt: null,
    count: 1,
    ...patch,
  } as Notification;
}

function operation(patch: Partial<OperationRecord> & { attentionReason?: string | null } = {}): AttentionOperation {
  return {
    id: "op-1",
    spec: {
      name: "Release desktop",
      workspaceId: "w1",
      kind: "release",
      command: "pnpm release",
      prompt: null,
      providerId: null,
      providerAccountId: null,
      model: null,
      effort: null,
      dependencies: [],
      priority: 8,
      lane: "next",
      environment: "production",
      urls: [],
      envKeys: [],
    },
    source: "operations",
    status: "running",
    workspaceName: "kalcode",
    branch: "feat/release",
    version: null,
    accountLabel: null,
    terminalId: "term-1",
    threadId: null,
    createdAt: ago(60_000),
    startedAt: ago(50_000),
    endedAt: null,
    currentAction: "Packaging",
    outcome: null,
    position: 0,
    blockers: [],
    ...patch,
  } as AttentionOperation;
}

const none = new Set<string>();
const items = (input: Partial<Parameters<typeof attentionItems>[0]>) =>
  attentionItems({
    agents: [],
    approvals: [],
    notifications: [],
    operations: [],
    operationsFailed: false,
    dismissed: none,
    now: NOW,
    ...input,
  });

describe("attentionItems", () => {
  it("keeps ordinary progress out of the inbox", () => {
    expect(
      items({
        agents: [
          agent(),
          agent({ id: "a2", status: "idle", currentActivity: "Ready for a task" }),
          agent({ id: "a3", status: "completed", filesChanged: 0 }),
          agent({ id: "a4", status: "starting" }),
        ],
      }),
    ).toEqual([]);
  });

  it("says what, why and what next for a question, opening the exact agent", () => {
    const [item] = items({
      agents: [agent({ status: "waiting_for_user", currentActivity: "Which pricing tier should be default?" })],
    });
    expect(item).toMatchObject({
      kind: "question",
      source: "Codex · Billing Fix",
      what: "Asked you a question",
      why: "Which pricing tier should be default?",
      dismissible: false,
      actions: [{ id: "open-agent", agentId: "a1", workspaceId: "w1" }],
    });
  });

  it("offers Retry for a failed agent and explains the failure", () => {
    const [item] = items({
      agents: [agent({ status: "failed", error: { code: "x", message: "Subscription webhook test failed." } })],
    });
    expect(item?.kind).toBe("failed");
    expect(item?.why).toBe("Subscription webhook test failed.");
    expect(item?.actions.map((a) => a.label)).toEqual(["Open agent", "Retry"]);
  });

  it("treats a pending approval on an agent as one item, and a stray approval as its own", () => {
    const list = items({
      agents: [agent({ pendingApprovals: 1 })],
      approvals: [
        { id: "p1", action: { threadId: "a1", summary: "Run rm -rf build", requestedAt: ago(1_000) } },
        { id: "p2", action: { threadId: null, summary: "Open the production database", requestedAt: ago(2_000) } },
      ],
    });
    expect(list.map((i) => i.kind)).toEqual(["approval", "approval"]);
    expect(list.map((i) => i.agentId)).toEqual(["a1", null]);
  });

  it("flags an agent marked working with no activity for a while, and not before", () => {
    expect(items({ agents: [agent({ lastActivityAt: ago(STALLED_AFTER_MS - 1_000) })] })).toEqual([]);
    const [item] = items({ agents: [agent({ lastActivityAt: ago(STALLED_AFTER_MS + 4 * 60_000) })] });
    expect(item?.kind).toBe("stalled");
    expect(item?.what).toBe("No activity for 24 min");
  });

  it("asks for review of finished work with changes, within a day", () => {
    const [item] = items({ agents: [agent({ status: "completed", filesChanged: 6, branch: "kal/billing" })] });
    expect(item).toMatchObject({ kind: "review", what: "Finished · 6 files changed" });
    expect(item?.why).toContain("kal/billing");
    expect(
      items({ agents: [agent({ status: "completed", filesChanged: 6, lastActivityAt: ago(REVIEW_WINDOW_MS + 1) })] }),
    ).toEqual([]);
  });

  it("leaves failures older than a day to the Fleet, so old failures never flood the inbox", () => {
    const old = Array.from({ length: 121 }, (_, i) =>
      agent({ id: `f${i}`, status: "failed", lastActivityAt: ago(REVIEW_WINDOW_MS + 60_000) }),
    );
    expect(items({ agents: [...old, agent({ id: "new", status: "failed" })] }).map((i) => i.agentId)).toEqual(["new"]);
  });

  it("hides a dismissed occurrence but shows the next one", () => {
    const failed = agent({ status: "failed" });
    const [first] = items({ agents: [failed] });
    const dismissed = new Set([first?.key ?? ""]);
    expect(items({ agents: [failed], dismissed })).toEqual([]);
    expect(items({ agents: [{ ...failed, lastActivityAt: ago(0) }], dismissed })).toHaveLength(1);
  });

  it("never lets a state that clears itself be dismissed", () => {
    const question = agent({ status: "waiting_for_user" });
    const [item] = items({ agents: [question] });
    expect(items({ agents: [question], dismissed: new Set([item?.key ?? ""]) })).toHaveLength(1);
  });

  it("raises one sign-in item per signed-out provider and ignores read ones", () => {
    const list = items({
      notifications: [signOut(), signOut({ id: "n2" }), signOut({ id: "n3", entityId: "codex", readAt: ago(1) })],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: "auth",
      source: "Claude Code",
      actions: [{ id: "sign-in" }, { id: "dismiss" }],
    });
  });

  it("ignores archived agents and sorts blockers before reviews", () => {
    const list = items({
      agents: [
        agent({ id: "r", status: "completed", filesChanged: 2, lastActivityAt: ago(0) }),
        agent({ id: "q", status: "waiting_for_user", lastActivityAt: ago(60_000) }),
        agent({ id: "x", status: "failed", archivedAt: ago(1) }),
      ],
    });
    expect(list.map((i) => i.agentId)).toEqual(["q", "r"]);
  });

  it("works the same for every provider", () => {
    for (const [providerId, providerName] of [
      ["claude-code", "Claude Code"],
      ["codex", "Codex"],
      ["cursor", "Cursor"],
      ["gemini", "Gemini CLI"],
    ] as const) {
      const [item] = items({ agents: [agent({ providerId, providerName, status: "waiting_for_user" })] });
      expect(item?.source).toBe(`${providerName} · Billing Fix`);
    }
  });
  it("shows one actionable blocked operation and opens its exact queue row", () => {
    const [item] = items({
      operations: [
        operation({
          status: "paused",
          startedAt: null,
          currentAction: "Choose another Codex account",
          attentionReason: "The selected Codex account is signed out. Choose another account or sign in.",
        }),
      ],
    });
    expect(item).toMatchObject({
      kind: "blocked",
      source: "Operations",
      what: "Release desktop is blocked",
      why: "The selected Codex account is signed out. Choose another account or sign in.",
      dismissible: false,
      actions: [
        {
          id: "open-operation",
          operationId: "op-1",
          workspaceId: "w1",
          tab: "queue",
        },
      ],
    });
  });

  it("keeps expected dependency waits and ordinary pauses out, surfacing only the failed dependency", () => {
    const failed = operation({ id: "test", status: "failed", endedAt: ago(5_000), outcome: "Tests failed." });
    const waiting = operation({
      id: "deploy",
      status: "blocked",
      startedAt: null,
      spec: { ...operation().spec, name: "Deploy", dependencies: ["test"] },
      blockers: ["test"],
      currentAction: "Waiting for Tests",
    });
    const paused = operation({ id: "docs", status: "paused", startedAt: null, currentAction: "Held by user" });
    const list = items({ operations: [waiting, paused, failed] });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ what: "Release desktop failed", actions: [{ tab: "runs" }] });
  });

  it("does not duplicate an operation for the same agent session", () => {
    const list = items({
      agents: [agent({ id: "a1", status: "failed", error: { code: "failed", message: "Agent failed." } })],
      operations: [operation({ status: "failed", endedAt: ago(1_000), threadId: "a1", outcome: "Run failed." })],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ agentId: "a1" });
    expect(list[0]?.source).toContain("Billing Fix");
  });

  it("surfaces interrupted work, then clears it after recovery or when it becomes stale", () => {
    const interrupted = operation({ status: "interrupted", endedAt: ago(2_000), outcome: "The host restarted." });
    expect(items({ operations: [interrupted] })[0]).toMatchObject({
      kind: "failed",
      what: "Release desktop was interrupted",
      why: "The host restarted.",
    });
    expect(items({ operations: [{ ...interrupted, status: "running", endedAt: null }] })).toEqual([]);
    expect(items({ operations: [{ ...interrupted, endedAt: ago(REVIEW_WINDOW_MS + 1) }] })).toEqual([]);
  });

  it("never reports all-clear when the canonical Operations read fails", () => {
    const [item] = items({ operationsFailed: true });
    expect(item).toMatchObject({
      key: "operations:unavailable",
      kind: "failed",
      what: "Couldn't check runs and queue",
      dismissible: false,
      actions: [{ id: "open-operations" }],
    });
  });

  it("shows one ownership warning per overlapping pair with both exact agents", () => {
    const list = items({
      agents: [
        agent({ id: "billing", name: "Billing Fix" }),
        agent({ id: "pricing", name: "Pricing Update", providerName: "Claude Code" }),
      ],
      overlaps: [
        {
          agentIds: ["billing", "pricing"],
          workspaceId: "w1",
          files: ["README.md", "src/pricing.ts"],
          incomplete: false,
        },
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      key: "ownership:billing:pricing",
      kind: "blocked",
      source: "Ownership",
      what: "Billing Fix and Pricing Update overlap",
      actions: [
        { id: "open-agent", agentId: "billing", workspaceId: "w1" },
        { id: "open-agent", agentId: "pricing", workspaceId: "w1" },
      ],
    });
    expect(list[0]?.why).toContain("README.md, src/pricing.ts");
  });

  it("surfaces failed and incomplete shared reads instead of a false all-clear", () => {
    const list = items({ agentReadFailed: true, ownershipFailed: true });
    expect(list.map((item) => item.key)).toEqual(["agents:unavailable", "ownership:unavailable"]);
    expect(list.map((item) => item.actions[0]?.id)).toEqual(["retry-agents", "retry-ownership"]);

    const [partial] = items({ ownershipIncomplete: true });
    expect(partial).toMatchObject({
      key: "ownership:incomplete",
      kind: "blocked",
      actions: [{ id: "retry-ownership" }],
    });
    expect(partial?.why).toContain("more may exist");
  });
});

describe("copy and helpers", () => {
  it("summarises counts provider-neutrally", () => {
    expect(attentionSummary([])).toBe("Nothing needs you");
    expect(attentionSummary(items({ agents: [agent({ status: "failed" })] }))).toBe("1 blocked on you");
    expect(
      attentionSummary(
        items({
          operations: [
            operation({ status: "paused", startedAt: null, attentionReason: "Choose a signed-in account." }),
          ],
        }),
      ),
    ).toBe("1 blocked on you");
    expect(
      attentionSummary(
        items({
          agents: [
            agent({ id: "q", status: "waiting_for_user" }),
            agent({ id: "r", status: "completed", filesChanged: 3 }),
            agent({ id: "s", lastActivityAt: ago(STALLED_AFTER_MS * 2) }),
          ],
        }),
      ),
    ).toBe("1 blocked on you · 1 to review · 1 stalled");
  });

  it("names an unnamed agent by its provider only", () => {
    expect(sourceOf({ providerName: "Codex", name: "Codex" })).toBe("Codex");
  });

  it("finds the waiting agents newest first", () => {
    const list = waitingAgents([
      agent({ id: "old", status: "waiting_for_user", lastActivityAt: ago(10_000) }),
      agent({ id: "new", pendingApprovals: 1, lastActivityAt: ago(0) }),
      agent({ id: "busy" }),
    ]);
    expect(list.map((a) => a.id)).toEqual(["new", "old"]);
  });
});

function chainStep(patch: Partial<ChainStep> = {}): ChainStep {
  return {
    key: "review",
    name: "Review",
    intent: "review",
    instructions: null,
    dependsOn: [],
    position: 0,
    operationId: "step-op",
    attempt: 1,
    phase: "working",
    waitingReason: null,
    report: null,
    ...patch,
  };
}

function chain(steps: ChainStep[], patch: Partial<Chain> = {}): Chain {
  return {
    id: "c1",
    name: "Billing fix",
    goal: "Fix billing",
    acceptance: [],
    workspaceId: "w1",
    worktree: "shared",
    branch: null,
    createdAt: ago(60_000),
    paused: false,
    cancelled: false,
    supersededReason: null,
    phase: "running",
    nextAction: null,
    steps,
    ...patch,
  };
}

describe("handoff chain items", () => {
  it("asks for a report when a step finished without one", () => {
    const [item, ...rest] = items({
      chains: [chain([chainStep({ phase: "needs_report" })], { phase: "needs_you" })],
      chainOperations: new Map([["step-op", operation({ id: "step-op", threadId: "step-op" })]]),
    });
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      kind: "question",
      what: "Billing fix: Review finished without a report",
      why: "KalCode can't tell whether this step passed. Open the agent to check, then record the outcome.",
      agentId: "step-op",
      dismissible: false,
    });
    expect(item?.actions).toEqual([
      { id: "open-agent", label: "Open agent", agentId: "step-op", workspaceId: "w1" },
      { id: "open-chain", label: "Record outcome", chainId: "c1" },
    ]);
  });

  it("never offers Open agent for a step that never started an agent", () => {
    const [item] = items({
      chains: [chain([chainStep({ phase: "needs_report" })], { phase: "needs_you" })],
    });
    expect(item?.agentId).toBeNull();
    expect(item?.actions).toEqual([{ id: "open-chain", label: "Record outcome", chainId: "c1" }]);
  });

  it("reports a failed step with the report's reason, and never its blocked dependents", () => {
    const failed = chainStep({
      phase: "failed",
      report: {
        result: "failed",
        summary: "Two tests still fail.",
        tests: [],
        blockers: [],
        source: "agent",
        recordedAt: ago(1_000),
      },
    });
    const list = items({
      chains: [
        chain(
          [
            failed,
            chainStep({ key: "fix", name: "Fix", operationId: "fix-op", phase: "blocked", dependsOn: ["review"] }),
            chainStep({ key: "test", name: "Test", operationId: "test-op", phase: "waiting" }),
          ],
          { phase: "blocked" },
        ),
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "failed", what: "Billing fix: Review failed" });
    expect(list[0]?.why).toContain("Two tests still fail.");
  });

  it("makes nothing of a step that is working, waiting, paused or done", () => {
    const phases = ["working", "waiting", "paused", "passed", "skipped", "starting"] as const;
    expect(items({ chains: [chain(phases.map((phase, i) => chainStep({ key: `s${i}`, phase })))] })).toEqual([]);
  });

  it("is silent for a cancelled chain and one item for a superseded chain", () => {
    const step = chainStep({ phase: "needs_report" });
    expect(items({ chains: [chain([step], { cancelled: true })] })).toEqual([]);
    const list = items({
      chains: [
        chain([chainStep({ phase: "superseded" })], { supersededReason: "Newer work merged it.", phase: "superseded" }),
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "blocked", key: "chain:superseded:c1" });
    expect(
      items({ chains: [chain([chainStep()], { supersededReason: "x" })], dismissed: new Set(["chain:superseded:c1"]) }),
    ).toEqual([]);
  });

  it("replaces the generic item for the same agent, but keeps a permission prompt", () => {
    const needsReport = chain([chainStep({ phase: "needs_report", operationId: "a1" })], { phase: "needs_you" });
    const asked = items({ agents: [agent({ id: "a1", status: "waiting_for_user" })], chains: [needsReport] });
    expect(asked.map((item) => item.key)).toEqual(["chain:report:c1:review:1"]);
    const approval = items({
      agents: [agent({ id: "a1", status: "waiting_for_permission", pendingApprovals: 1 })],
      chains: [needsReport],
    });
    expect(approval.map((item) => item.kind).toSorted()).toEqual(["approval", "question"]);
  });

  it("resolves the agent through the chains store's operation thread", () => {
    const [item] = items({
      chains: [chain([chainStep({ phase: "needs_report" })])],
      chainOperations: new Map([["step-op", operation({ id: "step-op", threadId: "thread-9" })]]),
    });
    expect(item?.agentId).toBe("thread-9");
    expect(item?.actions[0]).toMatchObject({ id: "open-agent", agentId: "thread-9" });
  });

  it("a new attempt is a new occurrence", () => {
    const first = items({ chains: [chain([chainStep({ phase: "failed", attempt: 1 })])] })[0];
    const second = items({ chains: [chain([chainStep({ phase: "failed", attempt: 2 })])] })[0];
    expect(first?.key).not.toBe(second?.key);
    expect(
      items({ chains: [chain([chainStep({ phase: "failed" })])], dismissed: new Set([first?.key ?? ""]) }),
    ).toEqual([]);
  });
});
