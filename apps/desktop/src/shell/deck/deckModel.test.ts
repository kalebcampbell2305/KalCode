import type { OperationEnvironment, OperationRecord, ProviderHealth } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { thread } from "../../surfaces/dashboard/data/testing.ts";
import {
  agentSections,
  ago,
  BUILD_KINDS,
  environmentTone,
  humanize,
  needsYouCount,
  primaryEnvironment,
  providerRollup,
  runningAgentCount,
  runSummary,
  SHIP_KINDS,
  shortElapsed,
} from "./deckModel.ts";

const NOW = Date.parse("2026-09-24T11:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function run(overrides: Partial<OperationRecord> & { kind?: OperationRecord["spec"]["kind"] } = {}): OperationRecord {
  const { kind = "build", ...rest } = overrides;
  return {
    id: `op-${Math.random()}`,
    spec: {
      name: `${kind} run`,
      workspaceId: "w1",
      kind,
      command: null,
      prompt: null,
      providerId: null,
      providerAccountId: null,
      model: null,
      effort: null,
      dependencies: [],
      priority: 0,
      lane: "default" as OperationRecord["spec"]["lane"],
      environment: "local",
      urls: [],
      envKeys: [],
    },
    source: "operations",
    status: "succeeded",
    workspaceName: "kalcode",
    branch: null,
    version: null,
    accountLabel: null,
    terminalId: null,
    threadId: null,
    createdAt: minutesAgo(60),
    startedAt: minutesAgo(50),
    endedAt: minutesAgo(40),
    currentAction: null,
    outcome: null,
    position: 0,
    blockers: [],
    ...rest,
  };
}

function health(overrides: Partial<ProviderHealth>): ProviderHealth {
  return {
    providerId: "claude-code",
    displayName: "Claude Code",
    state: "healthy",
    detection: "installed",
    auth: "authenticated",
    accountLabel: null,
    version: null,
    minimumVersion: null,
    models: [],
    processRunning: false,
    activeSessions: 0,
    latencyP50Ms: null,
    latencyP95Ms: null,
    latencySamples: 0,
    recentFailures: 0,
    lastFailure: null,
    capacity: "unknown" as ProviderHealth["capacity"],
    backoffUntil: null,
    trend: "steady" as ProviderHealth["trend"],
    recoverability: "none",
    reasonCode: null,
    reason: null,
    checkedAt: null,
    observedAt: minutesAgo(1),
    ...overrides,
  };
}

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

  it("puts failed agents in needs-you (like the Sidebar badge and Fleet chips), however old", () => {
    const sections = agentSections(
      [
        thread({ name: "failed-old", status: "failed", lastActivityAt: minutesAgo(120) }),
        thread({ name: "failed-new", status: "failed", lastActivityAt: minutesAgo(2) }),
        thread({ name: "reply", status: "waiting_for_user", lastActivityAt: minutesAgo(5) }),
        thread({ name: "done", status: "completed", lastActivityAt: minutesAgo(1) }),
      ],
      NOW,
    );
    expect(sections.needsYou.map((t) => t.name)).toEqual(["failed-new", "reply", "failed-old"]);
    expect(sections.finished.map((t) => t.name)).toEqual(["done"]);
    expect(needsYouCount(sections.needsYou, [])).toBe(3);
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

describe("runSummary", () => {
  it("reports a running build with the newest one as latest", () => {
    const summary = runSummary(
      [
        run({ status: "running", startedAt: minutesAgo(5), endedAt: null }),
        run({ status: "running", startedAt: minutesAgo(1), endedAt: null, spec: { ...run().spec, name: "newest" } }),
        run({ kind: "test", status: "failed" }),
      ],
      BUILD_KINDS,
    );
    expect(summary.state).toBe("running");
    expect(summary.running).toBe(2);
    expect(summary.latest?.spec.name).toBe("newest");
  });

  it("reports the newest finished outcome, and none when nothing ran", () => {
    expect(
      runSummary(
        [run({ status: "failed", endedAt: minutesAgo(2) }), run({ status: "succeeded", endedAt: minutesAgo(30) })],
        BUILD_KINDS,
      ).state,
    ).toBe("failed");
    expect(runSummary([run({ status: "succeeded" })], BUILD_KINDS).state).toBe("passed");
    expect(runSummary([run({ status: "queued", startedAt: null, endedAt: null })], BUILD_KINDS)).toMatchObject({
      state: "queued",
      queued: 1,
    });
    expect(runSummary([], SHIP_KINDS).state).toBe("none");
  });

  it("treats deploys and releases as shipping", () => {
    expect(runSummary([run({ kind: "release", status: "running", endedAt: null })], SHIP_KINDS).state).toBe("running");
  });
});

describe("providerRollup", () => {
  it("ignores providers that aren't installed", () => {
    const rollup = providerRollup([
      health({}),
      health({ providerId: "gemini-cli", displayName: "Gemini CLI", detection: "not_installed", state: "unavailable" }),
    ]);
    expect(rollup).toMatchObject({ tone: "working", label: "1 healthy", installed: 1 });
  });

  it("names the single worst provider, or counts several", () => {
    expect(
      providerRollup([health({}), health({ providerId: "codex", displayName: "Codex", state: "degraded" })]),
    ).toMatchObject({ tone: "waiting", label: "Codex degraded" });
    expect(
      providerRollup([
        health({ state: "unavailable" }),
        health({ providerId: "codex", displayName: "Codex", state: "unavailable" }),
      ]),
    ).toMatchObject({ tone: "failed", label: "2 unavailable" });
  });

  it("is honest before any check", () => {
    expect(providerRollup(null).label).toBe("Checking");
    expect(providerRollup([]).label).toBe("None installed");
    expect(providerRollup([health({ state: "unknown" })]).label).toBe("Not checked yet");
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
