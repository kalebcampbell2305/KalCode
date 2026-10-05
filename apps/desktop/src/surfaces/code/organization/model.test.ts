import type {
  DevelopmentService,
  OperationRecord,
  OperationsSnapshot,
  PaneInfo,
  ShellOption,
  TerminalInfo,
  ThreadStatus,
  ThreadSummary,
} from "@kalcode/protocol";
import { READY_ACTIVITY } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "../../../ipc/utilities.ts";
import {
  agentBadge,
  agentDisplayName,
  BADGES,
  DEFAULT_PREFS,
  happening,
  isCustomTerminalTitle,
  numberRepeats,
  type OrgItem,
  organize,
  scanTerminals,
  serviceSide,
  terminalBadge,
  terminalPurpose,
} from "./model.ts";

const terminal = (overrides: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: "t1",
  workspaceId: "ws",
  shellId: "pwsh",
  title: "PowerShell 7",
  position: 0,
  status: "running",
  startedAt: "2026-10-04T06:00:00Z",
  endedAt: null,
  exitCode: null,
  ...overrides,
});

const proc = (overrides: Partial<ProcessInfo>): ProcessInfo =>
  ({
    pid: 1,
    parentPid: null,
    name: "pwsh.exe",
    startTime: "2026-10-04T06:00:00Z",
    cpuPercent: 0,
    memoryBytes: 0,
    owner: "kalcode",
    role: null,
    label: "",
    workspaceId: "ws",
    workspaceName: "ws",
    terminalId: "t1",
    terminalGeneration: null,
    ports: [],
    ...overrides,
  }) as unknown as ProcessInfo;

const record = (
  overrides: Partial<OperationRecord> & { kind?: OperationRecord["spec"]["kind"] } = {},
): OperationRecord => {
  const { kind = "test", ...rest } = overrides;
  return {
    id: "op1",
    spec: { name: "Unit tests", workspaceId: "ws", kind, command: "pnpm test" } as OperationRecord["spec"],
    source: "operations",
    status: "running",
    workspaceName: "ws",
    branch: null,
    version: null,
    accountLabel: null,
    terminalId: null,
    threadId: null,
    createdAt: "2026-10-04T06:00:00Z",
    startedAt: "2026-10-04T06:00:01Z",
    endedAt: null,
    currentAction: null,
    outcome: null,
    position: 0,
    blockers: [],
    ...rest,
  };
};

const service = (overrides: Partial<DevelopmentService> = {}): DevelopmentService => ({
  id: "s1",
  runId: null,
  name: "vite dev server",
  status: "running",
  pid: 10,
  processName: "node.exe",
  uptimeSeconds: 30,
  ports: [3000],
  urls: ["http://localhost:3000/"],
  workspaceId: "ws",
  workspaceName: "ws",
  terminalId: "t1",
  canStop: true,
  canRestart: true,
  actionReason: null,
  ...overrides,
});

const snapshot = (items: OperationRecord[] = [], services: DevelopmentService[] = []): OperationsSnapshot => ({
  revision: 1,
  paused: false,
  items,
  services,
  environments: [],
  activity: [],
  observedAt: "2026-10-04T06:00:00Z",
  warnings: [],
});

const thread = (status: ThreadStatus, overrides: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({
    id: "a1",
    name: "New agent",
    providerId: "claude-code",
    providerName: "Claude Code",
    status,
    pendingApprovals: 0,
    currentActivity: null,
    createdAt: "2026-10-04T06:00:00Z",
    archivedAt: null,
    ...overrides,
  }) as unknown as ThreadSummary;

const info = (overrides: Partial<PaneInfo> = {}): PaneInfo => ({
  threadId: "a1",
  providerId: "claude-code",
  instanceId: "i1",
  hookChannel: "active",
  decisionRouting: "provider" as PaneInfo["decisionRouting"],
  kalcodeAnswersApprovals: false,
  running: true,
  exitCode: null,
  ...overrides,
});

describe("terminalBadge", () => {
  const shell = proc({ pid: 1, terminalGeneration: 1 });

  it("says Done or Failed only from the shell's exit code", () => {
    expect(terminalBadge(terminal({ status: "exited", exitCode: 0 }), null, null)?.badge).toBe("done");
    expect(terminalBadge(terminal({ status: "exited", exitCode: 2 }), null, null)).toEqual({
      badge: "failed",
      detail: "Exit code 2",
    });
    expect(terminalBadge(terminal({ status: "exited", exitCode: null }), null, null)?.badge).toBe("idle");
    expect(terminalBadge(terminal({ status: "ended_by_app" }), null, null)?.badge).toBe("idle");
  });

  it("has no badge for a running terminal without a process scan", () => {
    expect(terminalBadge(terminal(), null, snapshot())).toBeNull();
  });

  it("reads Starting, Working and Ready from the process tree", () => {
    const scan = (processes: ProcessInfo[]) => scanTerminals([terminal()], processes)?.get("t1");
    expect(terminalBadge(terminal(), scan([]), snapshot())?.badge).toBe("starting");
    expect(terminalBadge(terminal(), scan([shell]), snapshot())).toEqual({ badge: "ready", detail: "At its prompt" });
    expect(
      terminalBadge(terminal(), scan([shell, proc({ pid: 2, parentPid: 1, name: "node.exe" })]), snapshot()),
    ).toEqual({ badge: "working", detail: "Running node" });
    // The console host is not work.
    expect(
      terminalBadge(terminal(), scan([shell, proc({ pid: 3, parentPid: 1, name: "conhost.exe" })]), snapshot())?.badge,
    ).toBe("ready");
  });

  it("has no badge for a terminal started after the scan was sampled", () => {
    const sampledAt = Date.parse("2026-10-04T06:00:00Z");
    const scan = scanTerminals([terminal({ startedAt: "2026-10-04T06:00:05Z" })], [], sampledAt);
    expect(scan?.get("t1")).toBeUndefined();
    expect(terminalBadge(terminal(), scan?.get("t1"), snapshot())).toBeNull();
    // One started before the sample and missing from it really is still starting.
    const earlier = scanTerminals([terminal({ startedAt: "2026-10-04T05:59:59Z" })], [], sampledAt);
    expect(terminalBadge(terminal(), earlier?.get("t1"), snapshot())?.badge).toBe("starting");
  });

  it("is Testing while an Operations test run is attached, and Ready while it serves", () => {
    const scan = scanTerminals([terminal()], [shell])?.get("t1");
    expect(terminalBadge(terminal(), scan, snapshot([record({ terminalId: "t1" })]))?.badge).toBe("testing");
    // The terminal's own session mirror is not a run.
    expect(terminalBadge(terminal(), scan, snapshot([record({ terminalId: "t1", source: "terminal" })]))?.badge).toBe(
      "ready",
    );
    expect(terminalBadge(terminal(), scan, snapshot([], [service()]))).toEqual({
      badge: "ready",
      detail: "Serving localhost:3000",
    });
  });
});

describe("agentBadge", () => {
  it("says Done and Failed only from the thread status", () => {
    expect(agentBadge(thread("completed"), info()).badge).toBe("done");
    expect(agentBadge(thread("failed"), info()).badge).toBe("failed");
    // An ended CLI with a failing exit code is not a failed run.
    expect(agentBadge(thread("active"), info({ running: false, exitCode: 1 }))).toEqual({
      badge: "idle",
      detail: "Ended (exit 1)",
    });
  });

  it("marks approvals and replies as Needs you before anything else", () => {
    expect(agentBadge(thread("active", { pendingApprovals: 1 }), info()).badge).toBe("needs_you");
    expect(agentBadge(thread("waiting_for_permission"), info()).badge).toBe("needs_you");
    expect(agentBadge(thread("waiting_for_user"), info()).badge).toBe("needs_you");
    expect(BADGES.needs_you.label).toBe("Needs you");
  });

  it("never shows an agent whose process hasn't started as Idle", () => {
    // Launching: no process yet, no exit.
    expect(agentBadge(thread("starting"), info({ running: false, exitCode: null }))).toEqual({
      badge: "starting",
      detail: "Starting",
    });
    // Held by genuine hard pressure: Waiting, with the runtime's real reason (never "CPU busy").
    const held = thread("waiting_for_dependency", {
      currentActivity: "Waiting to start: memory is critically low (412 MB free)",
      error: { code: "waiting_for_resources", message: "Memory is critically low (412 MB free)." },
    });
    expect(agentBadge(held, info({ running: false, exitCode: null }))).toEqual({
      badge: "waiting",
      detail: "Memory is critically low (412 MB free)",
    });
    expect(agentBadge(held, null).badge).toBe("waiting");
    expect(BADGES.waiting.label).toBe("Waiting");
    // Waiting on another task: Waiting too, never Idle.
    expect(agentBadge(thread("waiting_for_dependency"), info({ running: false, exitCode: null }))).toEqual({
      badge: "waiting",
      detail: "Waiting on another task",
    });
  });

  it("maps live statuses", () => {
    expect(agentBadge(thread("active"), null).badge).toBe("starting");
    expect(agentBadge(thread("starting"), info()).badge).toBe("starting");
    expect(agentBadge(thread("running_command", { currentActivity: "Running npm test" }), info())).toEqual({
      badge: "working",
      detail: "Running npm test",
    });
    expect(agentBadge(thread("testing"), info()).badge).toBe("testing");
    expect(agentBadge(thread("idle", { currentActivity: READY_ACTIVITY }), info()).badge).toBe("ready");
    expect(agentBadge(thread("idle"), info()).badge).toBe("idle");
    expect(agentBadge(thread("paused"), info()).badge).toBe("idle");
    expect(agentBadge(thread("interrupted"), info()).badge).toBe("stopped");
    expect(agentBadge(thread("completed"), null).badge).toBe("done");
  });
});

describe("names and purposes", () => {
  const shells: ShellOption[] = [{ id: "pwsh", name: "PowerShell 7", isDefault: true }];

  it("treats a title other than the shell's name as the person's own", () => {
    expect(isCustomTerminalTitle(terminal(), shells)).toBe(false);
    expect(isCustomTerminalTitle(terminal({ title: "Logs" }), shells)).toBe(true);
    expect(isCustomTerminalTitle(terminal({ shellId: "operation:x", title: "Unit tests" }), shells)).toBe(false);
  });

  it("names a terminal by the run or service it hosts", () => {
    expect(terminalPurpose(terminal(), snapshot())).toEqual({ name: null, group: "Terminals" });
    expect(terminalPurpose(terminal(), snapshot([record({ terminalId: "t1", status: "succeeded" })]))).toEqual({
      name: "Tests",
      group: "Tests",
    });
    expect(terminalPurpose(terminal(), snapshot([record({ terminalId: "t1", kind: "deploy" })])).name).toBe("Release");
    expect(terminalPurpose(terminal(), snapshot([], [service()]))).toEqual({ name: "Frontend", group: "Frontend" });
    expect(terminalPurpose(terminal(), snapshot([], [service({ name: "api server" })])).group).toBe("Backend");
    expect(terminalPurpose(terminal(), snapshot([], [service({ name: "redis", processName: "redis" })]))).toEqual({
      name: "redis",
      group: "Terminals",
    });
  });

  it("reads a side from what a service calls itself", () => {
    expect(serviceSide("next dev")).toBe("Frontend");
    expect(serviceSide("wrangler dev")).toBe("Backend");
    expect(serviceSide("postgres")).toBeNull();
  });

  it("shows the persisted task or manual name without inventing a call sign", () => {
    expect(agentDisplayName(thread("idle", { name: "Fix Dashboard Layout" }))).toBe("Fix Dashboard Layout");
    expect(agentDisplayName(thread("idle", { name: "My Manual Name" }))).toBe("My Manual Name");
    expect(agentDisplayName(thread("idle", { name: "New agent", providerName: "Claude Code" }))).toBe("New agent");
    expect(agentDisplayName(thread("idle", { name: "", providerName: "Codex" }))).toBe("Codex");
  });

  it("numbers repeated names", () => {
    const named = numberRepeats([
      ["a", "Tests"],
      ["b", "Frontend"],
      ["c", "Tests"],
    ]);
    expect([...named.values()]).toEqual(["Tests", "Frontend", "Tests (2)"]);
  });
});

const item = (key: string, badge: OrgItem["status"], group: OrgItem["group"] = "Terminals"): OrgItem => ({
  key,
  content: { kind: "terminal", terminalId: key },
  kind: "terminal",
  title: key,
  status: badge,
  group,
  glyph: "shell",
  order: key,
});
const b = (badge: NonNullable<OrgItem["status"]>["badge"]) => ({ badge, detail: "" });

describe("organize", () => {
  it("keeps active work visible, marks needs-you first, and collapses finished work", () => {
    const [group] = organize(
      [
        item("a", b("done")),
        item("b", b("working")),
        item("c", b("needs_you")),
        item("d", b("ready")),
        item("e", null),
      ],
      DEFAULT_PREFS,
      null,
    );
    expect(group?.active.map((i) => i.key)).toEqual(["c", "b", "d", "e"]);
    expect(group?.finished.map((i) => i.key)).toEqual(["a"]);
  });

  it("never collapses pinned or focused work, and never drops anything", () => {
    const items = [item("a", b("done")), item("b", b("idle")), item("c", b("done"))];
    const [group] = organize(items, { ...DEFAULT_PREFS, pinned: ["a"] }, "b");
    expect(group?.active.map((i) => i.key)).toEqual(["a", "b"]);
    expect(group?.finished.map((i) => i.key)).toEqual(["c"]);
    expect((group?.active.length ?? 0) + (group?.finished.length ?? 0)).toBe(items.length);
  });

  it("groups by purpose, honors moves and custom groups, and remembers collapse", () => {
    const groups = organize(
      [item("a", b("working"), "Frontend"), item("b", b("ready"), "Tests"), item("c", b("ready"))],
      { ...DEFAULT_PREFS, groupOf: { c: "Docs" }, customGroups: ["Docs", "Empty"], collapsedGroups: ["Tests"] },
      null,
    );
    expect(groups.map((g) => [g.name, g.collapsed, g.active.map((i) => i.key)])).toEqual([
      ["Frontend", false, ["a"]],
      ["Tests", true, ["b"]],
      ["Docs", false, ["c"]],
      ["Empty", false, []],
    ]);
  });

  it("shows one stack without grouping", () => {
    const groups = organize(
      [item("a", b("working"), "Frontend"), item("b", b("ready"))],
      { ...DEFAULT_PREFS, grouping: false },
      null,
    );
    expect(groups.map((g) => g.name)).toEqual(["All"]);
    expect(groups[0]?.active).toHaveLength(2);
  });
});

describe("happening", () => {
  const agents = [item("a", b("working")), item("b", b("testing")), item("c", b("ready"))];

  it("says only what it observed", () => {
    expect(happening({ agents: [], needsYou: 0, operations: null, git: null })).toEqual([]);
    const segments = happening({
      agents,
      needsYou: 1,
      operations: snapshot([record({ status: "succeeded" })], [service()]),
      git: { branch: "main", changed: 0, untracked: 0 },
    });
    expect(segments.map((s) => s.text)).toEqual([
      "2 agents working",
      "1 needs you",
      "tests passing",
      "localhost:3000",
      "main clean",
    ]);
  });

  it("reports the newest test run, live services only, and changed files", () => {
    const segments = happening({
      agents: [],
      needsYou: 0,
      operations: snapshot(
        [
          record({ id: "old", status: "succeeded", startedAt: "2026-10-04T05:00:00Z" }),
          record({ id: "new", status: "failed", startedAt: "2026-10-04T06:30:00Z" }),
        ],
        [service({ status: "stopped" }), service({ id: "s2", urls: [], ports: [8787] }), service({ id: "s3" })],
      ),
      git: { branch: "feat/x", changed: 2, untracked: 1 },
    });
    expect(segments.map((s) => s.text)).toEqual(["tests failing", "localhost:8787 +1", "feat/x · 3 changed"]);
  });

  it("says a queued test run is queued, and leaves out states it has no words for", () => {
    const queued = happening({
      agents: [],
      needsYou: 0,
      operations: snapshot([record({ status: "queued" })]),
      git: null,
    });
    expect(queued.map((s) => s.text)).toEqual(["tests queued"]);
    const cancelled = happening({
      agents: [],
      needsYou: 0,
      operations: snapshot([record({ status: "cancelled" })]),
      git: null,
    });
    expect(cancelled).toEqual([]);
  });
});
