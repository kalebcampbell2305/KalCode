/**
 * Normalized display statuses (ADVANCED.md §16.3). The single mapping every surface uses —
 * Dashboard, rail, panes, notifications and KalVoice — from the 18 runtime `ThreadStatus` values
 * to the 13 display statuses. `waiting_for_dependency` is WAITING, never IDLE: its provider
 * process has not started (owner directive 2026-10-04). The types are generated from Rust; `ThreadStatus::display` /
 * `ThreadStatus::chip` / `DisplayStatus::tone` in `crates/contracts` are the same mapping, and a
 * Rust test keeps this table identical to them, row for row.
 *
 * Colour semantics (tones map to design-system tokens; status is never colour alone — always
 * text plus a glyph): working green; waiting / waiting for you / permission required amber; idle, starting and
 * offline muted; done high-contrast neutral; failed red; paused amber; recovering blue.
 */
import type { DashboardChip, DisplayQualifier, DisplayStatus, StatusTone, ThreadStatus } from "./generated/index.ts";

export interface DisplayInfo {
  status: DisplayStatus;
  qualifier: DisplayQualifier | null;
  chip: DashboardChip;
}

export interface ThreadDisplayFacts {
  /** Whether the provider can resume its own historical conversation. */
  resumable: boolean;
}

export interface ThreadDisplayInfo extends DisplayInfo {
  /** Truthful, ready-to-render qualifier text for this specific thread. */
  qualifierLabel: string | null;
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
  waiting_for_dependency: { status: "waiting", qualifier: "waiting_on_dependency", chip: "working" },
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
  waiting: "waiting",
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
  waiting: "WAITING",
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
export function displayStatusOf(status: ThreadStatus): DisplayInfo;
/** The display status plus a truthful qualifier when the caller has thread facts. */
export function displayStatusOf(status: ThreadStatus, facts: ThreadDisplayFacts): ThreadDisplayInfo;
export function displayStatusOf(status: ThreadStatus, facts?: ThreadDisplayFacts): DisplayInfo | ThreadDisplayInfo {
  const display: DisplayInfo = DISPLAY_STATUS_OF[status];
  if (!facts) return display;
  if (status === "interrupted" && !facts.resumable) {
    return { ...display, qualifier: null, qualifierLabel: "stopped · historical" };
  }
  return {
    ...display,
    qualifierLabel: display.qualifier ? DISPLAY_QUALIFIER_LABEL[display.qualifier] : null,
  };
}
