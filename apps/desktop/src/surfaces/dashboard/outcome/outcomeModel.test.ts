import type {
  OperationEnvironment,
  OperationRecord,
  OperationTestResult,
  ThreadSummary,
  ThreadWorktreeState,
} from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { thread } from "../data/testing.ts";
import { agentOutcome, hasOutcome, linkedRuns, type OutcomeRow, type OutcomeStage } from "./outcomeModel.ts";

function facts(overrides: Partial<ThreadWorktreeState> = {}): ThreadWorktreeState {
  return {
    threadId: "t",
    worktreeId: "w",
    branch: "kal/pricing-update",
    baseBranch: "main",
    ahead: 2,
    behind: 0,
    changed: 0,
    untracked: 0,
    conflicts: false,
    observedAt: "2026-10-05T10:00:00.000Z",
    changedPaths: [],
    changedPathsTruncated: false,
    ...overrides,
  };
}

function run(agent: ThreadSummary, overrides: Partial<OperationRecord> & { kind?: OperationRecord["spec"]["kind"] }) {
  const { kind = "test", ...rest } = overrides;
  return {
    id: `run-${kind}-${Math.random().toString(16).slice(2)}`,
    spec: {
      name: kind === "test" ? "pnpm test" : "Release",
      workspaceId: agent.workspaceId,
      kind,
      command: null,
      prompt: null,
      providerId: null,
      providerAccountId: null,
      model: null,
      effort: null,
      dependencies: [],
      priority: 0,
      lane: "next",
      environment: "local",
      urls: [],
      envKeys: [],
    },
    source: "thread",
    status: "succeeded",
    workspaceName: agent.workspaceName,
    branch: null,
    version: null,
    accountLabel: null,
    terminalId: null,
    threadId: agent.id,
    createdAt: "2026-10-05T10:00:00.000Z",
    startedAt: "2026-10-05T10:00:00.000Z",
    endedAt: "2026-10-05T10:01:00.000Z",
    currentAction: null,
    outcome: null,
    position: 0,
    blockers: [],
    ...rest,
  } satisfies OperationRecord;
}

const results = (passed: number, failed = 0): OperationTestResult[] => [
  ...Array.from({ length: passed }, (_, i) => ({ name: `check ${i}`, status: "passed", detail: "" })),
  ...Array.from({ length: failed }, (_, i) => ({ name: `bad ${i}`, status: "failed", detail: "" })),
];

const stage = (rows: OutcomeRow[], name: OutcomeStage) => rows.find((r) => r.stage === name);

describe("Squad downstream outcome evidence", () => {
  it("follows exact dependency links into parallel test and release operations", () => {
    const agent = thread({ id: "member" });
    const member = run(agent, { id: "member", kind: "agent" });
    const testRun = run(agent, { id: "test", kind: "test", threadId: null });
    testRun.spec.dependencies = [member.id];
    const release = run(agent, { id: "release", kind: "release", threadId: null });
    release.spec.dependencies = [testRun.id];
    const unrelated = run(agent, { id: "other-release", kind: "release", threadId: null });
    expect(linkedRuns(agent.id, [release, unrelated, testRun, member], ["release"])).toEqual([release]);
    expect(linkedRuns(agent.id, [release, testRun, member], ["test"])).toEqual([testRun]);
  });

  it("does not attribute outcomes by project, task name, or an unavailable dependency", () => {
    const agent = thread({ id: "member" });
    const unrelated = run(agent, { id: "release", kind: "release", threadId: null });
    unrelated.spec.dependencies = ["missing"];
    expect(linkedRuns(agent.id, [unrelated], ["release"])).toEqual([]);
  });

  it("does not cross another coding agent's ownership boundary", () => {
    const first = thread({ id: "first" });
    const second = thread({ id: "second" });
    const member = run(first, { id: "first", kind: "agent" });
    const next = run(second, { id: "second", kind: "agent" });
    next.spec.dependencies = [member.id];
    const testRun = run(second, { id: "test", kind: "test", threadId: null });
    testRun.spec.dependencies = [next.id];
    expect(linkedRuns(first.id, [member, next, testRun], ["test"])).toEqual([]);
    expect(linkedRuns(second.id, [member, next, testRun], ["test"])).toEqual([testRun]);
  });

  it("bounds malformed historical dependency cycles", () => {
    const agent = thread({ id: "member" });
    const member = run(agent, { id: "member", kind: "agent" });
    const check = run(agent, { id: "test", kind: "test", threadId: null });
    const release = run(agent, { id: "release", kind: "release", threadId: null });
    check.spec.dependencies = [member.id, release.id];
    release.spec.dependencies = [check.id];
    expect(linkedRuns(agent.id, [member, check, release], ["release"])).toEqual([release]);
  });

  it("never claims delivery from a successful command without environment proof", () => {
    const agent = thread({ id: "member" });
    const release = run(agent, { kind: "release", version: "0.1.9+1900" });
    expect(stage(agentOutcome(agent, undefined, { runs: [release] }), "release")).toMatchObject({
      value: "Command succeeded",
      detail: "Delivery has not been verified",
      tone: "muted",
    });
  });
});

describe("agentOutcome", () => {
  it("a working agent says only what is observed", () => {
    const agent = thread({ status: "editing", filesChanged: null });
    const rows = agentOutcome(agent);
    expect(stage(rows, "agent")).toMatchObject({ value: "WORKING", tone: "working", known: true });
    expect(stage(rows, "changes")).toMatchObject({ value: "Not reported", known: false });
    expect(stage(rows, "tests")).toMatchObject({ value: "No test run recorded", known: false });
    expect(stage(rows, "merge")).toMatchObject({ known: false });
    expect(stage(rows, "release")).toBeUndefined();
    expect(hasOutcome(rows)).toBe(false);
  });

  it("a fresh agent with no files changed has no outcome yet; a finished one does", () => {
    expect(
      hasOutcome(agentOutcome(thread({ status: "idle", currentActivity: "Ready for a task", filesChanged: 0 }))),
    ).toBe(false);
    expect(hasOutcome(agentOutcome(thread({ status: "completed", filesChanged: 0 })))).toBe(true);
  });

  it("keeps a working agent's merge stage at 'not yet' even with uncommitted edits", () => {
    const agent = thread({ status: "editing", worktreeId: "w", branch: "kal/x", filesChanged: 2 });
    expect(stage(agentOutcome(agent, facts({ changed: 2, ahead: 0 })), "merge")).toMatchObject({
      value: "Not yet",
      known: false,
    });
  });

  it("done with 6 files and 19/19 checks passed", () => {
    const agent = thread({ status: "completed", filesChanged: 6, worktreeId: "w", branch: "kal/pricing-update" });
    const rows = agentOutcome(agent, facts(), { runs: [run(agent, {})], tests: results(19) });
    expect(stage(rows, "agent")).toMatchObject({ value: "DONE", tone: "done" });
    expect(stage(rows, "changes")).toMatchObject({ value: "6 files", detail: "kal/pricing-update · own worktree" });
    expect(stage(rows, "tests")).toMatchObject({ value: "19/19 passed", tone: "done", known: true });
    expect(stage(rows, "merge")).toMatchObject({ value: "Ready to merge", tone: "accent", detail: "2 commits → main" });
    expect(hasOutcome(rows)).toBe(true);
    expect(rows.map((r) => r.short)).toEqual(["Agent done", "6 files", "Tests 19/19 passed", "Ready to merge"]);
  });

  it("reports failed tests from the latest linked run only", () => {
    const agent = thread({ status: "completed", filesChanged: 3 });
    const older = run(agent, { status: "succeeded", startedAt: "2026-10-05T09:00:00.000Z" });
    const latest = run(agent, { status: "failed", startedAt: "2026-10-05T11:00:00.000Z" });
    const other = run(thread({}), { status: "succeeded", startedAt: "2026-10-05T12:00:00.000Z" });
    expect(stage(agentOutcome(agent, undefined, { runs: [older, latest, other] }), "tests")).toMatchObject({
      value: "Failed",
      tone: "failed",
    });
    expect(stage(agentOutcome(agent, undefined, { runs: [latest], tests: results(17, 2) }), "tests")).toMatchObject({
      value: "2 of 19 failed",
      tone: "failed",
    });
  });

  it("never borrows another agent's runs", () => {
    const agent = thread({ status: "completed", filesChanged: 1 });
    const rows = agentOutcome(agent, undefined, { runs: [run(thread({}), { kind: "release" })] });
    expect(stage(rows, "tests")).toMatchObject({ known: false });
    expect(stage(rows, "release")).toBeUndefined();
  });

  it("says a merge would conflict", () => {
    const agent = thread({ status: "completed", filesChanged: 4, worktreeId: "w", branch: "kal/x" });
    expect(stage(agentOutcome(agent, facts({ conflicts: true })), "merge")).toMatchObject({
      value: "Would conflict",
      tone: "failed",
      known: true,
    });
  });

  it("keeps clean work ready to merge but names agents Git says it conflicts with", () => {
    const agent = thread({ status: "completed", filesChanged: 4, worktreeId: "w", branch: "kal/x" });
    expect(stage(agentOutcome(agent, facts()), "merge")).toMatchObject({ value: "Ready to merge", tone: "accent" });
    expect(stage(agentOutcome(agent, facts(), { conflictsWith: ["Pricing Update"] }), "merge")).toMatchObject({
      value: "Ready to merge",
      tone: "waiting",
      detail: "Conflicts with Pricing Update: the second to merge needs a fix",
      known: true,
    });
    expect(
      stage(agentOutcome(agent, facts(), { conflictsWith: ["Pricing Update", "Billing Fix", "Docs"] }), "merge")
        ?.detail,
    ).toBe("Conflicts with Pricing Update and 2 other agents: the second to merge needs a fix");
  });

  it("states merged work as the Git fact, never as shipped", () => {
    const agent = thread({ status: "completed", filesChanged: 6, worktreeId: "w", branch: "kal/pricing-update" });
    const rows = agentOutcome(agent, facts({ ahead: 0 }));
    expect(stage(rows, "merge")).toMatchObject({
      value: "No unmerged commits",
      detail: "Everything on kal/pricing-update is in main",
      known: true,
    });
    expect(stage(rows, "release")).toBeUndefined();
  });

  it("shows uncommitted work before anything else about the merge", () => {
    const agent = thread({ status: "idle", filesChanged: 2, worktreeId: "w", branch: "kal/x" });
    expect(stage(agentOutcome(agent, facts({ changed: 1, untracked: 1 })), "merge")).toMatchObject({
      value: "Uncommitted changes",
      detail: "2 changes",
    });
  });

  it("without a worktree read, the merge stage is unknown", () => {
    const agent = thread({ status: "completed", filesChanged: 2, worktreeId: "w", branch: "kal/x" });
    expect(stage(agentOutcome(agent), "merge")).toMatchObject({ value: "Not checked yet", known: false });
  });

  it("release appears only from a linked run, verified only by a healthy environment", () => {
    const agent = thread({ status: "completed", filesChanged: 6 });
    const release = run(agent, { kind: "release", version: "0.1.9+1801" });
    const env = (health: string): OperationEnvironment => ({
      workspaceId: agent.workspaceId,
      kind: "production",
      branch: "main",
      version: "0.1.9+1801",
      urls: [],
      deploymentStatus: "deployed_unverified",
      health,
      platform: null,
      lastDeploy: null,
      runId: release.id,
      variables: [],
      observedAt: "2026-10-05T10:00:00.000Z",
      notes: [],
    });
    expect(stage(agentOutcome(agent, undefined, { runs: [release] }), "release")).toMatchObject({
      value: "Command succeeded",
      detail: "Delivery has not been verified",
      tone: "muted",
    });
    expect(
      stage(agentOutcome(agent, undefined, { runs: [release], environments: [env("unknown")] }), "release"),
    ).toMatchObject({ value: "Released to Production 0.1.9+1801", detail: "Not verified yet", tone: "accent" });
    expect(
      stage(agentOutcome(agent, undefined, { runs: [release], environments: [env("healthy")] }), "release"),
    ).toMatchObject({ detail: "Health check passed", tone: "done" });
  });

  it("with no data at all, invents nothing", () => {
    const agent = thread({ status: "idle", filesChanged: null });
    const rows = agentOutcome(agent, undefined, {});
    expect(rows.filter((r) => r.known).map((r) => r.stage)).toEqual(["agent"]);
    expect(rows.map((r) => r.value).join(" ")).not.toMatch(/passed|merged|shipped|released|live/i);
  });
});
