import type { EventEnvelope } from "@kalcode/protocol";
import { describe, expect, it, vi } from "vitest";
import { EventFeed } from "./eventFeed.ts";

function event(seq: number): EventEnvelope {
  return {
    id: `id-${seq}`,
    seq,
    version: 1,
    occurredAt: "2026-09-24T00:00:00.000Z",
    source: "core",
    correlation: { workspaceId: null, threadId: null, missionId: null, providerId: null, requestId: null },
    type: "settings.changed",
    payload: { keys: [] },
  };
}

const seqs = (feed: EventFeed) => feed.getSnapshot().map((e) => e.seq);

describe("EventFeed", () => {
  it("orders newest first regardless of arrival order", () => {
    const feed = new EventFeed();
    feed.merge([event(2)]);
    feed.merge([event(5), event(1)]);
    feed.merge([event(3)]);
    expect(seqs(feed)).toEqual([5, 3, 2, 1]);
  });

  it("deduplicates overlapping live and backfilled events", () => {
    const feed = new EventFeed();
    feed.merge([event(4), event(5)]); // live events that arrived during backfill
    feed.merge([event(5), event(4), event(3)]); // backfill page
    expect(seqs(feed)).toEqual([5, 4, 3]);
  });

  it("notifies only when something changed and keeps snapshot identity otherwise", () => {
    const feed = new EventFeed();
    const listener = vi.fn();
    feed.subscribe(listener);
    feed.merge([event(1)]);
    const snapshot = feed.getSnapshot();
    feed.merge([event(1)]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(feed.getSnapshot()).toBe(snapshot);
  });

  it("is bounded to its capacity, keeping the newest", () => {
    const feed = new EventFeed(3);
    feed.merge([1, 2, 3, 4, 5].map(event));
    expect(seqs(feed)).toEqual([5, 4, 3]);
    expect(feed.oldestSeq).toBe(3);
  });

  it("tracks when history is exhausted", () => {
    const feed = new EventFeed();
    expect(feed.reachedStart).toBe(false);
    feed.markReachedStart();
    expect(feed.reachedStart).toBe(true);
  });

  it("stops notifying after unsubscribe", () => {
    const feed = new EventFeed();
    const listener = vi.fn();
    const unsubscribe = feed.subscribe(listener);
    unsubscribe();
    feed.merge([event(1)]);
    expect(listener).not.toHaveBeenCalled();
  });
});
