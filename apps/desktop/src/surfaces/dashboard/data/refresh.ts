import type { EventEnvelope } from "@kalcode/protocol";

/** The Dashboard's data sources, each refreshed by the event types that can change it. */
export type DashboardResource = "threads" | "approvals" | "terminals";

/**
 * Which resources an event invalidates. Threads carry status, activity, pending-approval and
 * files-changed counters, so thread, tool, file, approval and permission events all refresh them.
 */
export function resourcesFor(type: EventEnvelope["type"]): DashboardResource[] {
  if (type.startsWith("thread.") || type.startsWith("tool.") || type.startsWith("file.") || type === "agent.message") {
    return ["threads"];
  }
  if (type.startsWith("approval.")) return ["approvals", "threads"];
  if (type === "permission.mode_changed") return ["threads", "approvals"];
  if (type.startsWith("shell.")) return ["terminals"];
  if (type.startsWith("workspace.")) return ["threads", "terminals"];
  if (type === "provider.connected" || type === "provider.disconnected" || type === "provider.error") {
    return ["threads"];
  }
  return [];
}

/**
 * Tracks the newest event seen and reports which resources need a refresh when the feed grows.
 * Events at or below the watermark (backfill, duplicates, older pages) never trigger a refresh.
 */
export class RefreshTracker {
  private watermark: number;

  constructor(initialSeq = 0) {
    this.watermark = initialSeq;
  }

  /** `events` newest first, as the EventFeed stores them. */
  observe(events: readonly EventEnvelope[]): Set<DashboardResource> {
    const stale = new Set<DashboardResource>();
    let newest = this.watermark;
    for (const event of events) {
      if (event.seq <= this.watermark) break;
      newest = Math.max(newest, event.seq);
      for (const resource of resourcesFor(event.type)) stale.add(resource);
    }
    this.watermark = newest;
    return stale;
  }

  get seq(): number {
    return this.watermark;
  }
}
