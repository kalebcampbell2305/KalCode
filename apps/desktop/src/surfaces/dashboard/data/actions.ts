import type { ThreadStatus } from "@kalcode/protocol";
import { isLive, isTerminal } from "./status.ts";

/**
 * Thread actions the Dashboard offers, each bound to one Z3 contract command:
 *   open      → navigates to the thread (Threads surface)
 *   interrupt → `thread_interrupt` (pause the current turn; the thread stays open)
 *   resume    → `thread_resume` (continue a paused, stopped or offline thread)
 *   retry     → `thread_resume` on a failed thread (run the failed turn again)
 *   stop      → `thread_stop` (end the thread's process; asks for confirmation)
 *   archive   → `thread_archive` (hide a finished or idle thread from the Dashboard)
 *   unarchive → `thread_unarchive` (restore an archived thread; offered only on archived cards)
 */
export type ThreadAction = "open" | "interrupt" | "resume" | "retry" | "stop" | "archive" | "unarchive";

export const ACTION_LABELS: Record<ThreadAction, string> = {
  open: "Open",
  interrupt: "Pause",
  resume: "Resume",
  retry: "Retry",
  stop: "Stop",
  archive: "Archive",
  unarchive: "Unarchive",
};

/**
 * The actions valid for a thread in `status`, in display order. Never offers an invalid action.
 * Mirrors `threadActions` on the Threads surface (and the native rules): Pause only while a turn
 * runs or waits for approval; Stop only while a turn, a start or a wait (for approval, for
 * system resources, or in pause) is in progress; a quiet open thread (idle, or waiting for the
 * user's reply) is archived instead, which ends its idle session.
 */
export function availableActions(status: ThreadStatus): ThreadAction[] {
  const actions: ThreadAction[] = ["open"];
  if ((isLive(status) && status !== "starting" && status !== "recovering") || status === "waiting_for_permission") {
    actions.push("interrupt");
  }
  if (status === "paused" || status === "interrupted" || status === "offline") actions.push("resume");
  if (status === "failed") actions.push("retry");
  if (
    isLive(status) ||
    status === "waiting_for_permission" ||
    status === "waiting_for_dependency" ||
    status === "paused"
  ) {
    actions.push("stop");
  }
  if (isTerminal(status) || status === "idle" || status === "waiting_for_user") actions.push("archive");
  return actions;
}
