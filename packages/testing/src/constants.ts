/**
 * Every value of the contract enums, checked at compile time: when a Rust enum gains a variant,
 * regenerating the protocol types makes `pnpm typecheck` fail here until fixtures cover it.
 */
import type {
  ActionKind,
  ApprovalDecision,
  ApprovalStatus,
  DetectionState,
  PermissionMode,
  ThreadStatus,
} from "@kalcode/protocol";

/** Compiles only when `List` names every member of `Union`. */
type Exhaustive<Union, List extends readonly Union[]> = [Exclude<Union, List[number]>] extends [never] ? true : false;

/** All 18 normalized thread states (directive §7.3), in lifecycle order. */
export const THREAD_STATUSES = [
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
] as const satisfies readonly ThreadStatus[];

/** Mirrors `ThreadStatus::is_live` (Rust). */
export const LIVE_THREAD_STATUSES = [
  "starting",
  "active",
  "thinking",
  "running_tool",
  "running_command",
  "editing",
  "testing",
  "reviewing",
  "recovering",
] as const satisfies readonly ThreadStatus[];

/** Mirrors `ThreadStatus::needs_attention` (Rust). */
export const ATTENTION_THREAD_STATUSES = [
  "waiting_for_permission",
  "waiting_for_user",
  "failed",
] as const satisfies readonly ThreadStatus[];

/** Mirrors `ThreadStatus::is_terminal` (Rust). */
export const TERMINAL_THREAD_STATUSES = [
  "completed",
  "failed",
  "interrupted",
] as const satisfies readonly ThreadStatus[];

export const PERMISSION_MODES = [
  "plan",
  "approve",
  "auto",
  "bypass",
  "custom",
] as const satisfies readonly PermissionMode[];

export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
] as const satisfies readonly ApprovalStatus[];

export const APPROVAL_DECISIONS = [
  "deny",
  "approve_once",
  "approve_for_thread",
  "approve_for_workspace",
  "allow_via_rule",
] as const satisfies readonly ApprovalDecision[];

export const DETECTION_STATES = [
  "installed",
  "not_installed",
  "outdated",
  "error",
] as const satisfies readonly DetectionState[];

export const ACTION_KINDS = [
  "file_read",
  "file_write",
  "file_delete",
  "command",
  "package_install",
  "git",
  "network",
  "browser",
  "deploy",
  "tool",
] as const satisfies readonly ActionKind["kind"][];

const exhaustive: [
  Exhaustive<ThreadStatus, typeof THREAD_STATUSES>,
  Exhaustive<PermissionMode, typeof PERMISSION_MODES>,
  Exhaustive<ApprovalStatus, typeof APPROVAL_STATUSES>,
  Exhaustive<ApprovalDecision, typeof APPROVAL_DECISIONS>,
  Exhaustive<DetectionState, typeof DETECTION_STATES>,
  Exhaustive<ActionKind["kind"], typeof ACTION_KINDS>,
] = [true, true, true, true, true, true];
void exhaustive;
