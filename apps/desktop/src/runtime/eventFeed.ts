import type { EventEnvelope } from "@kalcode/protocol";

export interface EventFeedSnapshot {
  /** Newest first, deduplicated by `seq`. */
  readonly events: readonly EventEnvelope[];
  /** True once history has been paged back to the first event. */
  readonly reachedStart: boolean;
}

/**
 * Client-side view of the event log. Live events and backfilled history may arrive in any
 * order and may overlap; merging is idempotent. Live growth is bounded by `capacity` (oldest
 * dropped first); history the user explicitly pages in raises the bound so it is never
 * immediately discarded. Implements the useSyncExternalStore contract.
 */
export class EventFeed {
  private snapshot: EventFeedSnapshot = { events: [], reachedStart: false };
  private readonly listeners = new Set<() => void>();

  constructor(private capacity = 500) {}

  getSnapshot = (): EventFeedSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get reachedStart(): boolean {
    return this.snapshot.reachedStart;
  }

  /** The oldest loaded `seq`, used as the cursor for loading older history. */
  get oldestSeq(): number | undefined {
    return this.snapshot.events.at(-1)?.seq;
  }

  /** Live events and the initial backfill. */
  merge(incoming: readonly EventEnvelope[]): void {
    this.apply(incoming);
  }

  /** An older history page the user asked for: grows the bound to keep it. */
  mergeOlder(page: readonly EventEnvelope[]): void {
    const loaded = new Set(this.snapshot.events.map((event) => event.seq));
    for (const event of page) loaded.add(event.seq);
    this.capacity = Math.max(this.capacity, loaded.size);
    this.apply(page);
  }

  markReachedStart(): void {
    if (this.snapshot.reachedStart) return;
    this.snapshot = { ...this.snapshot, reachedStart: true };
    this.emit();
  }

  private apply(incoming: readonly EventEnvelope[]): void {
    if (incoming.length === 0) return;
    const bySeq = new Map<number, EventEnvelope>();
    for (const event of this.snapshot.events) bySeq.set(event.seq, event);
    let changed = false;
    for (const event of incoming) {
      if (!bySeq.has(event.seq)) {
        bySeq.set(event.seq, event);
        changed = true;
      }
    }
    if (!changed) return;
    const events = [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, this.capacity);
    // Capacity eviction removes the start of the loaded history, so older pages must
    // become available again even if a previous read reached the beginning of the log.
    const reachedStart = this.snapshot.reachedStart && bySeq.size <= this.capacity;
    this.snapshot = { events, reachedStart };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
