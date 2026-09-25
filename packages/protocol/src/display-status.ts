/**
 * Normalized display statuses (ADVANCED.md §16.3). The single mapping every surface uses —
 * Dashboard, rail, panes, notifications and KalVoice — from the 18 runtime `ThreadStatus` values
 * to the 12 display statuses. The types are generated from Rust; `ThreadStatus::display` /
 * `ThreadStatus::chip` / `DisplayStatus::tone` in `crates/contracts` are the same mapping, and a
 * Rust test keeps this table identical to them, row for row.
 *
 * Colour semantics (tones map to design-system tokens; status is never colour alone — always
 * text plus a glyph): working green; waiting / permission required neutral grey; idle, starting
 * and offline muted; done high-contrast neutral; failed red; paused amber (the only amber);
 * recovering blue.
 */
import type { DashboardChip, DisplayQualifier, DisplayStatus, StatusTone, ThreadStatus } from "./generated/index.ts";

export interface DisplayInfo {
  status: DisplayStatus;
  qualifier: DisplayQualifier | null;
  chip: DashboardChip;
}

export const DISPLAY_STATUS_OF = {
  starting: { status: "starting", qualifier: null, chip: "working" },
  active: { status: "working", qualifier: null, chip: "working" },
  thinking: { status: "working", qualifier: null, chip: "working" },
  running_tool: { status: "working", qualifier: null, chip: "working" },
  running_command: { status: "working", qualifier: null, chip: "working" },
  editing: { status: "working", qualifier: null, chip: "working" },
  testing: { status: "testing", qualifier: null, chip: "working" },
  reviewing: { status: "reviewing", qualifier: null, chip: "working" },
  idle: { status: "idle", qualifier: null, chip: "idle" },
  waiting_for_permission: { status: "permission_required", qualifier: null, chip: "waiting_for_you" },
  waiting_for_user: { status: "waiting_for_you", qualifier: null, chip: "waiting_for_you" },
  waiting_for_dependency: { status: "idle", qualifier: "waiting_on_dependency", chip: "idle" },
  paused: { status: "paused", qualifier: null, chip: "idle" },
  completed: { status: "done", qualifier: null, chip: "done" },
  failed: { status: "failed", qualifier: null, chip: "waiting_for_you" },
  interrupted: { status: "idle", qualifier: "stopped_resumable", chip: "idle" },
  recovering: { status: "recovering", qualifier: null, chip: "working" },
  offline: { status: "offline", qualifier: null, chip: "idle" },
} as const satisfies Record<ThreadStatus, DisplayInfo>;

export const DISPLAY_STATUS_TONE = {
  starting: "muted",
  working: "working",
  testing: "working",
  reviewing: "working",
  permission_required: "waiting",
  waiting_for_you: "waiting",
  idle: "muted",
  paused: "paused",
  done: "done",
  failed: "failed",
  recovering: "recovering",
  offline: "muted",
} as const satisfies Record<DisplayStatus, StatusTone>;

export const DISPLAY_STATUS_LABEL = {
  starting: "STARTING",
  working: "WORKING",
  testing: "TESTING",
  reviewing: "REVIEWING",
  permission_required: "PERMISSION REQUIRED",
  waiting_for_you: "WAITING FOR YOU",
  idle: "IDLE",
  paused: "PAUSED",
  done: "DONE",
  failed: "FAILED",
  recovering: "RECOVERING",
  offline: "OFFLINE",
} as const satisfies Record<DisplayStatus, string>;

export const DISPLAY_QUALIFIER_LABEL = {
  waiting_on_dependency: "waiting on another task",
  stopped_resumable: "stopped · resumable",
} as const satisfies Record<DisplayQualifier, string>;

/** The display status, qualifier and Dashboard chip of a runtime status. */
export function displayStatusOf(status: ThreadStatus): DisplayInfo {
  return DISPLAY_STATUS_OF[status];
}
