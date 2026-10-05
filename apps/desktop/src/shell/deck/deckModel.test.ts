import type { OperationEnvironment } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { thread } from "../../surfaces/dashboard/data/testing.ts";
import {
  agentSections,
  ago,
  environmentTone,
  humanize,
  needsChipTarget,
  needsYouCount,
  primaryEnvironment,
  runningAgentCount,
  shortElapsed,
} from "./deckModel.ts";

const NOW = Date.parse("2026-09-24T11:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function env(overrides: Partial<OperationEnvironment>): OperationEnvironment {
  return {
    workspaceId: "w1",
    kind: "local",
    branch: null,
    version: null,
    urls: [],
    deploymentStatus: "not_detected",
    health: "not_probed",
    platform: null,
    lastDeploy: null,
    runId: null,
    variables: [],
    observedAt: minutesAgo(1),
    notes: [],
    ...overrides,
  };
}

describe("agentSections", () => {
  it("groups open agents by what they need and keeps only recent finishes", () => {
    const sections = agentSections(
      [
        thread({ name: "approve", status: "waiting_for_permission", lastActivityAt: minutesAgo(3) }),
        thread({ name: "reply", status: "waiting_for_user", lastActivityAt: minutesAgo(1) }),
        thread({ name: "work", status: "editing", lastActivityAt: minutesAgo(2) }),
        thread({ name: "blocked", status: "waiting_for_dependency" }),
        thread({ name: "idle", status: "idle" }),
        thread({ name: "done-recent", status: "completed", lastActivityAt: minutesAgo(10) }),
        thread({ name: "done-old", status: "completed", lastActivityAt: minutesAgo(120) }),
        thread({ name: "archived", status: "editing", archivedAt: minutesAgo(5) }),
      ],
      NOW,
    );
    expect(sections.needsYou.map((t) => t.name)).toEqual(["reply", "approve"]);
    expect(sections.working.map((t) => t.name)).toEqual(["work"]);
    expect(sections.blocked.map((t) => t.name)).toEqual(["blocked"]);
    expect(sections.idle.map((t) => t.name)).toEqual(["idle"]);
    expect(sections.finished.map((t) => t.name)).toEqual(["done-recent"]);
    expect(runningAgentCount(sections)).toBe(4);
  });

  it("keeps failed agents out of needs-you (like the Fleet's Failed group and the Sidebar badge)", () => {
    const sections = agentSections(
      [
        thread({ name: "failed-old", status: "failed", lastActivityAt: minutesAgo(120) }),
        thread({ name: "failed-new", status: "failed", lastActivityAt: minutesAgo(2) }),
        thread({ name: "reply", status: "waiting_for_user", lastActivityAt: minutesAgo(5) }),
        thread({ name: "done", status: "completed", lastActivityAt: minutesAgo(1) }),
      ],
      NOW,
    );
    expect(sections.needsYou.map((t) => t.name)).toEqual(["reply"]);
    expect(sections.failed.map((t) => t.name)).toEqual(["failed-new", "failed-old"]);
    // Failures have their own section (the shared FAILED state); just finished is done/stopped.
    expect(sections.finished.map((t) => t.name)).toEqual(["done"]);
    expect(needsYouCount(sections.needsYou, [])).toBe(1);
    // Failed agents have stopped: they aren't running.
    expect(runningAgentCount(sections)).toBe(1);
  });

  it("counts 4 need you, not 125, beside 121 old failures (the top bar's number)", () => {
    const old = Array.from({ length: 121 }, (_, i) =>
      thread({ name: `failed-${i}`, status: "failed", lastActivityAt: minutesAgo(600 + i) }),
    );
    const waiting = [
      thread({ name: "a", status: "waiting_for_permission" }),
      thread({ name: "b", status: "waiting_for_permission" }),
      thread({ name: "c", status: "waiting_for_user" }),
      thread({ name: "d", status: "waiting_for_user" }),
    ];
    const sections = agentSections([...old, ...waiting], NOW);
    expect(needsYouCount(sections.needsYou, [])).toBe(4);
    expect(sections.failed).toHaveLength(121);
    expect(sections.finished).toEqual([]);
  });

  it("is empty for no threads", () => {
    const sections = agentSections([], NOW);
    expect(runningAgentCount(sections)).toBe(0);
    expect(sections.finished).toEqual([]);
  });
});

describe("needsYouCount", () => {
  it("counts each waiting agent once, plus approvals no waiting agent accounts for", () => {
    const waiting = thread({ status: "waiting_for_permission" });
    const count = needsYouCount(
      [waiting],
      [{ action: { threadId: waiting.id } }, { action: { threadId: "other" } }, { action: { threadId: null } }],
    );
    expect(count).toBe(3);
  });
});

describe("needsChipTarget", () => {
  it("opens Approvals only when every need is an approval", () => {
    expect(needsChipTarget(2, 2)).toBe("approvals");
    // Busy: 2 approvals plus a reply and a failure. Approvals would show only 2 of 4.
    expect(needsChipTarget(4, 2)).toBe("agents");
    expect(needsChipTarget(1, 0)).toBe("agents");
    expect(needsChipTarget(0, 0)).toBe("dashboard");
  });
});

describe("environments", () => {
  it("picks the furthest-promoted environment of the workspace", () => {
    const environments = [
      env({ kind: "local" }),
      env({ kind: "production", workspaceId: "w2" }),
      env({ kind: "preview" }),
    ];
    expect(primaryEnvironment(environments, "w1")?.kind).toBe("preview");
    expect(primaryEnvironment(environments, "w3")).toBeNull();
  });

  it("only calls an environment healthy or failed when that was observed", () => {
    expect(environmentTone(env({ health: "healthy" }))).toBe("working");
    expect(environmentTone(env({ deploymentStatus: "failed" }))).toBe("failed");
    expect(environmentTone(env({ deploymentStatus: "deployed_unverified" }))).toBe("muted");
    expect(humanize("deployed_unverified")).toBe("Deployed unverified");
  });
});

describe("time", () => {
  it("formats compact elapsed and relative times", () => {
    expect(shortElapsed(30_000)).toBe("now");
    expect(shortElapsed(4 * 60_000)).toBe("4m");
    expect(shortElapsed(3 * 3_600_000)).toBe("3h");
    expect(shortElapsed(50 * 3_600_000)).toBe("2d");
    expect(ago(minutesAgo(0), NOW)).toBe("just now");
    expect(ago(minutesAgo(40), NOW)).toBe("40m ago");
    expect(ago(null, NOW)).toBe("");
  });
});
