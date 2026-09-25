import type { ThreadMessage, ThreadStatus, ThreadSummary, ToolCallRecord } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { buildTimeline, isThreadEvent, matchesQuery, presentStatus, providerModeNote, threadActions } from "./model.ts";

const ALL: ThreadStatus[] = [
  "starting",
  "active",
  "thinking",
  "running_tool",
  "running_command",
  "editing",
  "testing",
  "reviewing",
  "idle",
  "waiting_for_permission",
  "waiting_for_user",
  "waiting_for_dependency",
  "paused",
  "completed",
  "failed",
  "interrupted",
  "recovering",
  "offline",
];

function summary(partial: Partial<ThreadSummary>): ThreadSummary {
  return {
    id: "t",
    name: "Fix OAuth Callback Race",
    providerId: "claude-code",
    providerName: "Claude Code",
    model: null,
    accountLabel: null,
    workspaceId: "w",
    workspaceName: "kalcode",
    permissionMode: "approve",
    status: "idle",
    currentActivity: null,
    createdAt: "2026-09-24T10:00:00.000Z",
    lastActivityAt: "2026-09-24T10:00:00.000Z",
    pendingApprovals: 0,
    unreadMessages: 0,
    filesChanged: 0,
    branch: null,
    error: null,
    ...partial,
  };
}

describe("presentStatus", () => {
  it("labels every state in sentence case and never by color alone", () => {
    for (const status of ALL) {
      const presentation = presentStatus(status);
      expect(presentation.label).toMatch(/^[A-Z][a-z ]+$/);
    }
    expect(presentStatus("waiting_for_permission")).toEqual({
      label: "Needs approval",
      tone: "waiting",
      working: false,
    });
    expect(presentStatus("failed").tone).toBe("danger");
    expect(presentStatus("running_tool").working).toBe(true);
  });
});

describe("threadActions", () => {
  it("offers only the actions valid in each state", () => {
    expect(threadActions({ status: "thinking" })).toEqual({
      interrupt: true,
      stop: true,
      resume: false,
      archive: false,
      compose: "send",
    });
    expect(threadActions({ status: "idle" })).toMatchObject({ interrupt: false, stop: true, compose: "send" });
    expect(threadActions({ status: "waiting_for_permission" })).toMatchObject({
      interrupt: true,
      stop: true,
      compose: "blocked",
    });
    expect(threadActions({ status: "starting" })).toMatchObject({ interrupt: false, stop: true });
    for (const terminal of ["completed", "failed", "interrupted"] as const) {
      expect(threadActions({ status: terminal })).toEqual({
        interrupt: false,
        stop: false,
        resume: true,
        archive: true,
        compose: "resume",
      });
    }
    expect(threadActions({ status: "paused" })).toMatchObject({ resume: true, stop: true, compose: "resume" });
  });

  it("archived threads are read-only", () => {
    expect(threadActions({ status: "completed" }, true)).toEqual({
      interrupt: false,
      stop: false,
      resume: false,
      archive: false,
      compose: "blocked",
    });
  });
});

describe("buildTimeline", () => {
  const message = (id: string, at: string): ThreadMessage => ({
    id,
    threadId: "t",
    role: "assistant",
    content: id,
    createdAt: at,
  });
  const tool = (id: string, at: string): ToolCallRecord => ({
    id,
    threadId: "t",
    tool: "Bash",
    summary: id,
    status: "completed",
    resultSummary: null,
    requestedAt: at,
    startedAt: at,
    completedAt: at,
  });

  it("interleaves messages and tool calls by time, messages first on ties", () => {
    const items = buildTimeline(
      [message("m1", "2026-09-24T10:00:00.000Z"), message("m2", "2026-09-24T10:00:02.000Z")],
      [tool("t1", "2026-09-24T10:00:01.000Z"), tool("t2", "2026-09-24T10:00:02.000Z")],
    );
    expect(items.map((i) => i.key)).toEqual(["m1", "t1", "m2", "t2"]);
  });
});

describe("matchesQuery", () => {
  it("searches name, provider, workspace, activity and status", () => {
    const thread = summary({ status: "running_tool", currentActivity: "Run npm test" });
    for (const q of ["oauth", "CLAUDE", "kalcode", "npm", "running a tool", "  "]) {
      expect(matchesQuery(thread, q)).toBe(true);
    }
    expect(matchesQuery(thread, "codex")).toBe(false);
  });
});

describe("isThreadEvent", () => {
  it("recognizes events that change threads", () => {
    for (const type of ["thread.created", "agent.message", "tool.failed", "file.modified", "approval.approved"]) {
      expect(isThreadEvent(type)).toBe(true);
    }
    for (const type of ["settings.changed", "app.started", "shell.started"]) {
      expect(isThreadEvent(type)).toBe(false);
    }
  });
});

describe("providerModeNote", () => {
  const mapping = (mode: "plan" | "approve" | "auto" | "bypass", notes: string) => ({
    mode,
    fidelity: "approximate_stricter" as const,
    providerSetting: "--flags",
    notes,
  });
  const claude = {
    displayName: "Claude Code",
    hostApprovals: false,
    permissionMappings: [mapping("approve", "Approve note."), mapping("bypass", "Bypass note.")],
  };

  it("shows the provider's own mapping note for the mode", () => {
    expect(providerModeNote(claude, "bypass")).toBe(" With Claude Code: Bypass note.");
    expect(providerModeNote(claude, "approve")).toBe(" With Claude Code: Approve note.");
  });

  it("says Custom runs as Approve instead of claiming its rules apply", () => {
    const note = providerModeNote(claude, "custom");
    expect(note).toContain("Approve note.");
    expect(note).toContain("Custom rules aren't applied");
  });

  it("never claims a mode it has no mapping for", () => {
    expect(providerModeNote(claude, "plan")).toContain("anything that would ask is refused");
    expect(providerModeNote(claude, "plan")).not.toContain("most restrictive");
  });

  it("adds nothing when the provider hands approvals to KalCode", () => {
    expect(providerModeNote({ ...claude, hostApprovals: true }, "approve")).toBe("");
  });
});
