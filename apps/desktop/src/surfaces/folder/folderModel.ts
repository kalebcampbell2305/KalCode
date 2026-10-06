/**
 * Pure helpers for the folder/project surface: Git status letters and words, file-size text,
 * and recent files merged from the event log (paths only; contents are never read).
 */
import {
  agentStateOf,
  type EventEnvelope,
  type GitFileChange,
  isAgentBusy,
  type StatusFile,
  type ThreadSummary,
} from "@kalcode/protocol";

export interface ChangeInfo {
  /** One-letter code, as in `git status --short`. */
  letter: string;
  /** Words for screen readers and tooltips. */
  words: string;
  tone: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflict";
}

const CHANGE: Record<GitFileChange, ChangeInfo> = {
  added: { letter: "A", words: "added", tone: "added" },
  modified: { letter: "M", words: "modified", tone: "modified" },
  deleted: { letter: "D", words: "deleted", tone: "deleted" },
  renamed: { letter: "R", words: "renamed", tone: "renamed" },
  copied: { letter: "C", words: "copied", tone: "added" },
  type_changed: { letter: "T", words: "type changed", tone: "modified" },
  unmerged: { letter: "U", words: "unmerged", tone: "conflict" },
};

/** The most important change of a status line (conflict > staged/unstaged > untracked). */
export function changeOf(file: StatusFile): ChangeInfo & { staged: boolean } {
  if (file.conflict) return { letter: "U", words: "conflict", tone: "conflict", staged: false };
  if (file.untracked) return { letter: "?", words: "untracked", tone: "untracked", staged: false };
  const change = file.unstaged ?? file.staged;
  const info = change ? CHANGE[change] : CHANGE.modified;
  return { ...info, staged: file.unstaged === null && file.staged !== null };
}

export function fileSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Splits a workspace-relative path into its folder and name. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { dir: "", name: path } : { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}

export interface RecentFile {
  path: string;
  change: "created" | "modified" | "deleted";
  at: string;
  threadId: string | null;
}

/** Distinct files from `file.*` events, newest first. */
export function recentFilesFrom(events: readonly EventEnvelope[], limit = 12): RecentFile[] {
  const seen = new Set<string>();
  const out: RecentFile[] = [];
  const sorted = [...events].sort((a, b) => b.seq - a.seq);
  for (const event of sorted) {
    if (event.type !== "file.created" && event.type !== "file.modified" && event.type !== "file.deleted") continue;
    const { path, threadId } = event.payload;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({
      path,
      change: event.type === "file.created" ? "created" : event.type === "file.deleted" ? "deleted" : "modified",
      at: event.occurredAt,
      threadId: threadId ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The project page's agent counts, in the shared agent state (the same as the native rail's
 * `is_working` / `needs_you`): Working is starting, working or testing; Needs you is an approval or
 * a reply, never a failure.
 */
export function projectAgentCounts(
  threads: readonly Pick<ThreadSummary, "status" | "currentActivity" | "pendingApprovals">[],
): { working: number; needs: number } {
  let working = 0;
  let needs = 0;
  for (const thread of threads) {
    const state = agentStateOf(thread);
    if (isAgentBusy(state)) working += 1;
    if (state === "needs_you") needs += 1;
  }
  return { working, needs };
}
