/**
 * Ready-made scenario sets built from the fixture builders: coherent threads, approvals, events
 * and provider detections that reference each other by id.
 */
import type {
  ApprovalRequest,
  EventEnvelope,
  EventPayload,
  PermissionMode,
  ProviderDetection,
  ThreadStatus,
  ThreadSummary,
} from "@kalcode/protocol";
import { createFixtures, type EventType, type Fixtures, type WorkspaceRef } from "./builders.ts";
import { ACTION_KINDS, THREAD_STATUSES } from "./constants.ts";

export interface Scenario {
  workspace: WorkspaceRef;
  threads: ThreadSummary[];
  approvals: ApprovalRequest[];
  /** Chronological (ascending `seq`), as `events_recent` returns them reversed. */
  events: EventEnvelope[];
  providers: ProviderDetection[];
}

const PROVIDERS = ["claude-code", "codex", "gemini-cli"] as const;
const MODES: PermissionMode[] = ["approve", "plan", "auto", "approve", "custom"];

/**
 * One valid payload for every event type in the catalog. Keyed by type, so adding an event to the
 * Rust catalog fails typecheck here until it has a sample.
 */
export function samplePayloads(fx: Fixtures = createFixtures()): {
  [T in EventType]: Extract<EventPayload, { type: T }>;
} {
  const threadId = fx.id();
  const workspaceId = fx.defaultWorkspace().id;
  const requestId = fx.id();
  const terminalId = fx.id();
  const worktreeId = fx.id();
  const checkpointId = fx.id();
  const packageId = fx.id();
  const taskId = fx.id();
  const at = fx.clock.now();
  return {
    "app.started": {
      type: "app.started",
      payload: { version: "0.1.0", channel: "development", platform: "windows", arch: "x86_64" },
    },
    "app.stopped": { type: "app.stopped", payload: { uptimeMs: 3_600_000 } },
    "app.previous_session_interrupted": { type: "app.previous_session_interrupted", payload: { lastEventAt: at } },
    "database.migrated": {
      type: "database.migrated",
      payload: { fromVersion: 0, toVersion: 1, backupCreated: false },
    },
    "settings.changed": { type: "settings.changed", payload: { keys: ["theme"] } },
    "secure_store.checked": {
      type: "secure_store.checked",
      payload: { ok: true, backend: "windows-credential-manager" },
    },
    "workspace.created": { type: "workspace.created", payload: { workspaceId, name: "kalcode-web" } },
    "workspace.opened": { type: "workspace.opened", payload: { workspaceId, name: "kalcode-web" } },
    "workspace.removed": { type: "workspace.removed", payload: { workspaceId, name: "kalcode-web" } },
    "shell.started": { type: "shell.started", payload: { terminalId, shellId: "pwsh", shellName: "PowerShell" } },
    "shell.completed": { type: "shell.completed", payload: { terminalId, exitCode: 0, closedByUser: true } },
    "shell.failed": { type: "shell.failed", payload: { terminalId, exitCode: 1 } },
    "provider.detected": {
      type: "provider.detected",
      payload: { providerId: "claude-code", installed: true, version: "2.1.0" },
    },
    "provider.connected": {
      type: "provider.connected",
      payload: { providerId: "claude-code", accountLabel: "Personal" },
    },
    "provider.disconnected": {
      type: "provider.disconnected",
      payload: { providerId: "claude-code", accountLabel: "Personal" },
    },
    "provider.error": {
      type: "provider.error",
      payload: { providerId: "codex", code: "provider/not_authenticated", message: "Sign in to Codex to continue." },
    },
    "provider.health_changed": {
      type: "provider.health_changed",
      payload: { providerId: "codex", from: "healthy", to: "degraded", reason: "recent_failures" },
    },
    "provider.capacity_changed": {
      type: "provider.capacity_changed",
      payload: { providerId: "gemini-cli", state: "backing_off", activeSessions: 1, limit: null, retryAt: null },
    },
    "thread.created": {
      type: "thread.created",
      payload: { threadId, name: "Fix flaky login test", providerId: "claude-code", workspaceId },
    },
    "thread.started": { type: "thread.started", payload: { threadId } },
    "thread.status_changed": {
      type: "thread.status_changed",
      payload: { threadId, from: "thinking", to: "running_command", detail: "Running npm test" },
    },
    "thread.renamed": { type: "thread.renamed", payload: { threadId, name: "Fix the login test" } },
    "thread.completed": { type: "thread.completed", payload: { threadId } },
    "thread.failed": {
      type: "thread.failed",
      payload: { threadId, code: "provider/process_exited", message: "The provider process stopped unexpectedly." },
    },
    "thread.archived": { type: "thread.archived", payload: { threadId } },
    "agent.message": { type: "agent.message", payload: { threadId, messageId: fx.id(), role: "assistant" } },
    "tool.requested": {
      type: "tool.requested",
      payload: { threadId, toolCallId: "call_1", tool: "bash", summary: "Run npm test" },
    },
    "tool.started": { type: "tool.started", payload: { threadId, toolCallId: "call_1" } },
    "tool.completed": { type: "tool.completed", payload: { threadId, toolCallId: "call_1" } },
    "tool.failed": { type: "tool.failed", payload: { threadId, toolCallId: "call_1", summary: "Exit code 1" } },
    "file.created": { type: "file.created", payload: { threadId, path: "src/new.ts" } },
    "file.modified": { type: "file.modified", payload: { threadId, path: "src/settings/store.ts" } },
    "file.deleted": { type: "file.deleted", payload: { threadId, path: "build/cache.json" } },
    "approval.requested": {
      type: "approval.requested",
      payload: { requestId, threadId, scopes: ["terminal.execute"], summary: "Run npm install lodash" },
    },
    "approval.approved": { type: "approval.approved", payload: { requestId, threadId, decision: "approve_once" } },
    "approval.denied": { type: "approval.denied", payload: { requestId, threadId } },
    "approval.expired": { type: "approval.expired", payload: { requestId, threadId } },
    "permission.mode_changed": { type: "permission.mode_changed", payload: { threadId, from: "approve", to: "plan" } },
    "permission.default_mode_changed": {
      type: "permission.default_mode_changed",
      payload: { from: "approve", to: "plan" },
    },
    "git.branch_changed": { type: "git.branch_changed", payload: { workspaceId, from: "main", to: "kal/fix-login" } },
    "git.diff_changed": { type: "git.diff_changed", payload: { workspaceId, worktreeId: null, files: 3 } },
    "git.commit_created": {
      type: "git.commit_created",
      payload: { workspaceId, worktreeId: null, oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", byKalCode: true },
    },
    "git.worktree_created": {
      type: "git.worktree_created",
      payload: { workspaceId, worktreeId, branch: "kal/fix-login", purpose: "thread" },
    },
    "git.worktree_removed": {
      type: "git.worktree_removed",
      payload: { workspaceId, worktreeId, branch: "kal/fix-login", purpose: "thread" },
    },
    "timeline.checkpoint_created": {
      type: "timeline.checkpoint_created",
      payload: { checkpointId, workspaceId, trigger: "thread_turn", files: 4, bytesAdded: 12_288 },
    },
    "timeline.checkpoint_pruned": {
      type: "timeline.checkpoint_pruned",
      payload: { checkpointId, reason: "retention" },
    },
    "context.package_created": {
      type: "context.package_created",
      payload: { packageId, purpose: "handoff", items: 3, bytes: 4_096 },
    },
    "context.blocked": { type: "context.blocked", payload: { packageId, rule: "secret.env_file", items: 1 } },
    "context.redacted": { type: "context.redacted", payload: { packageId, items: 1, spans: 2 } },
    "context.override_confirmed": {
      type: "context.override_confirmed",
      payload: { packageId, position: 0, rule: "sensitive.path" },
    },
    "context.shared": {
      type: "context.shared",
      payload: { packageId, threadId, providerId: "claude-code", items: 3, bytes: 4_096, redactions: 2 },
    },
    "context.discarded": { type: "context.discarded", payload: { packageId } },
    "resource.pressure_changed": {
      type: "resource.pressure_changed",
      payload: {
        resource: "memory",
        from: "normal",
        to: "high",
        mode: "balanced",
        signal: { signal: "memory_used_percent" },
        value: 91,
        threshold: 90,
      },
    },
    "resource.mode_changed": { type: "resource.mode_changed", payload: { from: "balanced", to: "conservative" } },
    "resource.task_held": {
      type: "resource.task_held",
      payload: {
        taskId,
        reasons: [{ kind: "user_limit", running: 4, limit: 4, mode: "balanced" }],
        mode: "balanced",
      },
    },
    "resource.task_released": {
      type: "resource.task_released",
      payload: { taskId, heldMs: 12_000, cause: "limit_freed" },
    },
    "kalvoice.dictation_started": { type: "kalvoice.dictation_started", payload: { sessionId: requestId } },
    "kalvoice.dictation_completed": {
      type: "kalvoice.dictation_completed",
      payload: { sessionId: requestId, durationMs: 2_400, characters: 64 },
    },
    "kalvoice.dictation_failed": {
      type: "kalvoice.dictation_failed",
      payload: { sessionId: requestId, code: "microphone_unavailable" },
    },
    "kalvoice.request_started": { type: "kalvoice.request_started", payload: { requestId, input: "voice" } },
    "kalvoice.command_recognized": {
      type: "kalvoice.command_recognized",
      payload: { requestId, intent: "create_threads" },
    },
    "kalvoice.command_executed": {
      type: "kalvoice.command_executed",
      payload: { requestId, intent: "create_threads" },
    },
    "kalvoice.request_completed": { type: "kalvoice.request_completed", payload: { requestId } },
    "kalvoice.request_failed": { type: "kalvoice.request_failed", payload: { requestId, code: "needs_provider" } },
    "kalvoice.limit_reached": {
      type: "kalvoice.limit_reached",
      payload: { allowance: 250, resetsAt: fx.clock.offset(86_400_000) },
    },
    "kalvoice.provider_selected": {
      type: "kalvoice.provider_selected",
      payload: { intelligence: { kind: "provider", providerId: "claude-code" }, scope: "global" },
    },
    "kalvoice.voice_output_started": { type: "kalvoice.voice_output_started", payload: { requestId } },
    "kalvoice.voice_output_completed": { type: "kalvoice.voice_output_completed", payload: { requestId } },
    "kalvoice.talk_routed": { type: "kalvoice.talk_routed", payload: { requestId, outcome: "command" } },
    "notification.created": {
      type: "notification.created",
      payload: {
        notificationId: "0192f3c4-5b6a-7c8d-9e0f-1a2b3c4d5e6f",
        kind: "thread_completed",
        severity: "info",
        entityKind: "thread",
        entityId: threadId,
      },
    },
    unrecognized: { type: "unrecognized", payload: { originalType: "future.event", originalVersion: 2 } },
  };
}

function lifecycleEvents(fx: Fixtures, thread: ThreadSummary): EventEnvelope[] {
  const events = [
    fx.buildEvent("thread.created", {
      threadId: thread.id,
      name: thread.name,
      providerId: thread.providerId,
      workspaceId: thread.workspaceId,
    }),
    fx.buildEvent("thread.started", { threadId: thread.id }),
  ];
  if (thread.status !== "starting") {
    events.push(
      fx.buildEvent("thread.status_changed", {
        threadId: thread.id,
        from: "starting",
        to: thread.status,
        detail: thread.currentActivity,
      }),
    );
  }
  if (thread.status === "completed") events.push(fx.buildEvent("thread.completed", { threadId: thread.id }));
  if (thread.status === "failed" && thread.error) {
    events.push(
      fx.buildEvent("thread.failed", { threadId: thread.id, code: thread.error.code, message: thread.error.message }),
    );
  }
  return events;
}

function approvalFor(fx: Fixtures, thread: ThreadSummary, index: number): ApprovalRequest {
  const kind = ACTION_KINDS[index % ACTION_KINDS.length] ?? "command";
  const action = fx.buildNormalizedAction({
    threadId: thread.id,
    workspaceId: thread.workspaceId,
    providerId: thread.providerId,
    action: fx.buildActionKind(kind),
  });
  return fx.buildApprovalRequest({ action, permissionMode: thread.permissionMode });
}

function requestedEvent(fx: Fixtures, approval: ApprovalRequest): EventEnvelope {
  return fx.buildEvent("approval.requested", {
    requestId: approval.id,
    threadId: approval.action.threadId,
    scopes: approval.decision.scopes,
    summary: approval.action.summary,
  });
}

function detections(fx: Fixtures): ProviderDetection[] {
  return PROVIDERS.map((providerId) => fx.buildProviderDetection({ providerId }));
}

/**
 * A busy workspace: one thread in each of the 18 `ThreadStatus` values (in lifecycle order),
 * across three providers and several permission modes, with a pending approval for the thread
 * that waits for permission and a lifecycle event trail for every thread.
 */
export function busyWorkspace(fx: Fixtures = createFixtures()): Scenario {
  const workspace = fx.defaultWorkspace();
  const threads = THREAD_STATUSES.map((status: ThreadStatus, index) => {
    fx.clock.tick();
    return fx.buildThreadSummary({
      status,
      providerId: PROVIDERS[index % PROVIDERS.length],
      permissionMode: MODES[index % MODES.length],
      branch: index % 3 === 0 ? `kal/${status.replaceAll("_", "-")}` : null,
      filesChanged: index % 4 === 0 ? null : index,
      unreadMessages: index % 5,
    });
  });

  const events = threads.flatMap((thread) => lifecycleEvents(fx, thread));
  const approvals = threads
    .filter((thread) => thread.status === "waiting_for_permission")
    .map((thread, index) => approvalFor(fx, thread, index));
  events.push(...approvals.map((approval) => requestedEvent(fx, approval)));
  return { workspace, threads, approvals, events, providers: detections(fx) };
}

/**
 * An approval flood: `count` pending approvals spread over `threads` threads (all waiting for
 * permission, each with a matching `pendingApprovals`), cycling through every action kind.
 */
export function approvalFlood(options: { count?: number; threads?: number; fixtures?: Fixtures } = {}): Scenario {
  const fx = options.fixtures ?? createFixtures();
  const count = options.count ?? 50;
  const threadCount = Math.max(1, Math.min(options.threads ?? 5, count));
  const workspace = fx.defaultWorkspace();
  const threads = Array.from({ length: threadCount }, (_, index) =>
    fx.buildThreadSummary({
      status: "waiting_for_permission",
      providerId: PROVIDERS[index % PROVIDERS.length],
      pendingApprovals: Math.floor(count / threadCount) + (index < count % threadCount ? 1 : 0),
    }),
  );

  const approvals: ApprovalRequest[] = [];
  for (let index = 0; index < count; index += 1) {
    const thread = threads[index % threadCount];
    if (!thread) continue;
    fx.clock.tick(250);
    approvals.push(approvalFor(fx, thread, index));
  }
  const events = [
    ...threads.flatMap((thread) => lifecycleEvents(fx, thread)),
    ...approvals.map((approval) => requestedEvent(fx, approval)),
  ];
  return { workspace, threads, approvals, events, providers: detections(fx) };
}

/**
 * Failures: failed, interrupted, offline and recovering threads; providers that are missing,
 * outdated or erroring; denied and expired approvals; and the matching error events.
 */
export function failures(fx: Fixtures = createFixtures()): Scenario {
  const workspace = fx.defaultWorkspace();
  const statuses: ThreadStatus[] = ["failed", "failed", "interrupted", "offline", "recovering"];
  const threads = statuses.map((status, index) =>
    fx.buildThreadSummary({
      status,
      providerId: index === 1 ? "codex" : "claude-code",
      error:
        status === "failed" && index === 1
          ? fx.buildThreadError({
              code: "provider/not_authenticated",
              message: "Codex is signed out. Sign in again, then resume this thread.",
            })
          : undefined,
    }),
  );

  const failed = threads[0];
  const approvals = failed
    ? [
        fx.buildApprovalRequest({
          status: "denied",
          action: fx.buildNormalizedAction({ threadId: failed.id, action: fx.buildActionKind("git") }),
        }),
        fx.buildApprovalRequest({
          status: "expired",
          action: fx.buildNormalizedAction({ threadId: failed.id, action: fx.buildActionKind("deploy") }),
        }),
      ]
    : [];

  const providers = [
    fx.buildProviderDetection({ providerId: "claude-code", state: "installed" }),
    fx.buildProviderDetection({ providerId: "codex", state: "outdated" }),
    fx.buildProviderDetection({ providerId: "gemini-cli", state: "not_installed" }),
    fx.buildProviderDetection({ providerId: "example-provider", displayName: "Example", state: "error" }),
  ];

  const events: EventEnvelope[] = [
    fx.buildEvent("app.previous_session_interrupted", { lastEventAt: fx.clock.offset(-600_000) }),
    ...threads.flatMap((thread) => lifecycleEvents(fx, thread)),
    fx.buildEvent("provider.error", {
      providerId: "codex",
      code: "provider/outdated",
      message: "This Codex version is older than KalCode supports.",
    }),
  ];
  if (failed) {
    events.push(
      fx.buildEvent("tool.failed", { threadId: failed.id, toolCallId: "call_7", summary: "npm test exited with 1" }),
    );
    for (const approval of approvals) {
      events.push(
        approval.status === "denied"
          ? fx.buildEvent("approval.denied", { requestId: approval.id, threadId: failed.id })
          : fx.buildEvent("approval.expired", { requestId: approval.id, threadId: failed.id }),
      );
    }
  }
  events.push(fx.buildEvent("shell.failed", { terminalId: fx.id(), exitCode: 127 }));
  return { workspace, threads, approvals, events, providers };
}

/** `count` envelopes cycling through every event type — for feeds, virtualization and perf tests. */
export function eventStream(count: number, fx: Fixtures = createFixtures()): EventEnvelope[] {
  const samples = Object.values(samplePayloads(fx)) as EventPayload[];
  return Array.from({ length: count }, (_, index) => {
    fx.clock.tick(100);
    const sample = samples[index % samples.length];
    if (!sample) throw new Error("no event samples");
    return fx.buildEventEnvelope(sample);
  });
}
