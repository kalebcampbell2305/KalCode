import type { EventEnvelope } from "@kalcode/protocol";

/**
 * Client-side view of the event log: newest-first, deduplicated by `seq`, bounded in size.
 * Live events and backfilled history may arrive in any order and may overlap; merging is
 * idempotent. Implements the useSyncExternalStore contract.
 */
export class EventFeed {
  private events: EventEnvelope[] = [];
  private readonly listeners = new Set<() => void>();
  private exhausted = false;

  constructor(private readonly capacity = 500) {}

  getSnapshot = (): readonly EventEnvelope[] => this.events;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** True once history has been paged back to the first event. */
  get reachedStart(): boolean {
    return this.exhausted;
  }

  /** The oldest loaded `seq`, used as the cursor for loading older history. */
  get oldestSeq(): number | undefined {
    return this.events.at(-1)?.seq;
  }

  merge(incoming: readonly EventEnvelope[]): void {
    if (incoming.length === 0) return;
    const bySeq = new Map<number, EventEnvelope>();
    for (const event of this.events) bySeq.set(event.seq, event);
    let changed = false;
    for (const event of incoming) {
      if (!bySeq.has(event.seq)) {
        bySeq.set(event.seq, event);
        changed = true;
      }
    }
    if (!changed) return;
    this.events = [...bySeq.values()].sort((a, b) => b.seq - a.seq).slice(0, this.capacity);
    this.emit();
  }

  /** Records that a history page returned fewer rows than requested. */
  markReachedStart(): void {
    if (this.exhausted) return;
    this.exhausted = true;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
