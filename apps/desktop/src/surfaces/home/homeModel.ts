/**
 * Pure helpers for the returning-user home: the one-line summary under the greeting and the
 * date eyebrow. Everything shown comes from `home_summary` (real state); nothing is invented.
 */
import type { HomeSummary } from "@kalcode/protocol";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 working · 1 needs you · 3 finished since your last visit", or a plain empty sentence. */
export function summaryLine(
  summary: Pick<
    HomeSummary,
    "runningCount" | "needsYouCount" | "finishedSinceLastVisit" | "firstRun" | "threadCount" | "workspaceCount"
  >,
): string {
  if (summary.firstRun) return "Nothing has run yet. This page fills in as you work.";
  const parts: string[] = [];
  if (summary.needsYouCount > 0) parts.push(`${plural(summary.needsYouCount, "thread needs", "threads need")} you`);
  if (summary.runningCount > 0) parts.push(`${summary.runningCount} working`);
  const finished = summary.finishedSinceLastVisit.length;
  if (finished > 0) parts.push(`${finished} finished since your last visit`);
  if (parts.length > 0) return parts.join(" · ");
  if (summary.threadCount === 0) {
    return `${plural(summary.workspaceCount, "workspace", "workspaces")}, no threads yet.`;
  }
  return "Nothing is running and nothing needs you right now.";
}

/** "Thursday, September 25". */
export function dateEyebrow(now: Date = new Date()): string {
  return now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
