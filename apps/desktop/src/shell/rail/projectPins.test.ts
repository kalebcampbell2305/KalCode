import type { RailState, WorkspaceRailEntry } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { projectPinChange } from "./projectPins.ts";

function entry(
  workspaceId: string,
  {
    pinned = false,
    groupId = null,
    available = true,
    lastActivityAt = "2026-01-01T00:00:00.000Z",
  }: Partial<Pick<WorkspaceRailEntry, "pinned" | "groupId" | "available" | "lastActivityAt">> = {},
): WorkspaceRailEntry {
  return {
    workspaceId,
    name: workspaceId,
    folderName: workspaceId,
    displayPath: `C:\\${workspaceId}`,
    location: "local",
    available,
    active: false,
    pinned,
    archived: false,
    groupId,
    collapsed: false,
    indexMessages: false,
    providers: [],
    threads: 0,
    working: 0,
    needsYou: 0,
    lastOpenedAt: lastActivityAt,
    lastActivityAt,
  };
}

function state(overrides: Partial<RailState> = {}): RailState {
  return {
    pinned: [],
    recent: [],
    groups: [],
    archived: [],
    collapsedSections: [],
    persistent: true,
    ...overrides,
  };
}

const ids = (entries: WorkspaceRailEntry[]) => entries.map((item) => item.workspaceId);

describe("projectPinChange", () => {
  it("pins at the end of the manual pin order and unpins below the existing recency order", () => {
    const source = state({
      pinned: [
        entry("manual-first", { pinned: true, lastActivityAt: "2026-01-01T00:00:00.000Z" }),
        entry("manual-second", { pinned: true, lastActivityAt: "2026-04-01T00:00:00.000Z" }),
      ],
      recent: [
        entry("recent-first", { lastActivityAt: "2026-03-01T00:00:00.000Z" }),
        entry("recent-second", { lastActivityAt: "2026-02-01T00:00:00.000Z" }),
      ],
    });

    const pinned = projectPinChange(source, "recent-first", true);
    expect(ids(pinned.pinned)).toEqual(["manual-first", "manual-second", "recent-first"]);
    expect(ids(pinned.recent)).toEqual(["recent-second"]);
    expect(pinned.pinned.at(-1)).toMatchObject({ pinned: true, archived: false });

    const unpinned = projectPinChange(pinned, "manual-second", false);
    expect(ids(unpinned.pinned)).toEqual(["manual-first", "recent-first"]);
    expect(ids(unpinned.recent)).toEqual(["recent-second", "manual-second"]);
    expect(unpinned.recent.at(-1)?.pinned).toBe(false);
    expect(ids(source.pinned)).toEqual(["manual-first", "manual-second"]);
    expect(ids(source.recent)).toEqual(["recent-first", "recent-second"]);
  });

  it("reorders only pinned projects without sorting them by activity", () => {
    const source = state({
      pinned: [
        entry("first", { pinned: true, lastActivityAt: "2026-01-01T00:00:00.000Z" }),
        entry("second", { pinned: true, lastActivityAt: "2026-03-01T00:00:00.000Z" }),
        entry("third", { pinned: true, lastActivityAt: "2026-02-01T00:00:00.000Z" }),
      ],
      recent: [entry("recent-newest", { lastActivityAt: "2026-04-01T00:00:00.000Z" })],
    });

    const projected = projectPinChange(source, "third", 0);
    expect(ids(projected.pinned)).toEqual(["third", "first", "second"]);
    expect(ids(projected.recent)).toEqual(["recent-newest"]);
    expect(projectPinChange(projected, "second", 1).pinned.map((item) => item.workspaceId)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  it("keeps repeated boolean pin changes idempotent without moving or duplicating projects", () => {
    const source = state({
      pinned: [
        entry("first", { pinned: true }),
        entry("manual-middle", { pinned: true }),
        entry("last", { pinned: true }),
      ],
      recent: [entry("recent")],
    });

    const repeatedPin = projectPinChange(source, "manual-middle", true);
    expect(repeatedPin).toBe(source);
    expect(ids(repeatedPin.pinned)).toEqual(["first", "manual-middle", "last"]);

    const unpinned = projectPinChange(source, "manual-middle", false);
    const repeatedUnpin = projectPinChange(unpinned, "manual-middle", false);
    expect(repeatedUnpin).toBe(unpinned);
    expect(ids(repeatedUnpin.pinned)).toEqual(["first", "last"]);
    expect(ids(repeatedUnpin.recent)).toEqual(["recent", "manual-middle"]);
    expect(repeatedUnpin.recent.filter((item) => item.workspaceId === "manual-middle")).toHaveLength(1);
  });

  it("keeps an unavailable project truthful when it is pinned", () => {
    const unavailable = entry("moved-project", { available: false });
    const projected = projectPinChange(state({ recent: [unavailable] }), unavailable.workspaceId, true);

    expect(projected.pinned).toEqual([{ ...unavailable, pinned: true, archived: false }]);
    expect(projected.pinned[0]?.available).toBe(false);
  });
});
