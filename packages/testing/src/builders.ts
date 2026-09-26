/**
 * Typed fixture builders for the shared contracts (`packages/protocol/src/generated`).
 *
 * Every builder takes `overrides` that always win. Defaults are internally consistent (a
 * `failed` thread carries an error, a thread waiting for permission has a pending approval, a
 * resolved approval has a resolution time) so screens render realistic states without
 * hand-assembling objects. Ids and timestamps come from the fixture context: deterministic for a
 * given seed.
 */
import type {
  ActionKind,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalStatus,
  Correlation,
  EventEnvelope,
  EventPayload,
  EventSource,
  NormalizedAction,
  PermissionScope,
  PolicyDecision,
  ProviderCapabilities,
  ProviderDetection,
  ProviderId,
  ThreadError,
  ThreadMessage,
  ThreadStatus,
  ThreadSummary,
} from "@kalcode/protocol";
import { createClock, createIdFactory, DEFAULT_EPOCH, type FixtureClock, type IdFactory } from "./deterministic.ts";

export type ActionKindName = ActionKind["kind"];
export type ActionOf<K extends ActionKindName> = Extract<ActionKind, { kind: K }>;
export type EventType = EventPayload["type"];
export type PayloadOf<T extends EventType> = Extract<EventPayload, { type: T }>["payload"];
type EnvelopeMeta = Pick<EventEnvelope, "id" | "seq" | "version" | "occurredAt" | "source" | "correlation">;

/** A workspace reference as threads and actions carry it (the `Workspace` record itself is Z1's). */
export interface WorkspaceRef {
  id: string;
  name: string;
}

/** Provider display names for the providers KalCode targets first. */
export const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

const THREAD_NAMES = [
  "Fix flaky login test",
  "Refactor settings store",
  "Add dark mode to reports",
  "Upgrade build tooling",
  "Investigate slow startup",
  "Write migration for audit log",
  "Review payment webhook",
  "Document the event protocol",
  "Split the Dashboard into cards",
  "Harden the updater",
  "Add CSV export",
  "Trim bundle size",
] as const;

const ACTIVITY_BY_STATUS: Partial<Record<ThreadStatus, string>> = {
  starting: "Starting session",
  thinking: "Planning the change",
  running_tool: "Reading src/settings/store.ts",
  running_command: "Running npm test",
  editing: "Editing src/settings/store.ts",
  testing: "Running the test suite",
  reviewing: "Reviewing the diff",
  waiting_for_permission: "Waiting for approval to run a command",
  waiting_for_user: "Asked a question",
  waiting_for_dependency: "Waiting for another thread",
  recovering: "Reconnecting to the provider",
};

const ERROR_BY_STATUS: Partial<Record<ThreadStatus, ThreadError>> = {
  failed: {
    code: "provider/process_exited",
    message: "The provider process stopped unexpectedly. Your files are unchanged. Resume the thread to try again.",
  },
  offline: {
    code: "provider/unreachable",
    message: "The provider can't be reached. Work resumes when the connection returns.",
  },
};

/** Plausible permission scopes per action kind — fixture defaults only, not the policy engine (Z4). */
export function defaultScopesFor(action: ActionKind): PermissionScope[] {
  switch (action.kind) {
    case "file_read":
      return ["filesystem.read"];
    case "file_write":
      return ["filesystem.write"];
    case "file_delete":
      return ["filesystem.write", "destructive"];
    case "command":
      return ["terminal.execute"];
    case "package_install":
      return ["package.install", "network.other"];
    case "git":
      if (action.operation === "push") return ["git.push"];
      if (action.operation === "commit") return ["git.commit"];
      if (action.operation === "reset") return ["git.commit", "destructive"];
      return ["git.read"];
    case "network":
      return ["network.other"];
    case "browser":
      return action.action === "navigate" ? ["browser.navigate"] : ["browser.interact"];
    case "deploy":
      return ["deploy.production"];
    case "tool":
      return ["terminal.execute"];
    case "process_signal":
      return ["process.control"];
    case "remote_connect":
      return ["remote.connect"];
    case "context_share":
      return ["context.share"];
    case "memory_write":
      return ["memory.write"];
    case "delegate":
      return ["agent.delegate"];
    case "restore":
      return ["filesystem.write", "destructive"];
    case "automation_change":
      return ["automation.manage"];
    case "doctor_fix":
      return ["terminal.execute"];
    case "create_threads":
    case "resume_threads":
      return ["thread.start"];
  }
}

function summarize(action: ActionKind): string {
  switch (action.kind) {
    case "file_read":
      return `Read ${action.path}`;
    case "file_write":
      return `Edit ${action.path}`;
    case "file_delete":
      return `Delete ${action.path}`;
    case "command":
      return `Run ${action.command}`;
    case "package_install":
      return `Install ${action.packages.join(", ")} with ${action.manager}`;
    case "git":
      return `git ${action.operation}${action.remote ? ` ${action.remote}` : ""}`;
    case "network":
      return `Connect to ${action.host}`;
    case "browser":
      return `Browser ${action.action}${action.url ? ` ${action.url}` : ""}`;
    case "deploy":
      return `Deploy to ${action.target}`;
    case "tool":
      return `Use ${action.tool}`;
    case "process_signal":
      return `${action.signal === "kill" ? "Kill" : "Stop"} ${action.processName} (pid ${action.pid})`;
    case "remote_connect":
      return `Connect to ${action.address}`;
    case "context_share":
      return `Share ${action.items} context items (${action.bytes} bytes)`;
    case "memory_write":
      return `Save to ${action.scope.kind} memory`;
    case "delegate":
      return `Delegate to agent ${action.delegateAgentId}`;
    case "restore":
      return `Restore ${action.files} files from a checkpoint${action.resetBranch ? " and reset the branch" : ""}`;
    case "automation_change":
      return `${action.change.charAt(0).toUpperCase()}${action.change.slice(1)} an automation`;
    case "doctor_fix":
      return `Apply fix ${action.fixCode} to ${action.target}`;
    case "create_threads": {
      const provider = PROVIDER_NAMES[action.providerId] ?? action.providerId;
      return `Open ${action.count} ${provider} thread${action.count === 1 ? "" : "s"}`;
    }
    case "resume_threads":
      if (action.scope.kind === "all") return "Resume all threads";
      return action.scope.kind === "workspace" ? "Resume threads in a workspace" : "Resume a thread";
  }
}

const DEFAULT_ACTIONS: { [K in ActionKindName]: ActionOf<K> } = {
  file_read: { kind: "file_read", path: "src/settings/store.ts" },
  file_write: { kind: "file_write", path: "src/settings/store.ts" },
  file_delete: { kind: "file_delete", path: "build/cache.json" },
  command: { kind: "command", command: "npm test", argv: ["npm", "test"], cwd: "." },
  package_install: { kind: "package_install", manager: "npm", packages: ["lodash"] },
  git: { kind: "git", operation: "push", remote: "origin" },
  network: { kind: "network", host: "registry.npmjs.org", url: "https://registry.npmjs.org/lodash" },
  browser: { kind: "browser", action: "navigate", url: "http://localhost:5173/" },
  deploy: { kind: "deploy", target: "production" },
  tool: { kind: "tool", tool: "web_search", inputSummary: "query: vite 8 migration" },
  process_signal: { kind: "process_signal", pid: 4242, processName: "node", signal: "terminate" },
  remote_connect: { kind: "remote_connect", hostId: "0192f3c4-0000-7000-8000-000000000001", address: "build-box:22" },
  context_share: { kind: "context_share", packageId: "0192f3c4-0000-7000-8000-000000000002", items: 3, bytes: 4096 },
  memory_write: { kind: "memory_write", memoryId: null, scope: { kind: "global" } },
  delegate: {
    kind: "delegate",
    contractId: "0192f3c4-0000-7000-8000-000000000003",
    delegateAgentId: "0192f3c4-0000-7000-8000-000000000004",
  },
  restore: { kind: "restore", checkpointId: "0192f3c4-0000-7000-8000-000000000005", files: 4, resetBranch: false },
  automation_change: {
    kind: "automation_change",
    automationId: "0192f3c4-0000-7000-8000-000000000006",
    change: "enable",
  },
  doctor_fix: { kind: "doctor_fix", fixCode: "path.missing_node", target: "PATH" },
  create_threads: { kind: "create_threads", providerId: "codex", count: 3, workspaceId: null },
  resume_threads: { kind: "resume_threads", scope: { kind: "all" } },
};

function resolvedDecisionFor(status: ApprovalStatus): ApprovalDecision | null {
  if (status === "approved") return "approve_once";
  if (status === "denied") return "deny";
  return null;
}

/**
 * Applies overrides over defaults. An override that is `undefined` keeps the default (so
 * `{ error: undefined }` does not erase a derived error); use `null` to clear a nullable field.
 */
export function withOverrides<T extends object>(defaults: T, overrides: Partial<T>): T {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

export interface FixtureOptions {
  /** PRNG seed for ids. Same seed, same data. Default 1. */
  seed?: number;
  /** Fixture clock start (RFC 3339). Default {@link DEFAULT_EPOCH}. */
  start?: string;
  /** How far `clock.tick()` moves by default, in ms. Default 1000. */
  stepMs?: number;
}

/** A fixture context: its own id sequence, clock and event sequence numbers. */
export function createFixtures(options: FixtureOptions = {}) {
  const ids: IdFactory = createIdFactory({ seed: options.seed, epoch: options.start ?? DEFAULT_EPOCH });
  const clock: FixtureClock = createClock({ start: options.start, stepMs: options.stepMs });
  let seq = 0;
  let threadCount = 0;
  let workspace: WorkspaceRef | null = null;

  const id = () => ids.next();

  /** The context's default workspace: every thread belongs to it unless overridden. */
  function defaultWorkspace(): WorkspaceRef {
    workspace ??= { id: id(), name: "kalcode-web" };
    return workspace;
  }

  function buildWorkspace(overrides: Partial<WorkspaceRef> = {}): WorkspaceRef {
    return withOverrides({ id: id(), name: "workspace" }, overrides);
  }

  function buildThreadError(overrides: Partial<ThreadError> = {}): ThreadError {
    return withOverrides(
      {
        code: "provider/process_exited",
        message: "The provider process stopped unexpectedly. Your files are unchanged.",
      },
      overrides,
    );
  }

  function buildThreadSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
    const index = threadCount;
    threadCount += 1;
    const status: ThreadStatus = overrides.status ?? "idle";
    const ws = overrides.workspaceId ? null : defaultWorkspace();
    const providerId: ProviderId = overrides.providerId ?? "claude-code";
    const createdAt = clock.offset(-(index + 1) * 60_000);
    return withOverrides(
      {
        id: id(),
        name: THREAD_NAMES[index % THREAD_NAMES.length] ?? "Thread",
        providerId,
        providerName: PROVIDER_NAMES[providerId] ?? providerId,
        model: null,
        providerAccountId: null,
        accountLabel: "Personal",
        workspaceId: ws?.id ?? "",
        workspaceName: ws?.name ?? "workspace",
        permissionMode: "approve",
        status,
        currentActivity: ACTIVITY_BY_STATUS[status] ?? null,
        createdAt,
        lastActivityAt: clock.now(),
        pendingApprovals: status === "waiting_for_permission" ? 1 : 0,
        unreadMessages: 0,
        filesChanged: null,
        branch: null,
        error: ERROR_BY_STATUS[status] ?? null,
        archivedAt: null,
        resumable: false,
        permissionProfileId: null,
        runtimeKind: null,
        terminalId: null,
      },
      overrides,
    );
  }

  function buildThreadMessage(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
    return withOverrides(
      {
        id: id(),
        threadId: overrides.threadId ?? id(),
        role: "assistant",
        content: "I updated the settings store and the tests pass.",
        createdAt: clock.now(),
      },
      overrides,
    );
  }

  function buildActionKind<K extends ActionKindName>(kind: K, overrides: Partial<Omit<ActionOf<K>, "kind">> = {}) {
    return { ...DEFAULT_ACTIONS[kind], ...overrides, kind } as ActionOf<K>;
  }

  function buildNormalizedAction(overrides: Partial<NormalizedAction> = {}): NormalizedAction {
    const action = overrides.action ?? buildActionKind("command");
    return withOverrides(
      {
        id: id(),
        threadId: overrides.threadId ?? id(),
        workspaceId: overrides.workspaceId ?? defaultWorkspace().id,
        providerId: "claude-code",
        action,
        summary: summarize(action),
        requestedAt: clock.now(),
        origin: null,
      },
      overrides,
    );
  }

  function buildPolicyDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
    return withOverrides(
      {
        effect: "ask",
        scopes: ["terminal.execute"],
        reason: "Running commands needs your approval in Approve mode.",
        approvable: true,
      },
      overrides,
    );
  }

  function buildApprovalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
    const action = overrides.action ?? buildNormalizedAction();
    const status: ApprovalStatus = overrides.status ?? "pending";
    const resolved = status !== "pending";
    return withOverrides(
      {
        id: id(),
        action,
        decision: buildPolicyDecision({ scopes: defaultScopesFor(action.action) }),
        permissionMode: "approve",
        status,
        resolvedDecision: resolvedDecisionFor(status),
        resolvedAt: resolved ? clock.offset(30_000) : null,
        allowedDecisions: ["deny", "approve_once", "approve_for_thread", "approve_for_workspace", "allow_via_rule"],
        grantCoverage: "only this exact request",
        context: null,
        createdAt: action.requestedAt,
        expireReason: status === "expired" ? "thread_stopped" : null,
      },
      overrides,
    );
  }

  function buildCorrelation(overrides: Partial<Correlation> = {}): Correlation {
    return withOverrides<Correlation>(
      {
        workspaceId: null,
        threadId: null,
        missionId: null,
        providerId: null,
        requestId: null,
        agentId: null,
        taskId: null,
        automationId: null,
        causationId: null,
      },
      overrides,
    );
  }

  /** Correlation ids implied by a payload (what the core indexes). */
  function correlationFor(event: EventPayload): Correlation {
    const payload = event.payload as Record<string, unknown>;
    const text = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : null);
    return buildCorrelation({
      workspaceId: text("workspaceId"),
      threadId: text("threadId"),
      providerId: text("providerId"),
      requestId: text("requestId"),
    });
  }

  /**
   * Wraps a payload in an envelope with the next sequence number. Correlation is derived from the
   * payload's ids unless overridden. Pass `{ type, payload }` exactly as the wire carries it.
   */
  function buildEventEnvelope(event: EventPayload, overrides: Partial<EnvelopeMeta> = {}): EventEnvelope {
    seq += 1;
    const meta = withOverrides<EnvelopeMeta>(
      {
        id: id(),
        seq,
        version: event.type === "unrecognized" ? event.payload.originalVersion : 1,
        occurredAt: clock.now(),
        source: defaultSource(event.type),
        correlation: correlationFor(event),
      },
      overrides,
    );
    return { ...meta, ...event } as EventEnvelope;
  }

  /** Typed shorthand: `buildEvent("thread.started", { threadId })`. */
  function buildEvent<T extends EventType>(
    type: T,
    payload: PayloadOf<T>,
    overrides: Partial<EnvelopeMeta> = {},
  ): EventEnvelope {
    return buildEventEnvelope({ type, payload } as EventPayload, overrides);
  }

  function buildProviderCapabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
    return withOverrides(
      {
        streaming: true,
        interrupt: true,
        resume: true,
        hostApprovals: true,
        models: [{ id: "default", displayName: "Default model", isDefault: true }],
        permissionMappings: [
          { mode: "plan", fidelity: "exact", providerSetting: "--permission-mode plan", notes: "" },
          { mode: "approve", fidelity: "exact", providerSetting: "--permission-mode default", notes: "" },
        ],
        interactive: null,
      },
      overrides,
    );
  }

  function buildProviderDetection(overrides: Partial<ProviderDetection> = {}): ProviderDetection {
    const providerId: ProviderId = overrides.providerId ?? "claude-code";
    const state = overrides.state ?? "installed";
    const installed = state === "installed" || state === "outdated";
    return withOverrides(
      {
        providerId,
        displayName: PROVIDER_NAMES[providerId] ?? providerId,
        state,
        displayPath: installed ? `~/.local/bin/${providerId}` : null,
        version: installed ? (state === "outdated" ? "0.9.0" : "2.1.0") : null,
        minimumVersion: "1.0.0",
        auth: installed ? "authenticated" : "unknown",
        message:
          state === "outdated"
            ? "This version is older than KalCode supports. Update it to connect."
            : state === "error"
              ? "KalCode couldn't run the provider to check its version."
              : null,
        checkedAt: clock.now(),
      },
      overrides,
    );
  }

  return {
    ids,
    clock,
    id,
    defaultWorkspace,
    buildWorkspace,
    buildThreadError,
    buildThreadSummary,
    buildThreadMessage,
    buildActionKind,
    buildNormalizedAction,
    buildPolicyDecision,
    buildApprovalRequest,
    buildCorrelation,
    buildEventEnvelope,
    buildEvent,
    buildProviderCapabilities,
    buildProviderDetection,
  };
}

export type Fixtures = ReturnType<typeof createFixtures>;

function defaultSource(type: EventType): EventSource {
  if (type.startsWith("provider.") || type.startsWith("agent.") || type.startsWith("tool.")) return "provider";
  if (type === "settings.changed") return "ui";
  if (type.startsWith("kalvoice.")) return "kalvoice";
  return "core";
}
