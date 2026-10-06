import type { SquadDefinition, SquadsSnapshot, ThreadSummary, Workspace } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { ORION_FIXTURE } from "./memory/squads.ts";
import { createMemoryTransport } from "./memoryTransport.ts";

describe("Squads memory transport integration", () => {
  it("renders Orion from canonical mixed-provider pane and Operation records", async () => {
    const transport = createMemoryTransport("account-ready-max", { detectDelayMs: 0 });
    const snapshot = await transport.invoke<SquadsSnapshot>("squads_snapshot", {});
    const launch = snapshot.launches.find((candidate) => candidate.id === ORION_FIXTURE.launchId);
    expect(snapshot.squads).toContainEqual(
      expect.objectContaining({ id: ORION_FIXTURE.squadId, name: "Orion Release Crew" }),
    );
    expect(snapshot.recipes).toContainEqual(expect.objectContaining({ id: ORION_FIXTURE.recipeId }));
    expect(launch?.members.map((member) => member.operationId)).toEqual([
      ORION_FIXTURE.operations.lead,
      ORION_FIXTURE.operations.tests,
      ORION_FIXTURE.operations.review,
    ]);

    const operations = new Map(snapshot.operations.map((operation) => [operation.id, operation] as const));
    expect(operations.get(ORION_FIXTURE.operations.lead)).toEqual(
      expect.objectContaining({ status: "running", threadId: expect.any(String), source: "operations" }),
    );
    expect(operations.get(ORION_FIXTURE.operations.tests)).toEqual(
      expect.objectContaining({
        status: "running",
        threadId: expect.any(String),
        attentionReason: "Review the updater recovery test decision.",
      }),
    );
    expect(operations.get(ORION_FIXTURE.operations.review)).toEqual(
      expect.objectContaining({ status: "succeeded", threadId: expect.any(String), endedAt: expect.any(String) }),
    );

    const threads = (await transport.invoke("thread_list", {
      workspaceId: null,
      includeArchived: false,
    })) as ThreadSummary[];
    const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
    const memberThreads = launch?.members.map((member) => byId.get(operations.get(member.operationId)?.threadId ?? ""));
    expect(memberThreads?.map((thread) => thread?.providerId)).toEqual(["codex", "claude-code", "codex"]);
    expect(memberThreads?.every((thread) => thread?.runtimeKind === "interactive_pty")).toBe(true);
    expect(memberThreads?.map((thread) => thread?.status)).toEqual(["active", "waiting_for_user", "completed"]);
  });

  it("starts a taskless Squad member as a real READY provider pane without injecting work", async () => {
    const transport = createMemoryTransport("account-ready-max", { detectDelayMs: 0 });
    const definition: SquadDefinition = {
      id: "00000000-0000-4000-8000-00000000d001",
      name: "Ready reviewer",
      goal: "Open a review terminal",
      members: [
        {
          key: "review",
          name: "Review terminal",
          providerId: "claude-code",
          providerAccountId: "0192f3c4-0000-7000-8000-000000000101",
          model: "sonnet",
          effort: "high",
          role: "review",
          task: null,
          worktree: false,
          dependsOn: [],
          managerKey: null,
          ownedPaths: [],
        },
      ],
    };
    await transport.invoke("squads_save", { definition });
    const workspace = ((await transport.invoke("workspace_list", {})) as Workspace[]).find(
      (candidate) => candidate.available,
    );
    const launch = await transport.invoke<{ members: Array<{ operationId: string }> }>("squads_launch", {
      squadId: "READY REVIEWER",
      workspaceId: workspace?.id,
      requestId: "taskless-ready-pane",
      goalOverride: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const snapshot = await transport.invoke<SquadsSnapshot>("squads_snapshot", {});
    const operation = snapshot.operations.find((candidate) => candidate.id === launch.members[0]?.operationId);
    const thread = (await transport.invoke("thread_get", { threadId: operation?.threadId })) as ThreadSummary;
    expect(operation).toEqual(
      expect.objectContaining({ status: "running", threadId: expect.any(String), currentAction: "Agent is ready" }),
    );
    expect(operation?.spec.prompt).toBeNull();
    expect(thread).toEqual(
      expect.objectContaining({ runtimeKind: "interactive_pty", status: "idle", currentActivity: "Ready for a task" }),
    );
  });
});
