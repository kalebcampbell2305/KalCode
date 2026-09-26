export interface DictationCapture<T> {
  readonly sequence: number;
  readonly target: T | null;
}

export interface DictationSession<T> {
  readonly sessionId: string;
  readonly target: T | null;
  readonly signal: AbortSignal;
}

interface SessionEntry<T> extends DictationSession<T> {
  readonly controller: AbortController;
  claimed: boolean;
}

/**
 * Window-local dictation lifecycle. A target is snapshotted before capture starts, bound to one
 * native session, and claimable exactly once. Cancellation aborts any queued delivery.
 */
export class DictationSessions<T> {
  readonly #sessions = new Map<string, SessionEntry<T>>();
  #focusedTarget: T | null = null;
  #pendingCapture: DictationCapture<T> | null = null;
  #sequence = 0;

  get size(): number {
    return this.#sessions.size;
  }

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  setFocusedTarget(target: T | null): void {
    this.#focusedTarget = target;
  }

  /** Freezes the current target before an explicit asynchronous capture start. */
  captureFocusedTarget(): DictationCapture<T> {
    const capture = { sequence: ++this.#sequence, target: this.#focusedTarget };
    this.#pendingCapture = capture;
    return capture;
  }

  abandonCapture(capture: DictationCapture<T>): void {
    if (this.#pendingCapture?.sequence === capture.sequence) this.#pendingCapture = null;
  }

  abandonPendingCapture(): void {
    this.#pendingCapture = null;
  }

  /** Binds the frozen explicit target, or the last focus-tracked keyboard target, exactly once. */
  open(sessionId: string, capture?: DictationCapture<T>): DictationSession<T> | null {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing.signal.aborted ? null : existing;
    if (capture && this.#pendingCapture?.sequence !== capture.sequence) return null;

    // Native capture is single-session. A newer start makes every unfinished older result stale.
    for (const entry of this.#sessions.values()) entry.controller.abort();
    this.#sessions.clear();

    const selected = capture ?? this.#pendingCapture;
    if (selected && this.#pendingCapture?.sequence === selected.sequence) this.#pendingCapture = null;
    const controller = new AbortController();
    const entry: SessionEntry<T> = {
      sessionId,
      target: selected ? selected.target : this.#focusedTarget,
      signal: controller.signal,
      controller,
      claimed: false,
    };
    this.#sessions.set(sessionId, entry);
    return entry;
  }

  /** Returns one immutable delivery handle. Duplicate and unknown results are ignored. */
  claim(sessionId: string): DictationSession<T> | null {
    const entry = this.#sessions.get(sessionId);
    if (!entry || entry.claimed || entry.signal.aborted) return null;
    entry.claimed = true;
    return entry;
  }

  cancel(sessionId: string): boolean {
    const entry = this.#sessions.get(sessionId);
    if (!entry) return false;
    this.#sessions.delete(sessionId);
    entry.controller.abort();
    return true;
  }

  finish(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  reset(): void {
    this.#pendingCapture = null;
    for (const entry of this.#sessions.values()) entry.controller.abort();
    this.#sessions.clear();
  }
}
