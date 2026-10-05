import type { ThreadSummary } from "@kalcode/protocol";
import { canStartAnyway } from "../../threads/model.ts";
import { isLive, isTerminal } from "./status.ts";

/**
 * Thread actions the Dashboard offers, each bound to one Z3 contract command:
 *   open      → navigates to the thread (Threads surface)
 *   interrupt → `thread_interrupt` (pause the current turn; the thread stays open)
 *   resume    → `thread_resume` (continue a paused, stopped or offline thread)
 *   retry     → `thread_resume` on a failed thread (run the failed turn again)
 *   start_anyway → `thread_start_anyway` (the person skips a Resource Governor hold; offered
 *               while a launch waits for resources or once that wait ran out, as in the pane)
 *   stop      → `thread_stop` (end the thread's process; asks for confirmation)
 *   archive   → `thread_archive` (hide a finished or idle thread from the Dashboard)
 *   unarchive → `thread_unarchive` (restore an archived thread; offered only on archived cards)
 */
export type ThreadAction =
  | "open"
  | "interrupt"
  | "resume"
  | "retry"
  | "start_anyway"
  | "stop"
  | "archive"
  | "unarchive";

export const ACTION_LABELS: Record<ThreadAction, string> = {
  open: "Open",
  interrupt: "Pause",
  resume: "Resume",
  retry: "Retry",
  start_anyway: "Start Anyway",
  stop: "Stop",
  archive: "Archive",
  unarchive: "Unarchive",
};

/** What `availableActions` reads: the status, and the problem a resource hold leaves. */
export type ActionableThread = Pick<ThreadSummary, "status"> &
  Partial<Pick<ThreadSummary, "error" | "currentActivity">>;

/**
 * The actions valid for a thread, in display order. Never offers an invalid action.
 * Mirrors `threadActions` on the Threads surface (and the native rules): Pause only while a turn
 * runs or waits for approval; Start Anyway only while a launch is held for system resources or
 * once that wait ran out (`canStartAnyway`); Stop only while a turn, a start or a wait (for
 * approval, for system resources, or in pause) is in progress; a quiet open thread (idle, or
 * waiting for the user's reply) is archived instead, which ends its idle session.
 */
export function availableActions(thread: ActionableThread): ThreadAction[] {
  const { status } = thread;
  const actions: ThreadAction[] = ["open"];
  if ((isLive(status) && status !== "starting" && status !== "recovering") || status === "waiting_for_permission") {
    actions.push("interrupt");
  }
  if (status === "paused" || status === "interrupted" || status === "offline") actions.push("resume");
  if (status === "failed") actions.push("retry");
  if (canStartAnyway(thread)) actions.push("start_anyway");
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
