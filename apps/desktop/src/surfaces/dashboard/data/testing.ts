/** Test helpers for the Dashboard data layer (imported by *.test.ts only). */
import type { ThreadStatus, ThreadSummary } from "@kalcode/protocol";

export const ALL_STATUSES: ThreadStatus[] = [
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

let seq = 0;

export function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  seq += 1;
  return {
    id: `01999a4e-0000-7000-8000-${seq.toString(16).padStart(12, "0")}`,
    name: `Thread ${seq}`,
    providerId: "claude-code",
    providerName: "Claude Code",
    model: null,
    accountLabel: null,
    workspaceId: "01999a4e-0001-7001-8a2e-000000001001",
    workspaceName: "kalcode",
    permissionMode: "approve",
    status: "idle",
    currentActivity: null,
    createdAt: "2026-09-24T10:00:00.000Z",
    lastActivityAt: "2026-09-24T10:30:00.000Z",
    pendingApprovals: 0,
    unreadMessages: 0,
    filesChanged: null,
    branch: null,
    error: null,
    archivedAt: null,
    resumable: false,
    permissionProfileId: null,
    runtimeKind: null,
    terminalId: null,
    ...overrides,
  };
}
