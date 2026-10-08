import type {
  OperationRecord,
  ProviderAccount,
  SquadDefinition,
  SquadLaunch,
  SquadMemberDefinition,
  ThreadSummary,
} from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import type { AgentClaim } from "../../runtime/ownership/model.ts";
import { launchTruth, liveClaimCollisions, memberDisplay, memberTruth, ownershipCollisions } from "./model.ts";

function member(patch: Partial<SquadMemberDefinition> = {}): SquadMemberDefinition {
  return {
    key: "implementation",
    name: "Implementation",
    providerId: "codex",
    providerAccountId: "codex-work",
    model: "gpt-6.1-sol",
    effort: "high",
    role: "implementation",
    task: "Build it",
    worktree: true,
    dependsOn: [],
    managerKey: null,
    ownedPaths: ["apps/desktop/src"],
    ...patch,
  };
}

function operation(
  status: OperationRecord["status"],
  patch: Partial<OperationRecord> & { attentionReason?: string } = {},
): OperationRecord {
  return {
    id: "operation-implementation",
    spec: {
      name: "Implementation",
      kind: "agent",
      lane: "next",
      workspaceId: "workspace",
      command: null,
      prompt: "Build it",
      priority: 50,
      dependencies: [],
      providerId: "codex",
      providerAccountId: "codex-work",
      model: "gpt-6.1-sol",
      effort: "high",
      environment: "local",
      urls: [],
      envKeys: [],
    },
    source: "operations",
    status,
    workspaceName: "KalCode",
    branch: "feat/squads",
    version: null,
    accountLabel: "Work",
    terminalId: "terminal-implementation",
    threadId: "thread-implementation",
    createdAt: "2026-10-05T12:00:00Z",
    startedAt: status === "queued" ? null : "2026-10-05T12:00:01Z",
    endedAt: ["succeeded", "failed", "cancelled", "interrupted"].includes(status) ? "2026-10-05T12:05:00Z" : null,
    currentAction: null,
    outcome: null,
    position: 0,
    blockers: [],
    ...patch,
  };
}

function agent(status: ThreadSummary["status"]): ThreadSummary {
  return {
    id: "thread-implementation",
    name: "Implementation",
    providerId: "codex",
    providerName: "Codex",
    model: "gpt-6.1-sol",
    effort: "high",
    providerAccountId: "codex-work",
    accountLabel: "Work",
    workspaceId: "workspace",
    workspaceName: "KalCode",
    permissionMode: "approve",
    status,
    currentActivity: status === "active" ? "Working on another turn" : null,
    createdAt: "2026-10-05T12:00:00Z",
    lastActivityAt: "2026-10-05T12:06:00Z",
    pendingApprovals: 0,
    unreadMessages: 0,
    filesChanged: 2,
    branch: "feat/squads",
    error: null,
    archivedAt: null,
    resumable: true,
    permissionProfileId: null,
    runtimeKind: "interactive_pty",
    terminalId: "terminal-implementation",
    worktreeId: "worktree-implementation",
  };
}

const definition: SquadDefinition = {
  id: "squad-orion",
  name: "Orion Release Crew",
  goal: "Ship the updater reliability pass",
  members: [member()],
};

const launch: SquadLaunch = {
  id: "launch-orion",
  squadId: definition.id,
  name: definition.name,
  goal: definition.goal,
  workspaceId: "workspace",
  createdAt: "2026-10-05T12:00:00Z",
  members: [
    {
      key: "implementation",
      role: "implementation",
      managerKey: null,
      operationId: "operation-implementation",
      ownedPaths: ["apps/desktop/src"],
    },
  ],
};

describe("Squad canonical truth projection", () => {
  it("keeps a bounded successful Squad turn done when its reusable terminal starts another turn", () => {
    const truth = launchTruth(launch, [definition], [operation("succeeded")], [agent("active")]);

    expect(truth.members[0]).toMatchObject({ state: "done", label: "Done" });
    expect(truth.outcome).toBe("Agents done");
  });

  it("keeps a historical launch's operation identity after its reusable template is edited", () => {
    const relation = launch.members[0];
    expect(relation).toBeDefined();
    if (!relation) return;
    const edited = member({ name: "Replacement reviewer", providerId: "claude-code", model: "claude-opus-4-6" });
    const launched = operation("running");
    const truth = memberTruth(relation, edited, launched, []);

    expect(memberDisplay(truth)).toMatchObject({
      name: "Implementation",
      providerId: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
    });
  });

  it("projects a live provider selector ahead of the captured launch recipe", () => {
    const relation = launch.members[0];
    expect(relation).toBeDefined();
    if (!relation) return;
    const live = {
      ...agent("active"),
      accountLabel: "Old nickname",
      activeModel: "provider/model-v2",
      activeEffort: "ultra",
    } as ThreadSummary & { activeModel: string; activeEffort: string };
    const currentAccount = {
      id: "codex-work",
      providerId: "codex",
      displayName: "Current nickname",
      authenticationState: "authenticated",
      archivedAt: null,
    } as ProviderAccount;
    const truth = memberTruth(relation, definition.members[0] ?? null, operation("running"), [live]);

    expect(memberDisplay(truth, [currentAccount])).toMatchObject({
      model: "provider/model-v2",
      effort: "ultra",
      identity: {
        accountName: "Current nickname",
        model: { value: "provider/model-v2", source: "provider", label: "provider/model-v2" },
        effort: { value: "ultra", source: "provider", label: "ultra" },
      },
    });
  });

  it("does not turn an expected dependency wait into a decision, but honors an explicit recovery reason", () => {
    const relation = launch.members[0];
    expect(relation).toBeDefined();
    if (!relation) return;

    const dependencyWait = memberTruth(
      relation,
      definition.members[0] ?? null,
      operation("blocked", { blockers: ["operation-design"], threadId: null }),
      [],
    );
    const recovery = memberTruth(
      relation,
      definition.members[0] ?? null,
      operation("paused", { attentionReason: "Choose another signed-in account.", threadId: null }),
      [],
    );

    expect(dependencyWait).toMatchObject({ state: "waiting", label: "Waiting" });
    expect(recovery).toMatchObject({
      state: "needs_you",
      label: "Needs you",
      reason: "Choose another signed-in account.",
    });

    const waitingLaunch = launchTruth(
      launch,
      [definition],
      [operation("blocked", { blockers: ["operation-design"], threadId: null })],
      [],
    );
    expect(waitingLaunch).toMatchObject({ waiting: 1, needsYou: 0, outcome: "1 waiting" });
  });

  it("reports a fully cancelled launch as stopped instead of finished", () => {
    const truth = launchTruth(launch, [definition], [operation("cancelled")], [agent("active")]);

    expect(truth.completed).toBe(0);
    expect(truth.outcome).toBe("Squad stopped");
  });

  it("reports a terminal mix of completed and cancelled members instead of preparing forever", () => {
    const mixedLaunch: SquadLaunch = {
      ...launch,
      members: [
        ...launch.members,
        {
          key: "review",
          role: "review",
          managerKey: null,
          operationId: "operation-review",
          ownedPaths: ["apps/desktop/src/updater"],
        },
      ],
    };
    const truth = launchTruth(
      mixedLaunch,
      [definition],
      [operation("succeeded"), operation("cancelled", { id: "operation-review", threadId: null, terminalId: null })],
      [],
    );

    expect(truth.members.map(({ state }) => state)).toEqual(["done", "stopped"]);
    expect(truth.outcome).toBe("1 done · 1 stopped");
  });
});

describe("declared Squad ownership", () => {
  it("finds case-insensitive ancestor collisions and distinguishes shared edits from merge guidance", () => {
    const implementation = member({ key: "implementation", ownedPaths: ["Apps/Desktop/src/**"], worktree: true });
    const review = member({ key: "review", ownedPaths: ["apps\\desktop\\src\\updater"], worktree: true });
    const release = member({ key: "release", ownedPaths: ["apps/desktop/src/updater/feed.ts"], worktree: false });
    const sharedReview = member({
      key: "shared-review",
      ownedPaths: ["apps/desktop/src/updater"],
      worktree: false,
    });

    expect(ownershipCollisions([implementation, review])).toEqual([
      {
        path: "apps/desktop/src",
        memberKeys: ["implementation", "review"],
        mode: "merge",
        undeclared: false,
      },
    ]);
    expect(ownershipCollisions([review, release])).toEqual([
      {
        path: "apps/desktop/src/updater",
        memberKeys: ["review", "release"],
        mode: "merge",
        undeclared: false,
      },
    ]);
    expect(ownershipCollisions([sharedReview, release])).toEqual([
      {
        path: "apps/desktop/src/updater",
        memberKeys: ["shared-review", "release"],
        mode: "shared",
        undeclared: false,
      },
    ]);
  });

  it("treats undeclared ownership as the whole workspace only for shared-checkout pairs", () => {
    const unknown = member({ key: "unknown", ownedPaths: [], worktree: false });
    const scoped = member({ key: "scoped", ownedPaths: ["apps/desktop/src"], worktree: false });
    const disjoint = member({ key: "docs", ownedPaths: ["docs"], worktree: false });
    const isolated = member({ key: "isolated", ownedPaths: [], worktree: true });

    expect(ownershipCollisions([unknown, scoped])).toEqual([
      {
        path: "Entire workspace",
        memberKeys: ["unknown", "scoped"],
        mode: "shared",
        undeclared: true,
      },
    ]);
    expect(ownershipCollisions([scoped, disjoint])).toEqual([]);
    expect(ownershipCollisions([unknown, isolated])).toEqual([]);
  });
});

describe("live agent claims before launch", () => {
  const claim = (patch: Partial<AgentClaim> = {}): AgentClaim => ({
    agentId: "live-1",
    name: "Updater Fix",
    providerName: "Claude Code",
    workspaceId: "w1",
    worktreeId: null,
    branch: null,
    active: true,
    files: [],
    filesIncomplete: false,
    areas: [],
    received: null,
    handedTo: null,
    ...patch,
  });

  it("warns when an owned path enters files a running agent changed", () => {
    const warnings = liveClaimCollisions(
      [member({ key: "a", ownedPaths: ["src/billing/**"] })],
      [claim({ files: ["src/billing/invoice.ts"] })],
      "w1",
    );
    expect(warnings).toEqual([{ agentId: "live-1", paths: ["src/billing"], memberKeys: ["a"] }]);
  });

  it("warns on a declared area in either direction, but not on siblings", () => {
    const members = [member({ key: "a", ownedPaths: ["src/billing"] })];
    expect(liveClaimCollisions(members, [claim({ areas: ["src/billing/api/**"] })], "w1")).toHaveLength(1);
    expect(liveClaimCollisions(members, [claim({ areas: ["src"] })], "w1")).toHaveLength(1);
    expect(liveClaimCollisions(members, [claim({ areas: ["src/billing-old"] })], "w1")).toEqual([]);
  });

  it("ignores ended agents and other projects", () => {
    const members = [member({ ownedPaths: ["src"] })];
    const files = ["src/a.ts"];
    expect(liveClaimCollisions(members, [claim({ files, active: false })], "w1")).toEqual([]);
    expect(liveClaimCollisions(members, [claim({ files, workspaceId: "w2" })], "w1")).toEqual([]);
  });
});
