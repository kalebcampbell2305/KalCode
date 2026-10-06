import type {
  SquadDefinition,
  SquadLaunch,
  SquadMemberDefinition,
  SquadRecipe,
  SquadsSnapshot,
  ThreadSummary,
  Workspace,
} from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { createOperationsMemory } from "./operations.ts";
import { createSquadsMemory } from "./squads.ts";

const workspace: Workspace = {
  id: "00000000-0000-4000-8000-000000000010",
  name: "kalcode-site",
  rootPath: "C:\\Projects\\kalcode-site",
  displayPath: "~\\Projects\\kalcode-site",
  createdAt: "2026-09-30T12:00:00Z",
  lastOpenedAt: "2026-09-30T12:00:00Z",
  activeTerminalId: null,
  available: true,
};

const ACCOUNT = {
  codex: "0192f3c4-0000-7000-8000-000000000201",
  claude: "0192f3c4-0000-7000-8000-000000000101",
} as const;

function definition(overrides: Partial<SquadDefinition> = {}): SquadDefinition {
  return {
    id: "00000000-0000-4000-8000-00000000c001",
    name: "Platform Crew",
    goal: "Ship the platform pass",
    members: [
      {
        key: "lead",
        name: "Implementation lead",
        providerId: "codex",
        providerAccountId: ACCOUNT.codex,
        model: "gpt-5.6-sol",
        effort: "xhigh",
        role: "implementation",
        task: "Implement the platform pass",
        worktree: true,
        dependsOn: [],
        managerKey: null,
        ownedPaths: ["crates/**"],
      },
      {
        key: "tests",
        name: "Test engineer",
        providerId: "claude-code",
        providerAccountId: ACCOUNT.claude,
        model: "sonnet",
        effort: "high",
        role: "test",
        task: null,
        worktree: true,
        dependsOn: ["lead"],
        managerKey: "lead",
        ownedPaths: ["apps/desktop/tests/**"],
      },
    ],
    ...overrides,
  };
}

function memberAt(value: SquadDefinition, index: number): SquadMemberDefinition {
  const member = value.members[index];
  if (!member) throw new Error(`Missing test member ${index}`);
  return member;
}

function setup(unavailable = new Set<string>(), unavailableAccounts = new Set<string>()) {
  const operations = createOperationsMemory({ empty: true, workspaces: [workspace], requireCore() {} });
  const starts: string[] = [];
  const tasks: string[] = [];
  const statuses: Array<{ threadId: string; status: ThreadSummary["status"]; activity: string | null }> = [];
  const memory = createSquadsMemory({
    requireCore() {},
    operations: operations.agents,
    seedOrion: false,
    workspaceId: () => workspace.id,
    accountState: (member) => ({ available: !unavailableAccounts.has(member.key), accountLabel: "Personal" }),
    async createPane(member, workspaceId) {
      starts.push(member.key);
      if (unavailable.has(member.key)) {
        throw {
          category: "provider",
          code: "provider_account_not_authenticated",
          message: `${member.name}'s account is signed out.`,
          retryable: true,
        };
      }
      const id = `00000000-0000-4000-8000-${String(starts.length).padStart(12, "0")}`;
      return {
        id,
        providerId: member.providerId,
        providerAccountId: member.providerAccountId,
        model: member.model,
        effort: member.effort,
        workspaceId,
        branch: member.worktree ? `kal/${member.key}` : null,
        terminalId: id,
        accountLabel: "Personal",
      } as ThreadSummary;
    },
    async sendTask(threadId, task) {
      tasks.push(`${threadId}:${task}`);
    },
    setPaneStatus(threadId, status, activity) {
      statuses.push({ threadId, status, activity });
    },
  });
  const invoke = async (command: keyof typeof memory.handlers, args: Record<string, unknown> = {}) => {
    const handler = memory.handlers[command];
    if (!handler) throw new Error(`Missing ${command}`);
    return await handler(args);
  };
  return { memory, operations, starts, tasks, statuses, invoke };
}

describe("Squads memory runtime", () => {
  it("launches eligible members through real panes and leaves dependencies in canonical Operations", async () => {
    const f = setup();
    await f.invoke("squads_save", { definition: definition() });
    const launch = (await f.invoke("squads_launch", {
      squadId: "platform crew",
      workspaceId: workspace.id,
      requestId: "request-platform",
      goalOverride: null,
    })) as SquadLaunch;

    expect(f.starts).toEqual(["lead", "tests"]);
    expect(f.tasks).toHaveLength(1);
    const first = (await f.invoke("squads_snapshot")) as SquadsSnapshot;
    const lead = first.operations.find((item) => item.id === launch.members[0]?.operationId);
    const tests = first.operations.find((item) => item.id === launch.members[1]?.operationId);
    expect(lead).toEqual(expect.objectContaining({ status: "running", threadId: expect.any(String) }));
    expect(tests).toEqual(
      expect.objectContaining({
        status: "queued",
        threadId: expect.any(String),
        currentAction: "Waiting for dependencies",
        blockers: [lead?.id],
      }),
    );
    expect(f.statuses).toContainEqual(
      expect.objectContaining({ threadId: tests?.threadId, status: "waiting_for_dependency" }),
    );

    f.operations.agents.finish(lead?.id ?? "", "succeeded", "Implementation verified.");
    await f.invoke("squads_snapshot");
    expect(f.starts).toEqual(["lead", "tests"]);
    expect(f.tasks).toHaveLength(1);
    expect(f.operations.agents.exact([tests?.id ?? ""])[0]).toEqual(
      expect.objectContaining({ status: "running", threadId: expect.any(String) }),
    );
    expect(f.statuses).toContainEqual(expect.objectContaining({ threadId: tests?.threadId, status: "idle" }));
  });

  it("blocks only dependent work when a member fails", async () => {
    const f = setup();
    await f.invoke("squads_save", { definition: definition() });
    const launch = (await f.invoke("squads_launch", {
      squadId: definition().id,
      workspaceId: workspace.id,
      requestId: "failed-dependency",
      goalOverride: null,
    })) as SquadLaunch;
    const leadId = launch.members[0]?.operationId ?? "";
    const testsId = launch.members[1]?.operationId ?? "";

    f.operations.agents.finish(leadId, "failed", "Implementation failed.");
    await f.invoke("squads_snapshot");

    expect(f.starts).toEqual(["lead", "tests"]);
    const blocked = f.operations.agents.exact([testsId])[0];
    expect(blocked).toEqual(expect.objectContaining({ status: "blocked", blockers: [leadId] }));
    expect(blocked?.attentionReason).toBeUndefined();
  });

  it("precreates a dependent pane and delivers its launch task exactly once after admission", async () => {
    const f = setup();
    const base = definition();
    const withTask = definition({
      members: [memberAt(base, 0), { ...memberAt(base, 1), task: "Validate the platform pass" }],
    });
    await f.invoke("squads_save", { definition: withTask });
    const launch = (await f.invoke("squads_launch", {
      squadId: withTask.id,
      workspaceId: workspace.id,
      requestId: "withheld-task",
      goalOverride: null,
    })) as SquadLaunch;
    const leadId = launch.members[0]?.operationId ?? "";
    const testsId = launch.members[1]?.operationId ?? "";
    const waiting = f.operations.agents.exact([testsId])[0];

    expect(f.starts).toEqual(["lead", "tests"]);
    expect(f.tasks).toHaveLength(1);
    expect(waiting).toEqual(
      expect.objectContaining({ status: "queued", threadId: expect.any(String), blockers: [leadId] }),
    );
    await f.invoke("squads_snapshot");
    expect(f.tasks).toHaveLength(1);

    f.operations.agents.finish(leadId, "succeeded", "Implementation verified.");
    await f.invoke("squads_snapshot");
    await f.invoke("squads_snapshot");

    expect(f.tasks).toHaveLength(2);
    expect(f.operations.agents.exact([testsId])[0]).toEqual(
      expect.objectContaining({ status: "running", threadId: waiting?.threadId }),
    );
  });

  it("returns one launch for an idempotent request and rejects request object swapping", async () => {
    const f = setup();
    await f.invoke("squads_save", { definition: definition() });
    const args = {
      squadId: definition().id,
      workspaceId: workspace.id,
      requestId: "same-request",
      goalOverride: null,
    };
    const first = (await f.invoke("squads_launch", args)) as SquadLaunch;
    const second = (await f.invoke("squads_launch", args)) as SquadLaunch;
    expect(second).toEqual(first);
    expect(f.starts).toEqual(["lead", "tests"]);
    await expect(f.invoke("squads_launch", { ...args, goalOverride: "A different goal" })).rejects.toMatchObject({
      code: "squad_launch_request_conflict",
    });
  });

  it("replays an exact Squad request after definition deletion without advancing its prepared members", async () => {
    const f = setup();
    const base = definition();
    const saved = definition({
      members: [memberAt(base, 0), { ...memberAt(base, 1), task: "Validate the platform pass" }],
    });
    await f.invoke("squads_save", { definition: saved });
    const args = {
      squadId: saved.id,
      workspaceId: workspace.id,
      requestId: "deleted-squad-replay",
      goalOverride: null,
    };
    const first = (await f.invoke("squads_launch", args)) as SquadLaunch;
    const leadId = first.members[0]?.operationId ?? "";
    const testsId = first.members[1]?.operationId ?? "";
    f.operations.agents.finish(leadId, "succeeded", "Implementation verified.");
    await f.invoke("squads_delete", { id: saved.id });

    const replayed = (await f.invoke("squads_launch", args)) as SquadLaunch;

    expect(replayed).toEqual(first);
    expect(f.starts).toEqual(["lead", "tests"]);
    expect(f.tasks).toHaveLength(1);
    expect(f.operations.agents.exact([testsId])[0]).toEqual(
      expect.objectContaining({ status: "queued", currentAction: "Waiting for dependencies" }),
    );
    await expect(f.invoke("squads_launch", { ...args, squadId: saved.name })).rejects.toMatchObject({
      code: "squad_not_found",
    });
    await expect(
      f.invoke("recipe_launch", {
        recipeId: "00000000-0000-4000-8000-00000000c099",
        workspaceId: workspace.id,
        requestId: args.requestId,
        goalOverride: null,
      }),
    ).rejects.toMatchObject({ code: "squad_launch_request_conflict" });
  });

  it("deletes dependent Recipes only after an exact atomic confirmation", async () => {
    const f = setup();
    const saved = definition();
    const first: SquadRecipe = {
      id: "00000000-0000-4000-8000-00000000c002",
      name: "Release readiness",
      squadId: saved.id,
      goal: null,
    };
    const second: SquadRecipe = {
      id: "00000000-0000-4000-8000-00000000c003",
      name: "Ship desktop",
      squadId: saved.id,
      goal: "Publish the verified build",
    };
    await f.invoke("squads_save", { definition: saved });
    await f.invoke("recipe_save", { recipe: first });
    await f.invoke("recipe_save", { recipe: second });

    await expect(f.invoke("squads_delete", { id: saved.id })).rejects.toMatchObject({
      code: "squad_recipes_require_confirmation",
    });
    await expect(
      f.invoke("squads_delete", { id: saved.id, expectedRecipes: [{ ...first, name: "Changed" }, second] }),
    ).rejects.toMatchObject({ code: "squad_recipe_confirmation_stale" });
    await expect(
      f.invoke("squads_delete", { id: saved.id, expectedRecipes: [first, first, second] }),
    ).rejects.toMatchObject({ code: "squad_recipe_confirmation_duplicate" });
    await expect(
      f.invoke("squads_delete", { id: saved.id, expectedRecipes: [{ ...first, name: ` ${first.name} ` }, second] }),
    ).rejects.toMatchObject({ code: "squad_recipe_confirmation_stale" });

    await f.invoke("squads_delete", { id: saved.id, expectedRecipes: [second, first] });
    const after = (await f.invoke("squads_snapshot")) as SquadsSnapshot;
    expect(after.squads).toEqual([]);
    expect(after.recipes).toEqual([]);
  });

  it("replays an exact Recipe request after Recipe deletion without resolving its source again", async () => {
    const f = setup();
    const base = definition();
    const saved = definition({
      members: [memberAt(base, 0), { ...memberAt(base, 1), task: "Validate the platform pass" }],
    });
    const recipe: SquadRecipe = {
      id: "00000000-0000-4000-8000-00000000c002",
      name: "Platform release",
      squadId: saved.id,
      goal: "Ship from the Recipe",
    };
    await f.invoke("squads_save", { definition: saved });
    await f.invoke("recipe_save", { recipe });
    const args = {
      recipeId: recipe.id,
      workspaceId: workspace.id,
      requestId: "deleted-recipe-replay",
      goalOverride: null,
    };
    const first = (await f.invoke("recipe_launch", args)) as SquadLaunch;
    f.operations.agents.finish(first.members[0]?.operationId ?? "", "succeeded", "Implementation verified.");
    await f.invoke("recipe_delete", { id: recipe.id });

    const replayed = (await f.invoke("recipe_launch", args)) as SquadLaunch;

    expect(replayed).toEqual(first);
    expect(f.starts).toEqual(["lead", "tests"]);
    expect(f.tasks).toHaveLength(1);
    await expect(
      f.invoke("squads_launch", {
        squadId: saved.id,
        workspaceId: workspace.id,
        requestId: args.requestId,
        goalOverride: null,
      }),
    ).rejects.toMatchObject({ code: "squad_launch_request_conflict" });
  });

  it("rejects secret-shaped goal overrides before persisting launch or Operation state", async () => {
    const f = setup();
    await f.invoke("squads_save", { definition: definition() });

    await expect(
      f.invoke("squads_launch", {
        squadId: definition().id,
        workspaceId: workspace.id,
        requestId: "secret-goal",
        goalOverride: "api_key = sk_test_synthetic_abcdefghijklmnopqrstuvwxyz",
      }),
    ).rejects.toMatchObject({ code: "squad_secret_detected" });

    const snapshot = (await f.invoke("squads_snapshot")) as SquadsSnapshot;
    expect(snapshot.launches).toEqual([]);
    expect(snapshot.operations).toEqual([]);
    expect(f.starts).toEqual([]);
  });

  it("pauses only an unavailable member and retries that same Operation identity", async () => {
    const unavailable = new Set(["lead"]);
    const f = setup(unavailable);
    await f.invoke("squads_save", { definition: definition({ members: [memberAt(definition(), 0)] }) });
    const launch = (await f.invoke("squads_launch", {
      squadId: definition().id,
      workspaceId: workspace.id,
      requestId: "retry-request",
      goalOverride: null,
    })) as SquadLaunch;
    const operationId = launch.members[0]?.operationId ?? "";
    expect(f.operations.agents.exact([operationId])[0]).toEqual(
      expect.objectContaining({
        status: "paused",
        currentAction: expect.stringContaining("signed out"),
        attentionReason: expect.stringContaining("signed out"),
      }),
    );

    unavailable.clear();
    // As native: Resume cannot restart a paused member; Run now does, with the same identity.
    expect(() => f.operations.handlers.operations_hold?.({ id: operationId, paused: false })).toThrow(
      expect.objectContaining({ code: "operation_squad_run_required" }),
    );
    await f.operations.handlers.operations_pause?.({ paused: true });
    await f.operations.handlers.operations_run_now?.({ id: operationId });
    await f.invoke("squads_snapshot");
    expect(f.operations.agents.exact([operationId])[0]).toEqual(
      expect.objectContaining({ status: "running", threadId: expect.any(String) }),
    );
    expect(f.operations.agents.exact([operationId])[0]?.id).toBe(operationId);
    // A started member may hold its task, so Run now never sends it again.
    expect(() => f.operations.handlers.operations_run_now?.({ id: operationId })).toThrow(
      expect.objectContaining({ code: "operation_not_pending" }),
    );
  });

  it("holds an unavailable selected account before any pane starts", async () => {
    const f = setup(new Set(), new Set(["lead"]));
    const oneMember = definition({ members: [memberAt(definition(), 0)] });
    await f.invoke("squads_save", { definition: oneMember });
    const launch = (await f.invoke("squads_launch", {
      squadId: oneMember.id,
      workspaceId: workspace.id,
      requestId: "unavailable-account",
      goalOverride: null,
    })) as SquadLaunch;
    const operation = f.operations.agents.exact([launch.members[0]?.operationId ?? ""])[0];

    expect(f.starts).toEqual([]);
    expect(operation).toEqual(
      expect.objectContaining({
        status: "blocked",
        currentAction: "Reconnect provider account",
        attentionReason: expect.stringContaining("selected provider account is unavailable"),
      }),
    );
  });

  it("reassigns hierarchy without replacing workers or their Operations", async () => {
    const f = setup();
    await f.invoke("squads_save", { definition: definition() });
    const launch = (await f.invoke("squads_launch", {
      squadId: definition().id,
      workspaceId: workspace.id,
      requestId: "manager-request",
      goalOverride: null,
    })) as SquadLaunch;
    const before = launch.members.map((member) => member.operationId);
    await expect(
      f.invoke("squads_reassign_manager", {
        launchId: launch.id,
        memberKey: "lead",
        managerKey: "tests",
      }),
    ).rejects.toMatchObject({ code: "squad_manager_cycle" });
    const reassigned = (await f.invoke("squads_reassign_manager", {
      launchId: launch.id,
      memberKey: "tests",
      managerKey: null,
    })) as SquadLaunch;
    expect(reassigned.members.find((member) => member.key === "tests")?.managerKey).toBeNull();
    expect(reassigned.members.map((member) => member.operationId)).toEqual(before);
  });

  it("applies Recipe goal precedence to the bounded task prompt", async () => {
    const f = setup();
    await f.invoke("squads_save", { definition: definition({ members: [memberAt(definition(), 0)] }) });
    await f.invoke("recipe_save", {
      recipe: {
        id: "00000000-0000-4000-8000-00000000c002",
        name: "Platform release",
        squadId: definition().id,
        goal: "Ship from the Recipe",
      },
    });
    const launch = (await f.invoke("recipe_launch", {
      recipeId: "PLATFORM RELEASE",
      workspaceId: workspace.id,
      requestId: "recipe-goal",
      goalOverride: null,
    })) as SquadLaunch;
    const operation = f.operations.agents.exact([launch.members[0]?.operationId ?? ""])[0];
    expect(launch.goal).toBe("Ship from the Recipe");
    expect(operation?.spec.prompt).toContain("Implement the platform pass");
    expect(operation?.spec.prompt).toContain("Squad goal: Ship from the Recipe");
    expect(operation?.spec.prompt).toContain("Member: lead (implementation)");
  });

  it("serializes overlapping shared-workspace ownership while isolated worktrees stay parallel", async () => {
    const f = setup();
    const base = definition();
    await f.invoke("squads_save", {
      definition: definition({
        members: [
          { ...memberAt(base, 0), worktree: false, ownedPaths: ["tooling/release/**"] },
          {
            ...memberAt(base, 1),
            task: "Review release tooling",
            worktree: false,
            dependsOn: [],
            ownedPaths: ["tooling/release/publish/**"],
          },
          {
            ...memberAt(base, 1),
            key: "review",
            name: "Release reviewer",
            task: "Review release tooling",
            worktree: false,
            dependsOn: [],
            managerKey: null,
            ownedPaths: ["tooling/release/publish/feed/**"],
          },
        ],
      }),
    });
    const launch = (await f.invoke("squads_launch", {
      squadId: definition().id,
      workspaceId: workspace.id,
      requestId: "ownership-overlap",
      goalOverride: null,
    })) as SquadLaunch;
    const operations = f.operations.agents.exact(launch.members.map((member) => member.operationId));
    expect(f.starts).toEqual(["lead", "tests", "review"]);
    expect(f.tasks).toHaveLength(1);
    expect(operations[1]).toEqual(
      expect.objectContaining({ status: "queued", threadId: expect.any(String), blockers: [operations[0]?.id] }),
    );
    expect(operations[2]).toEqual(
      expect.objectContaining({ status: "queued", threadId: expect.any(String), blockers: [operations[1]?.id] }),
    );
    expect(operations[1]?.spec.dependencies).toEqual([operations[0]?.id]);
    expect(operations[2]?.spec.dependencies).toEqual([operations[1]?.id]);

    const isolated = setup();
    const isolatedDefinition = definition({
      members: [
        { ...memberAt(base, 0), worktree: true, ownedPaths: ["tooling/release/**"] },
        {
          ...memberAt(base, 1),
          task: "Review release tooling",
          worktree: true,
          dependsOn: [],
          ownedPaths: ["tooling/release/publish/**"],
        },
      ],
    });
    await isolated.invoke("squads_save", { definition: isolatedDefinition });
    await isolated.invoke("squads_launch", {
      squadId: isolatedDefinition.id,
      workspaceId: workspace.id,
      requestId: "ownership-isolated",
      goalOverride: null,
    });
    expect(isolated.starts).toEqual(["lead", "tests"]);
    expect(isolated.operations.controls.snapshot().items.filter((item) => item.blockers.length > 0)).toHaveLength(0);
  });

  it("treats empty shared-checkout ownership as the whole workspace while preserving declared parallelism", async () => {
    const base = definition();
    const shared = setup();
    const unknownOwnership = definition({
      members: [
        { ...memberAt(base, 0), worktree: false, ownedPaths: [] },
        {
          ...memberAt(base, 1),
          task: "Validate the desktop",
          worktree: false,
          dependsOn: [],
          ownedPaths: ["apps/desktop/**"],
        },
      ],
    });
    await shared.invoke("squads_save", { definition: unknownOwnership });
    const sharedLaunch = (await shared.invoke("squads_launch", {
      squadId: unknownOwnership.id,
      workspaceId: workspace.id,
      requestId: "unknown-shared-ownership",
      goalOverride: null,
    })) as SquadLaunch;
    const sharedOperations = shared.operations.agents.exact(sharedLaunch.members.map((member) => member.operationId));
    expect(shared.starts).toEqual(["lead", "tests"]);
    expect(shared.tasks).toHaveLength(1);
    expect(sharedOperations[1]?.spec.dependencies).toEqual([sharedOperations[0]?.id]);

    const disjoint = setup();
    const disjointOwnership = definition({
      members: [
        { ...memberAt(base, 0), worktree: false, ownedPaths: ["crates/**"] },
        {
          ...memberAt(base, 1),
          task: "Validate the desktop",
          worktree: false,
          dependsOn: [],
          ownedPaths: ["apps/desktop/**"],
        },
      ],
    });
    await disjoint.invoke("squads_save", { definition: disjointOwnership });
    const disjointLaunch = (await disjoint.invoke("squads_launch", {
      squadId: disjointOwnership.id,
      workspaceId: workspace.id,
      requestId: "disjoint-shared-ownership",
      goalOverride: null,
    })) as SquadLaunch;
    const disjointOperations = disjoint.operations.agents.exact(
      disjointLaunch.members.map((member) => member.operationId),
    );
    expect(disjoint.tasks).toHaveLength(2);
    expect(disjointOperations[1]?.spec.dependencies).toEqual([]);

    const isolated = setup();
    const isolatedOwnership = definition({
      members: [
        { ...memberAt(base, 0), worktree: true, ownedPaths: [] },
        {
          ...memberAt(base, 1),
          task: "Validate the desktop",
          worktree: false,
          dependsOn: [],
          ownedPaths: [],
        },
      ],
    });
    await isolated.invoke("squads_save", { definition: isolatedOwnership });
    const isolatedLaunch = (await isolated.invoke("squads_launch", {
      squadId: isolatedOwnership.id,
      workspaceId: workspace.id,
      requestId: "isolated-unknown-ownership",
      goalOverride: null,
    })) as SquadLaunch;
    const isolatedOperations = isolated.operations.agents.exact(
      isolatedLaunch.members.map((member) => member.operationId),
    );
    expect(isolated.tasks).toHaveLength(2);
    expect(isolatedOperations[1]?.spec.dependencies).toEqual([]);
  });

  it("accepts a reusable Squad with no goal and preserves taskless launches", async () => {
    const f = setup();
    const taskless = memberAt(definition(), 0);
    const saved = (await f.invoke("squads_save", {
      definition: definition({
        goal: "",
        members: [{ ...taskless, model: "", effort: "", role: "", task: null }],
      }),
    })) as SquadDefinition;
    const launch = (await f.invoke("squads_launch", {
      squadId: saved.id,
      workspaceId: workspace.id,
      requestId: "taskless-without-goal",
      goalOverride: null,
    })) as SquadLaunch;
    const operation = f.operations.agents.exact([launch.members[0]?.operationId ?? ""])[0];

    expect(saved.goal).toBe("");
    expect(saved.members[0]).toEqual(expect.objectContaining({ model: "", effort: "", role: "" }));
    expect(launch.goal).toBe("");
    expect(operation?.spec.prompt).toBeNull();
    expect(operation).toEqual(expect.objectContaining({ status: "running", threadId: expect.any(String) }));
  });
});
