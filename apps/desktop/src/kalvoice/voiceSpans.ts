/**
 * What KalVoice typed into each thread composer since its last send or clear, so "clear that"
 * removes exactly that text and never anything the person typed. Positions only, keyed by thread
 * id, in this window's memory; the text itself is never kept.
 *
 * Every voice insert records its span and a snapshot of the box. Anything else that changed the
 * box since (the person typing) is found by diffing the snapshot with the box now: spans before or
 * after that edit move with it, but an edit inside or touching a span means KalVoice can no longer
 * tell exactly which characters it typed, and the clear is refused.
 */

interface Span {
  start: number;
  end: number;
}

interface Tracked {
  spans: Span[];
  /** The box right after the last voice insert. */
  snapshot: string;
  /** A span can't be identified exactly any more (until the next send or clear). */
  lost: boolean;
}

const tracked = new Map<string, Tracked>();

/** The single changed region between two strings: `[start, oldEnd)` became `[start, newEnd)`. */
function changedRegion(before: string, after: string): { start: number; oldEnd: number; newEnd: number } | null {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before[start] === after[start]) start += 1;
  let suffix = 0;
  while (suffix < limit - start && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
    suffix += 1;
  }
  return { start, oldEnd: before.length - suffix, newEnd: after.length - suffix };
}

/**
 * Moves `spans` across one edit. `touching` decides whether an edit that only touches a span's
 * edge (typing right before or after it) counts as a conflict. Null on conflict.
 */
function shift(
  spans: readonly Span[],
  start: number,
  oldEnd: number,
  newEnd: number,
  touching: boolean,
): Span[] | null {
  const delta = newEnd - oldEnd;
  const next: Span[] = [];
  for (const span of spans) {
    const before = touching ? span.end < start : span.end <= start;
    const after = touching ? span.start > oldEnd : span.start >= oldEnd;
    if (before) next.push({ ...span });
    else if (after) next.push({ start: span.start + delta, end: span.end + delta });
    else return null;
  }
  return next;
}

/** The spans in `current`, or null when the person's edits since the snapshot touch one. */
function rebase(entry: Tracked, current: string): Span[] | null {
  if (entry.lost) return null;
  const edit = changedRegion(entry.snapshot, current);
  if (!edit) return entry.spans.map((span) => ({ ...span }));
  return shift(entry.spans, edit.start, edit.oldEnd, edit.newEnd, true);
}

/**
 * Records one voice insert into `threadId`'s composer: the box was `before`, `[start, end)` was
 * replaced by `inserted`, and the box is now `after`.
 */
export function recordVoiceInsertion(
  threadId: string,
  change: { before: string; start: number; end: number; inserted: string; after: string },
): void {
  const entry = tracked.get(threadId) ?? { spans: [], snapshot: change.before, lost: false };
  let spans = rebase(entry, change.before);
  // The insert itself may sit right next to earlier voice text (dictating twice in a row).
  if (spans) spans = shift(spans, change.start, change.end, change.start + change.inserted.length, false);
  tracked.set(threadId, {
    spans: spans ? [...spans, { start: change.start, end: change.start + change.inserted.length }] : [],
    snapshot: change.after,
    lost: spans === null,
  });
}

/** The composer was sent or emptied: nothing KalVoice typed is left in it. */
export function forgetVoiceText(threadId: string): void {
  tracked.delete(threadId);
}

export type VoiceClearPlan =
  | { kind: "nothing" }
  | { kind: "ambiguous" }
  | { kind: "clear"; value: string; caret: number };

/** What "clear that" does to a composer whose box now reads `current`. Changes nothing itself. */
export function planVoiceClear(threadId: string, current: string): VoiceClearPlan {
  const entry = tracked.get(threadId);
  if (!entry || current === "") return { kind: "nothing" };
  const spans = rebase(entry, current);
  if (!spans) return { kind: "ambiguous" };
  const live = spans.filter((span) => span.end > span.start).sort((a, b) => b.start - a.start);
  if (live.length === 0) return { kind: "nothing" };
  let value = current;
  for (const span of live) value = value.slice(0, span.start) + value.slice(span.end);
  return { kind: "clear", value, caret: live[live.length - 1]?.start ?? 0 };
}

/** Test-only: forget every composer. */
export function resetVoiceSpansForTests(): void {
  tracked.clear();
}
