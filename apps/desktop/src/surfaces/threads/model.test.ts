import type {
  ProviderDetection,
  ProviderStatus,
  ThreadMessage,
  ThreadStatus,
  ThreadSummary,
  ToolCallRecord,
} from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { providerCatalog } from "../../ipc/memoryProviders.ts";
import {
  buildTimeline,
  isThreadEvent,
  isWaitingForResources,
  LAST_TURN_FAILED_ACTIVITY,
  matchesQuery,
  presentProblem,
  presentStatus,
  presentThread,
  providerModeNote,
  threadActions,
  unavailableReason,
} from "./model.ts";

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
    effort: null,
    providerAccountId: null,
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
    archivedAt: null,
    resumable: false,
    permissionProfileId: null,
    runtimeKind: null,
    terminalId: null,
    worktreeId: null,
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
      display: "permission_required",
      working: false,
    });
    expect(presentStatus("failed").tone).toBe("failed");
    // Owner palette: working green, waiting amber, paused amber, done neutral.
    expect(presentStatus("running_tool").tone).toBe("working");
    expect(presentStatus("paused").tone).toBe("paused");
    expect(presentStatus("completed").tone).toBe("done");
    expect(presentStatus("recovering").tone).toBe("recovering");
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
    // Stop only while something runs; a quiet thread is archived instead (its idle session ends).
    expect(threadActions({ status: "idle" })).toMatchObject({
      interrupt: false,
      stop: false,
      archive: true,
      compose: "send",
    });
    expect(threadActions({ status: "waiting_for_user" })).toMatchObject({ stop: false, archive: true });
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

  it("a thread waiting for system resources can only be stopped", () => {
    const waiting = {
      status: "waiting_for_dependency" as const,
      error: { code: "waiting_for_resources", message: "KalCode is waiting for system resources (CPU busy)." },
    };
    expect(threadActions(waiting)).toEqual({
      interrupt: false,
      stop: true,
      resume: false,
      archive: false,
      compose: "blocked",
    });
    // Its wait ran out: resumable, not failed.
    expect(
      threadActions({
        status: "interrupted",
        error: { code: "resources_unavailable", message: "Codex didn't start." },
      }),
    ).toMatchObject({ stop: false, resume: true, archive: true, compose: "resume" });
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

describe("thread problems", () => {
  const error = (code: string, message = "Details from the runtime.") => ({ code, message });

  it("a launch waiting for system resources reads as waiting, not as another task or a failure", () => {
    const thread = {
      status: "waiting_for_dependency" as const,
      currentActivity: "Waiting for system resources (CPU busy)",
      error: error("waiting_for_resources"),
    };
    expect(isWaitingForResources(thread)).toBe(true);
    expect(presentThread(thread)).toMatchObject({ label: "Waiting for system resources", tone: "waiting" });
    expect(presentProblem(thread)).toEqual({ title: "Waiting for system resources", tone: "waiting" });
    // A provider's own dependency wait keeps its generic label.
    expect(presentThread({ status: "waiting_for_dependency", error: null }).label).toBe("Waiting on another task");
  });

  it("a wait that ran out is resumable and never looks like a provider failure", () => {
    const thread = { status: "interrupted" as const, error: error("resources_unavailable") };
    expect(presentThread(thread)).toMatchObject({ label: "Not started", tone: "waiting" });
    expect(presentProblem(thread)).toEqual({ title: "Not started: system resources were busy", tone: "waiting" });
  });

  it("an idle thread whose last turn failed says so next to the error", () => {
    const thread = {
      status: "idle" as const,
      currentActivity: LAST_TURN_FAILED_ACTIVITY,
      error: error("process_exited", "Gemini CLI stopped unexpectedly (exit code 1)."),
    };
    expect(presentThread(thread)).toMatchObject({ label: "Last turn failed", tone: "failed" });
    expect(presentProblem(thread)).toEqual({ title: "The last turn failed", tone: "danger" });
    expect(threadActions(thread)).toMatchObject({ stop: false, archive: true, compose: "send" });
  });

  it("distinguishes each kind of launch problem", () => {
    const titles = (code: string) => presentProblem({ status: "active", error: error(code) })?.title;
    expect(titles("provider_start_failed")).toBe("The provider couldn't start");
    expect(titles("provider_exited")).toBe("The provider stopped unexpectedly");
    expect(titles("process_exited")).toBe("The provider stopped unexpectedly");
    expect(titles("provider_not_authenticated")).toBe("Sign-in needed");
    expect(titles("provider_account_busy")).toBe("This account can't be used right now");
    expect(titles("provider_account_ineligible")).toBe("This account can't be used right now");
    expect(titles("provider_version_unsupported")).toBe("Unsupported provider version");
    expect(titles("codex_approve_requires_git")).toBe("Needs a Git folder");
    expect(titles("codex_item_error")).toBe("The provider reported a problem");
    // A failed thread keeps its failure title (older persisted codes included).
    expect(presentProblem({ status: "failed", error: error("provider_start_failed") })).toEqual({
      title: "This thread failed",
      tone: "danger",
    });
    expect(presentProblem({ status: "idle", error: null })).toBeNull();
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

describe("providerModeNote with the Codex and Gemini CLI mappings", () => {
  const option = (status: ProviderStatus) => ({
    displayName: status.displayName,
    hostApprovals: status.capabilities.hostApprovals,
    permissionMappings: status.capabilities.permissionMappings,
  });
  const [, codex, gemini] = providerCatalog() as [ProviderStatus, ProviderStatus, ProviderStatus];

  it("reads as one sentence per mode, from the provider's own mapping note", () => {
    expect(providerModeNote(option(codex), "plan")).toMatch(/^ With Codex: Reads and read-only commands inside/);
    expect(providerModeNote(option(codex), "bypass")).toContain("danger-full-access is never used.");
    expect(providerModeNote(option(gemini), "plan")).toMatch(/^ With Gemini CLI: Gemini CLI's read-only plan mode\./);
    expect(providerModeNote(option(gemini), "custom")).toContain("it runs as Approve");
  });
});

describe("unavailableReason", () => {
  const [claude, codex, gemini] = providerCatalog() as [ProviderStatus, ProviderStatus, ProviderStatus];
  const detected = (status: ProviderStatus, partial: Partial<ProviderDetection>): ProviderStatus => ({
    ...status,
    detection: {
      providerId: status.id,
      displayName: status.displayName,
      state: "installed",
      displayPath: null,
      version: "1.0.0",
      minimumVersion: null,
      auth: "authenticated",
      checkedAt: "2026-09-25T00:00:00Z",
      message: null,
      ...partial,
    },
  });

  it("tells a signed-out provider how to sign in, as plain text", () => {
    expect(unavailableReason(detected(codex, { auth: "not_authenticated" }))).toBe("Signed out — run codex login");
    expect(unavailableReason(detected(claude, { auth: "not_authenticated" }))).toBe(
      "Signed out — run claude auth login",
    );
  });

  it("says why an implemented adapter isn't offered", () => {
    expect(unavailableReason(detected(gemini, { state: "not_installed" }))).toBe("Not installed");
    expect(unavailableReason(detected(codex, { state: "outdated", minimumVersion: "0.155.0" }))).toBe(
      "Needs version 0.155.0 or later",
    );
    expect(unavailableReason(codex)).toBe("Not checked yet");
  });

  it("keeps the no-adapter copy for planned adapters only", () => {
    const planned = { ...detected(codex, {}), adapter: "planned" as const };
    expect(unavailableReason(planned)).toBe("Installed, but KalCode can't run threads with it yet");
    expect(unavailableReason({ ...codex, adapter: "planned" })).toBe("KalCode can't run threads with it yet");
    expect(unavailableReason(detected(codex, { auth: "not_authenticated" }))).not.toContain("can't run threads");
  });
});
