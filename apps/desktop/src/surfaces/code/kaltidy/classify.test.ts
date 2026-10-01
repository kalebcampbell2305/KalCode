import type { DevelopmentService, OperationRecord } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "../../../ipc/utilities.ts";
import type { TerminalActivity } from "./activity.ts";
import {
  ACTIVE_OUTPUT_MS,
  classifyTerminals,
  formatAgo,
  PROCESS_SCAN_LIMIT,
  QUIET_MS,
  type TidyInputs,
  type TidyTerminal,
} from "./classify.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const LONG_AGO = new Date(NOW - 60 * 60_000).toISOString();

function terminal(id: string, patch: Partial<TidyTerminal> = {}): TidyTerminal {
  return {
    id,
    workspaceId: "w1",
    shellId: "pwsh",
    title: "PowerShell 7",
    position: 0,
    status: "running",
    startedAt: LONG_AGO,
    endedAt: null,
    exitCode: null,
    label: "PowerShell 7",
    workspaceName: "site",
    ...patch,
  };
}

let nextPid = 100;
function proc(terminalId: string | null, patch: Partial<ProcessInfo> = {}): ProcessInfo {
  nextPid += 1;
  return {
    pid: nextPid,
    parentPid: null,
    name: "node.exe",
    startTime: "1",
    cpuPercent: 0,
    memoryBytes: 1,
    owner: "kal_code_child",
    role: null,
    label: "",
    workspaceId: "w1",
    workspaceName: "site",
    terminalId,
    terminalGeneration: null,
    ports: [],
    killable: { kind: "confirm" },
    canRestart: false,
    ...patch,
  };
}

/** A terminal's shell at its prompt. */
function shell(terminalId: string, patch: Partial<ProcessInfo> = {}): ProcessInfo {
  return proc(terminalId, { name: "pwsh.exe", terminalGeneration: 1, canRestart: true, ...patch });
}

function child(parent: ProcessInfo, patch: Partial<ProcessInfo> = {}): ProcessInfo {
  return proc(parent.terminalId, { parentPid: parent.pid, ...patch });
}

function operation(terminalId: string, patch: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "op1",
    spec: {
      name: "web",
      workspaceId: "w1",
      kind: "deploy",
      command: null,
      prompt: null,
      providerId: null,
      providerAccountId: null,
      model: null,
      effort: null,
      dependencies: [],
      priority: 0,
      lane: "default" as OperationRecord["spec"]["lane"],
      environment: "local" as OperationRecord["spec"]["environment"],
      urls: [],
      envKeys: [],
    },
    source: "operations",
    status: "running",
    workspaceName: "site",
    branch: null,
    version: null,
    accountLabel: null,
    terminalId,
    threadId: null,
    createdAt: LONG_AGO,
    startedAt: LONG_AGO,
    endedAt: null,
    currentAction: null,
    outcome: null,
    position: 0,
    blockers: [],
    ...patch,
  };
}

function service(terminalId: string, patch: Partial<DevelopmentService> = {}): DevelopmentService {
  return {
    id: "s1",
    runId: null,
    name: "vite dev server",
    status: "running",
    pid: 1,
    processName: "node.exe",
    uptimeSeconds: 10,
    ports: [5173],
    urls: [],
    workspaceId: "w1",
    workspaceName: "site",
    terminalId,
    canStop: true,
    canRestart: true,
    actionReason: null,
    ...patch,
  };
}

const NO_ACTIVITY: TerminalActivity = { lastOutputAt: null, lastInputAt: null, unsent: false };

function classify(patch: Partial<TidyInputs> & Pick<TidyInputs, "terminals">) {
  return classifyTerminals({
    processes: [],
    operations: { items: [], services: [] },
    activity: () => NO_ACTIVITY,
    focusedTerminalId: null,
    now: NOW,
    ...patch,
  });
}

function only(patch: Partial<TidyInputs> & Pick<TidyInputs, "terminals">) {
  const scan = classify(patch);
  expect(scan.entries).toHaveLength(1);
  return scan.entries[0];
}

describe("KalTidy classifier", () => {
  it("rule 11: a shell at its prompt, nothing typed, quiet past the threshold, is idle", () => {
    const t = terminal("t1");
    const entry = only({ terminals: [t], processes: [shell("t1")] });
    expect(entry?.cls).toBe("idle");
    expect(entry?.reason).toBe("At its prompt, quiet for 1 h");
  });

  it("rule 1: a failed process scan keeps every terminal and says why", () => {
    const scan = classify({
      terminals: [terminal("t1"), terminal("t2", { status: "exited", endedAt: LONG_AGO })],
      processes: null,
      processError: "the Utility Dock isn't ready",
    });
    expect(scan.blocked).toContain("the Utility Dock isn't ready");
    expect(scan.entries.map((e) => e.cls)).toEqual(["protected", "protected"]);
  });

  it("rule 1: a failed Operations snapshot keeps every terminal", () => {
    const scan = classify({ terminals: [terminal("t1")], processes: [shell("t1")], operations: null });
    expect(scan.blocked).toContain("Operations didn't answer");
    expect(scan.entries[0]?.cls).toBe("protected");
  });

  it("rule 1: a process scan at its row limit may be missing rows, so nothing is idle", () => {
    const rows = Array.from({ length: PROCESS_SCAN_LIMIT }, () => proc(null));
    const scan = classify({ terminals: [terminal("t1")], processes: [shell("t1"), ...rows] });
    expect(scan.blocked).toContain("cut short");
    expect(scan.entries[0]?.cls).toBe("protected");
  });

  it("rule 2: the terminal the person is focused on is protected", () => {
    const entry = only({ terminals: [terminal("t1")], processes: [shell("t1")], focusedTerminalId: "t1" });
    expect(entry).toMatchObject({ cls: "protected", reason: "You're working in it" });
  });

  it("rule 3: an unfinished deploy, release, build or test run protects its terminal", () => {
    for (const status of ["queued", "starting", "running", "paused", "blocked", "unknown"] as const) {
      const entry = only({
        terminals: [terminal("t1")],
        processes: [shell("t1")],
        operations: { items: [operation("t1", { status })], services: [] },
      });
      expect(entry?.cls).toBe("protected");
    }
    const release = only({
      terminals: [terminal("t1")],
      processes: [shell("t1")],
      operations: {
        items: [operation("t1", { spec: { ...operation("t1").spec, kind: "release", name: "0.1.8" } })],
        services: [],
      },
    });
    expect(release?.reason).toBe("Release “0.1.8” is running");
  });

  it("rule 3: Operations' mirror of the terminal session itself is not a run", () => {
    // Operations lists every terminal as an observed "script" (source terminal), running while
    // the terminal is open; it says nothing about what runs in it.
    const entry = only({
      terminals: [terminal("t1")],
      processes: [shell("t1")],
      operations: {
        items: [
          operation("t1", {
            id: "terminal:t1",
            source: "terminal",
            spec: { ...operation("t1").spec, kind: "script", name: "PowerShell 7" },
          }),
        ],
        services: [],
      },
    });
    expect(entry?.cls).toBe("idle");
  });

  it("rule 3: a finished run doesn't keep its terminal", () => {
    const entry = only({
      terminals: [terminal("t1")],
      processes: [shell("t1")],
      operations: { items: [operation("t1", { status: "succeeded" })], services: [] },
    });
    expect(entry?.cls).toBe("idle");
  });

  it("rule 4: an agent CLI running in the terminal protects it", () => {
    const root = shell("t1");
    const entry = only({ terminals: [terminal("t1")], processes: [root, child(root, { name: "claude.exe" })] });
    expect(entry).toMatchObject({ cls: "protected", reason: "Claude Code agent is running" });
  });

  it("rule 5: an ended shell is idle once quiet, active just after it ended", () => {
    const ended = only({
      terminals: [terminal("t1", { status: "exited", exitCode: 1, endedAt: LONG_AGO })],
      processes: [],
    });
    expect(ended).toMatchObject({ cls: "idle", reason: "Shell ended (exit code 1) 1 h ago" });
    const fresh = only({
      terminals: [terminal("t1", { status: "ended_by_app", endedAt: new Date(NOW - 10_000).toISOString() })],
      processes: [],
    });
    expect(fresh?.cls).toBe("active");
  });

  it("rule 6: a running terminal whose shell isn't in the scan is protected", () => {
    const entry = only({ terminals: [terminal("t1")], processes: [] });
    expect(entry?.cls).toBe("protected");
  });

  it("rule 7: a development service makes its terminal background", () => {
    const root = shell("t1");
    const entry = only({
      terminals: [terminal("t1")],
      processes: [root, child(root)],
      operations: { items: [], services: [service("t1")] },
    });
    expect(entry).toMatchObject({ cls: "background", reason: "Running vite dev server on :5173" });
  });

  it("rule 7: a process listening on a port makes its terminal background", () => {
    const root = shell("t1");
    const entry = only({ terminals: [terminal("t1")], processes: [root, child(root, { ports: [3000] })] });
    expect(entry).toMatchObject({ cls: "background", reason: "node.exe listening on :3000" });
  });

  it("rule 8: a program using CPU or printing is active", () => {
    const root = shell("t1");
    const busy = only({
      terminals: [terminal("t1")],
      processes: [root, child(root, { name: "cargo.exe", cpuPercent: 12 })],
    });
    expect(busy).toMatchObject({ cls: "active", reason: "Running cargo.exe (12.0% CPU)" });
    const printing = only({
      terminals: [terminal("t1")],
      processes: [root, child(root, { name: "ping.exe" })],
      activity: () => ({ ...NO_ACTIVITY, lastOutputAt: NOW - ACTIVE_OUTPUT_MS / 2 }),
    });
    expect(printing?.cls).toBe("active");
  });

  it("rule 8: a quiet program is waiting (likely for input)", () => {
    const root = shell("t1");
    const entry = only({ terminals: [terminal("t1")], processes: [root, child(root, { name: "python.exe" })] });
    expect(entry?.cls).toBe("waiting");
    expect(entry?.reason).toContain("python.exe");
  });

  it("rule 8: Windows console hosts and Git Bash's launcher are not work", () => {
    const pwsh = shell("t1");
    const conhost = only({ terminals: [terminal("t1")], processes: [pwsh, child(pwsh, { name: "conhost.exe" })] });
    expect(conhost?.cls).toBe("idle");

    const launcher = shell("t2", { name: "bash.exe" });
    const inner = child(launcher, { name: "bash.exe" });
    const gitBash = terminal("t2", { shellId: "git-bash", title: "Git Bash", label: "Git Bash" });
    expect(only({ terminals: [gitBash], processes: [launcher, inner] })?.cls).toBe("idle");
    // A command under Git Bash's real shell is still work.
    const sleeping = only({ terminals: [gitBash], processes: [launcher, inner, child(inner, { name: "sleep.exe" })] });
    expect(sleeping?.cls).toBe("waiting");
    // Another shell's nested shell is work (it may hold state).
    const nested = only({
      terminals: [terminal("t3")],
      processes: [shell("t3", { name: "bash" }), proc("t3", { name: "bash" })],
    });
    expect(nested?.cls).toBe("waiting");
  });

  it("rule 9: unsent input at the prompt is waiting (work that would be lost)", () => {
    const entry = only({
      terminals: [terminal("t1")],
      processes: [shell("t1")],
      activity: () => ({ lastOutputAt: NOW - QUIET_MS * 2, lastInputAt: NOW - QUIET_MS * 2, unsent: true }),
    });
    expect(entry).toMatchObject({ cls: "waiting", reason: "Unsent input at the prompt" });
  });

  it("rule 10: a terminal used within the quiet threshold is active", () => {
    const typed = only({
      terminals: [terminal("t1")],
      processes: [shell("t1")],
      activity: () => ({ ...NO_ACTIVITY, lastInputAt: NOW - 40_000 }),
    });
    expect(typed).toMatchObject({ cls: "active", reason: "Used 40 s ago" });
    const justStarted = only({
      terminals: [terminal("t1", { startedAt: new Date(NOW - 5_000).toISOString() })],
      processes: [shell("t1")],
    });
    expect(justStarted?.cls).toBe("active");
  });

  it("classifies each terminal on its own signals", () => {
    const a = shell("a");
    const b = shell("b");
    const scan = classify({
      terminals: [terminal("a"), terminal("b"), terminal("c", { status: "exited", endedAt: LONG_AGO })],
      processes: [a, b, child(b, { name: "ping.exe", cpuPercent: 0 })],
    });
    expect(scan.blocked).toBeNull();
    expect(scan.entries.map((e) => [e.terminal.id, e.cls])).toEqual([
      ["a", "idle"],
      ["b", "waiting"],
      ["c", "idle"],
    ]);
  });

  it("formats durations", () => {
    expect(formatAgo(12_000)).toBe("12 s");
    expect(formatAgo(14 * 60_000)).toBe("14 min");
    expect(formatAgo(125 * 60_000)).toBe("2 h 5 min");
  });
});
