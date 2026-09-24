/**
 * In-memory permission commands for unit tests and the `ui-test` build ONLY (never bundled into
 * development or production builds). Mirrors the native service's validation and semantics:
 * only pending requests can be answered, only the decisions a request allows are accepted,
 * Bypass needs `confirmBypass: true`, and every change emits the same events.
 *
 * Scenario `approvals` seeds pending requests from several providers and modes.
 */
import type {
  ApprovalDecision,
  ApprovalStatus,
  ApprovalView,
  EventPayload,
  IpcError,
  PermissionMode,
  PermissionProfile,
  PermissionRule,
  PermissionScope,
  PermissionSettings,
  RuleEffect,
} from "@kalcode/protocol";

type Handler = (args: Record<string, unknown>) => unknown;

export type PermissionCommand =
  | "approval_list"
  | "approval_decide"
  | "permission_profiles_list"
  | "thread_set_permission_mode"
  | "permission_settings_get"
  | "permission_settings_update";

export const ALL_SCOPES: readonly PermissionScope[] = [
  "filesystem.read",
  "filesystem.write",
  "filesystem.outside_workspace",
  "terminal.read_only",
  "terminal.execute",
  "package.install",
  "git.read",
  "git.commit",
  "git.push",
  "network.docs",
  "network.other",
  "browser.navigate",
  "browser.interact",
  "credentials.access",
  "messaging.send",
  "deploy.production",
  "cloud.modify",
  "billing.spend",
  "destructive",
];

const REMOTE: readonly PermissionScope[] = [
  "git.push",
  "messaging.send",
  "deploy.production",
  "cloud.modify",
  "billing.spend",
];
const ALWAYS_ASK: readonly PermissionScope[] = [
  ...REMOTE,
  "destructive",
  "credentials.access",
  "filesystem.outside_workspace",
];

/** Mirrors `policy::baseline` in crates/permissions. */
export function baseline(mode: PermissionMode, scope: PermissionScope): RuleEffect {
  switch (mode) {
    case "plan":
      if (["filesystem.read", "git.read", "terminal.read_only"].includes(scope)) return "allow";
      if (
        [
          "filesystem.outside_workspace",
          "network.docs",
          "network.other",
          "browser.navigate",
          "credentials.access",
        ].includes(scope)
      )
        return "ask";
      return "deny";
    case "approve":
    case "custom":
      return ["filesystem.read", "git.read", "terminal.read_only"].includes(scope) ? "allow" : "ask";
    case "auto":
      return !ALWAYS_ASK.includes(scope) &&
        [
          "filesystem.read",
          "filesystem.write",
          "terminal.read_only",
          "terminal.execute",
          "git.read",
          "git.commit",
          "network.docs",
          "browser.navigate",
        ].includes(scope)
        ? "allow"
        : "ask";
    case "bypass":
      return REMOTE.includes(scope) || scope === "credentials.access" || scope === "filesystem.outside_workspace"
        ? "ask"
        : "allow";
  }
}

const rules = (entries: Record<PermissionScope, RuleEffect>): PermissionRule[] =>
  ALL_SCOPES.map((scope) => ({ scope, effect: entries[scope], matcher: null }));

const modeProfile = (id: string, name: string, mode: PermissionMode): PermissionProfile => ({
  id,
  name,
  mode,
  builtin: true,
  rules: ALL_SCOPES.map((scope) => ({ scope, effect: baseline(mode, scope), matcher: null })),
});

/** Mirrors `profiles::builtin_profiles` in crates/permissions. */
export const BUILTIN_PROFILES: readonly PermissionProfile[] = [
  modeProfile("builtin.plan", "Plan", "plan"),
  modeProfile("builtin.approve", "Approve", "approve"),
  modeProfile("builtin.auto", "Auto", "auto"),
  modeProfile("builtin.bypass", "Bypass", "bypass"),
  {
    id: "builtin.code_reviewer",
    name: "Code Reviewer",
    mode: "custom",
    builtin: true,
    rules: rules({
      "filesystem.read": "allow",
      "filesystem.write": "deny",
      "filesystem.outside_workspace": "ask",
      "terminal.read_only": "allow",
      "terminal.execute": "ask",
      "package.install": "deny",
      "git.read": "allow",
      "git.commit": "deny",
      "git.push": "never",
      "network.docs": "allow",
      "network.other": "ask",
      "browser.navigate": "ask",
      "browser.interact": "ask",
      "credentials.access": "deny",
      "messaging.send": "ask",
      "deploy.production": "never",
      "cloud.modify": "never",
      "billing.spend": "never",
      destructive: "never",
    }),
  },
  {
    id: "builtin.local_builder",
    name: "Local Builder",
    mode: "custom",
    builtin: true,
    rules: rules({
      "filesystem.read": "allow",
      "filesystem.write": "allow",
      "filesystem.outside_workspace": "ask",
      "terminal.read_only": "allow",
      "terminal.execute": "allow",
      "package.install": "ask",
      "git.read": "allow",
      "git.commit": "allow",
      "git.push": "ask",
      "network.docs": "allow",
      "network.other": "ask",
      "browser.navigate": "allow",
      "browser.interact": "ask",
      "credentials.access": "ask",
      "messaging.send": "never",
      "deploy.production": "never",
      "cloud.modify": "never",
      "billing.spend": "never",
      destructive: "ask",
    }),
  },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODES: readonly PermissionMode[] = ["plan", "approve", "auto", "bypass", "custom"];
const DECISIONS: readonly ApprovalDecision[] = [
  "deny",
  "approve_once",
  "approve_for_thread",
  "approve_for_workspace",
  "allow_via_rule",
];

function fail(error: IpcError): never {
  throw error;
}

const rejected = (): never =>
  fail({
    category: "internal",
    code: "ipc_rejected",
    message: "KalCode couldn't complete that request.",
    retryable: false,
  });

interface Thread {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  providerId: string;
  providerName: string;
  mode: PermissionMode;
  profileId: string | null;
}

/** A request template for seeding and for the `requestApproval` test hook. */
export interface ApprovalSeed {
  thread: Thread;
  kind: "command" | "push" | "outside_write" | "deploy" | "file_write";
}

function standing(scopes: PermissionScope[]): boolean {
  return !scopes.some((scope) => ALWAYS_ASK.includes(scope));
}

function buildRequest(seed: ApprovalSeed, createdAt: string): ApprovalView {
  const { thread } = seed;
  const common = {
    id: crypto.randomUUID(),
    permissionMode: thread.mode,
    status: "pending" as ApprovalStatus,
    resolvedDecision: null,
    resolvedAt: null,
    context: { threadName: thread.name, workspaceName: thread.workspaceName, providerName: thread.providerName },
    createdAt,
    expireReason: null,
  };
  const action = (kind: ApprovalView["action"]["action"], summary: string) => ({
    id: `toolu_${crypto.randomUUID().slice(0, 8)}`,
    threadId: thread.id,
    workspaceId: thread.workspaceId,
    providerId: thread.providerId,
    action: kind,
    summary,
    requestedAt: createdAt,
  });
  const mode = thread.mode === "custom" ? "Custom" : thread.mode.charAt(0).toUpperCase() + thread.mode.slice(1);
  const make = (
    kind: ApprovalView["action"]["action"],
    summary: string,
    scopes: PermissionScope[],
    reason: string,
    coverage: string,
  ): ApprovalView => ({
    ...common,
    action: action(kind, summary),
    decision: { effect: "ask", scopes, reason, approvable: true },
    allowedDecisions: standing(scopes)
      ? ["deny", "approve_once", "approve_for_thread", "approve_for_workspace"]
      : ["deny", "approve_once"],
    grantCoverage: coverage,
  });
  switch (seed.kind) {
    case "command":
      return make(
        { kind: "command", command: "npm install zod@4", argv: ["npm", "install", "zod@4"], cwd: "" },
        "Install zod@4 with npm",
        ["package.install"],
        `Installing packages needs your approval in ${mode} mode.`,
        "only installing zod@4 with npm",
      );
    case "file_write":
      return make(
        { kind: "file_write", path: "src/auth/session.ts" },
        "Edit src/auth/session.ts",
        ["filesystem.write"],
        `Changing files in the workspace needs your approval in ${mode} mode.`,
        "changing any file in this workspace",
      );
    case "push":
      return make(
        { kind: "command", command: "git push origin main", argv: [], cwd: "" },
        "Push main to origin",
        ["terminal.execute", "git.push"],
        "Pushing to a Git remote affects things outside this computer, so it always needs your approval. Pushes to origin.",
        "only this exact command, in this folder",
      );
    case "outside_write":
      return make(
        { kind: "file_write", path: "../shared/config.json" },
        "Write ../shared/config.json",
        ["filesystem.write", "filesystem.outside_workspace"],
        "Using files outside the workspace always needs your approval, even in Auto mode. The path resolves outside the workspace.",
        "only writes of ../shared/config.json",
      );
    case "deploy":
      return make(
        { kind: "command", command: "wrangler deploy", argv: [], cwd: "" },
        "Deploy the website with Wrangler",
        ["deploy.production", "network.other"],
        "Deploying or publishing affects things outside this computer, so it always needs your approval.",
        "only this exact command, in this folder",
      );
  }
}

export interface PermissionMemory {
  handlers: Record<PermissionCommand, Handler>;
  /** Test hook: an agent asks for approval. */
  requestApproval(kind?: ApprovalSeed["kind"]): ApprovalView;
}

export function createPermissionMemory(options: {
  emit: (event: EventPayload) => void;
  requireCore: () => void;
  seed: boolean;
}): PermissionMemory {
  const { emit, requireCore } = options;
  const workspaceId = crypto.randomUUID();
  const websiteId = crypto.randomUUID();
  const thread = (
    name: string,
    providerId: string,
    providerName: string,
    mode: PermissionMode,
    workspace = { id: workspaceId, name: "kalcode" },
  ): Thread => ({
    id: crypto.randomUUID(),
    name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    providerId,
    providerName,
    mode,
    profileId: null,
  });
  const threads: Thread[] = [
    thread("Fix the login bug", "claude-code", "Claude Code", "approve"),
    thread("Release notes", "codex", "Codex", "approve", { id: websiteId, name: "kalcode-website" }),
    thread("Refactor settings", "gemini-cli", "Gemini CLI", "auto"),
    thread("Ship the landing page", "claude-code", "Claude Code", "bypass", { id: websiteId, name: "kalcode-website" }),
  ];
  let settings: PermissionSettings = { defaultMode: "approve", defaultProfileId: null };
  const approvals: ApprovalView[] = [];
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  const request = (seed: ApprovalSeed, createdAt = new Date().toISOString()) => {
    const view = buildRequest(seed, createdAt);
    approvals.unshift(view);
    emit({
      type: "approval.requested",
      payload: {
        requestId: view.id,
        threadId: view.action.threadId,
        scopes: view.decision.scopes,
        summary: view.action.summary,
      },
    });
    return view;
  };

  if (options.seed) {
    const [login, release, refactor, landing] = threads as [Thread, Thread, Thread, Thread];
    request({ thread: landing, kind: "deploy" }, minutesAgo(9));
    request({ thread: refactor, kind: "outside_write" }, minutesAgo(6));
    request({ thread: release, kind: "push" }, minutesAgo(3));
    request({ thread: login, kind: "command" }, minutesAgo(1));
  }

  const findProfile = (id: unknown) => BUILTIN_PROFILES.find((p) => p.id === id);
  const checkMode = (mode: unknown, confirm: unknown, profileId: unknown): string | null => {
    if (typeof mode !== "string" || !MODES.includes(mode as PermissionMode)) rejected();
    if (mode === "bypass" && confirm !== true)
      fail({
        category: "permission",
        code: "bypass_confirmation_required",
        message: "Bypass needs your explicit confirmation.",
        retryable: false,
      });
    if (mode !== "custom") return null;
    if (profileId === undefined || profileId === null)
      fail({
        category: "validation",
        code: "profile_required",
        message: "Choose a Custom profile for this mode.",
        retryable: false,
      });
    const profile = findProfile(profileId);
    if (profile?.mode !== "custom")
      fail({
        category: "validation",
        code: "profile_not_found",
        message: "That Custom profile doesn't exist.",
        retryable: false,
      });
    return profile.id;
  };

  const handlers: Record<PermissionCommand, Handler> = {
    approval_list: (args) => {
      requireCore();
      const status = args.status;
      if (
        status !== undefined &&
        status !== null &&
        !["pending", "approved", "denied", "expired"].includes(String(status))
      )
        rejected();
      return approvals
        .filter((a) => status === undefined || status === null || a.status === status)
        .map((a) => ({ ...a }));
    },
    approval_decide: (args) => {
      requireCore();
      const requestId = args.requestId;
      const decision = args.decision as ApprovalDecision;
      if (typeof decision !== "string" || !DECISIONS.includes(decision)) rejected();
      if (typeof requestId !== "string" || !UUID.test(requestId))
        fail({ category: "validation", code: "invalid_id", message: "The request id is invalid.", retryable: false });
      const view = approvals.find((a) => a.id === requestId);
      if (!view)
        fail({
          category: "validation",
          code: "approval_not_found",
          message: "That approval request doesn't exist.",
          retryable: false,
        });
      if (view.status === "expired")
        fail({
          category: "permission",
          code: "approval_expired",
          message:
            "This request expired because its thread stopped or a newer request replaced it. It can't be approved.",
          retryable: false,
        });
      if (view.status !== "pending")
        fail({
          category: "permission",
          code: "approval_already_decided",
          message: "This request was already answered.",
          retryable: false,
        });
      if (!view.allowedDecisions.includes(decision))
        fail({
          category: "permission",
          code: "decision_not_allowed",
          message: "That choice isn't available for this request. You can approve it once or deny it.",
          retryable: false,
        });
      view.status = decision === "deny" ? "denied" : "approved";
      view.resolvedDecision = decision;
      view.resolvedAt = new Date().toISOString();
      emit(
        decision === "deny"
          ? { type: "approval.denied", payload: { requestId: view.id, threadId: view.action.threadId } }
          : { type: "approval.approved", payload: { requestId: view.id, threadId: view.action.threadId, decision } },
      );
      return { ...view };
    },
    permission_profiles_list: () => {
      requireCore();
      return BUILTIN_PROFILES;
    },
    thread_set_permission_mode: (args) => {
      requireCore();
      const threadId = args.threadId;
      if (typeof threadId !== "string" || !UUID.test(threadId))
        fail({ category: "validation", code: "invalid_id", message: "The thread id is invalid.", retryable: false });
      const profileId = checkMode(args.mode, args.confirmBypass, args.profileId);
      const target = threads.find((t) => t.id === threadId);
      if (!target)
        fail({
          category: "validation",
          code: "thread_not_found",
          message: "That thread doesn't exist.",
          retryable: false,
        });
      const from = target.mode;
      const to = args.mode as PermissionMode;
      if (from !== to || profileId !== target.profileId) {
        target.mode = to;
        target.profileId = profileId;
        for (const view of approvals) {
          if (view.action.threadId === threadId && view.status === "pending") {
            view.status = "expired";
            view.resolvedAt = new Date().toISOString();
            view.expireReason = "mode_changed";
            emit({ type: "approval.expired", payload: { requestId: view.id, threadId } });
          }
        }
        emit({ type: "permission.mode_changed", payload: { threadId, from, to } });
      }
      return { id: target.id, name: target.name, permissionMode: target.mode };
    },
    permission_settings_get: () => {
      requireCore();
      return settings;
    },
    permission_settings_update: (args) => {
      requireCore();
      const profileId = checkMode(args.defaultMode, args.confirmBypass, args.profileId);
      const next: PermissionSettings = { defaultMode: args.defaultMode as PermissionMode, defaultProfileId: profileId };
      if (next.defaultMode !== settings.defaultMode)
        emit({
          type: "permission.mode_changed",
          payload: { threadId: null, from: settings.defaultMode, to: next.defaultMode },
        });
      settings = next;
      return settings;
    },
  };

  return {
    handlers,
    requestApproval: (kind = "command") => {
      const target = threads[approvals.length % threads.length] as Thread;
      return request({ thread: target, kind });
    },
  };
}
