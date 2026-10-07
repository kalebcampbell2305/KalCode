import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDockLayout,
  DEFAULT_DOCK_WIDTH,
  type DockTabId,
  defaultDockLayout,
  dockStorageKey,
  LEGACY_RAIL_KEY,
  loadDockLayout,
  MAX_DOCK_WIDTH,
  MIN_DOCK_WIDTH,
  normalizeDockLayout,
  saveDockLayout,
} from "./layout.ts";

const browserId = "550e8400-e29b-41d4-a716-446655440000";
const replacementId = "550e8400-e29b-41d4-a716-446655440001";
const available: readonly DockTabId[] = [
  "agents",
  "browser",
  "dashboard",
  "needs-you",
  "runs",
  "queue",
  "services",
  "environments",
  "activity",
  "provider-usage",
  "kalvoice",
  "git",
  "tests",
];

beforeEach(() => {
  localStorage.clear();
});

describe("workspace dock layout", () => {
  it("starts on Agents, follows the agents until chosen, with a stable Browser identity", () => {
    expect(defaultDockLayout(browserId)).toEqual({
      schemaVersion: 1,
      tabs: ["agents"],
      active: "agents",
      pinned: [],
      width: DEFAULT_DOCK_WIDTH,
      collapsed: null,
      browser: { browserId, url: null },
    });
    expect(DEFAULT_DOCK_WIDTH).toBe(288);
    expect(MIN_DOCK_WIDTH).toBe(240);
    expect(MAX_DOCK_WIDTH).toBe(960);
  });

  it("repairs malformed stored state and never restores unsafe Browser URLs", () => {
    const fallback = vi.fn(() => replacementId);
    const repaired = normalizeDockLayout(
      {
        schemaVersion: 1,
        tabs: ["browser", "unknown", "browser", "runs"],
        active: "unknown",
        pinned: ["browser", "git"],
        width: 99_999,
        collapsed: "yes",
        browser: {
          browserId: "not-a-uuid",
          url: "https://person:secret@example.com/private?token=secret#key",
        },
      },
      available,
      fallback,
    );

    expect(repaired).toEqual({
      schemaVersion: 1,
      tabs: ["browser", "runs"],
      active: "browser",
      pinned: ["browser"],
      width: MAX_DOCK_WIDTH,
      collapsed: null,
      browser: { browserId: replacementId, url: null },
    });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("keeps only available surfaces and falls back to Agents when no stored tab survives", () => {
    const repaired = normalizeDockLayout(
      { schemaVersion: 1, tabs: ["kalvoice"], active: "kalvoice", width: 120, collapsed: true },
      ["agents", "browser"],
      () => browserId,
    );
    expect(repaired.tabs).toEqual(["agents"]);
    expect(repaired.active).toBe("agents");
    expect(repaired.width).toBe(MIN_DOCK_WIDTH);
    expect(repaired.collapsed).toBe(true);
  });

  it("rejects non-object state and bad pins, and turns an invalid collapsed value into null", () => {
    expect(normalizeDockLayout("nope", available, () => browserId).tabs).toEqual(["agents"]);
    expect(normalizeDockLayout(null, available, () => browserId, true).collapsed).toBe(true);
    const repaired = normalizeDockLayout(
      { tabs: ["agents"], pinned: ["runs", "agents", "agents"], width: "wide", collapsed: 1 },
      available,
      () => browserId,
      true,
    );
    expect(repaired.pinned).toEqual(["agents"]);
    expect(repaired.width).toBe(DEFAULT_DOCK_WIDTH);
    expect(repaired.collapsed).toBeNull();
  });

  it("adds, activates, reorders, pins and closes tabs deterministically", () => {
    let layout = defaultDockLayout(browserId);
    layout = applyDockLayout(layout, { kind: "add", id: "browser" }, available);
    layout = applyDockLayout(layout, { kind: "add", id: "runs" }, available);
    expect(layout.tabs).toEqual(["agents", "browser", "runs"]);
    expect(layout.active).toBe("runs");

    layout = applyDockLayout(layout, { kind: "move", id: "runs", to: 0 }, available);
    layout = applyDockLayout(layout, { kind: "pin", id: "browser", pinned: true }, available);
    expect(layout.tabs).toEqual(["runs", "agents", "browser"]);
    expect(layout.pinned).toEqual(["browser"]);

    expect(applyDockLayout(layout, { kind: "close", id: "browser" }, available)).toBe(layout);
    layout = applyDockLayout(layout, { kind: "pin", id: "browser", pinned: false }, available);
    layout = applyDockLayout(layout, { kind: "close", id: "runs" }, available);
    expect(layout.tabs).toEqual(["agents", "browser"]);
    expect(layout.active).toBe("agents");
  });

  it("stores only the safe Browser origin/path and bounds width changes", () => {
    let layout = applyDockLayout(defaultDockLayout(browserId), { kind: "resize", width: Number.NaN }, available);
    expect(layout.width).toBe(DEFAULT_DOCK_WIDTH);
    layout = applyDockLayout(layout, { kind: "resize", width: 12 }, available);
    expect(layout.width).toBe(MIN_DOCK_WIDTH);
    layout = applyDockLayout(
      layout,
      { kind: "browser-url", url: "http://localhost:4173/app?session=private#token" },
      available,
    );
    expect(layout.browser.url).toBe("http://localhost:4173/app");
  });

  it("closing the Browser starts a fresh session id but keeps the last page", () => {
    let layout = applyDockLayout(defaultDockLayout(browserId), { kind: "add", id: "browser" }, available);
    layout = applyDockLayout(layout, { kind: "browser-url", url: "http://localhost:4173/app?x=1" }, available);
    const closed = applyDockLayout(layout, { kind: "close", id: "browser" }, available, () => replacementId);
    expect(closed.tabs).toEqual(["agents"]);
    expect(closed.active).toBe("agents");
    expect(closed.browser).toEqual({ browserId: replacementId, url: "http://localhost:4173/app" });
  });

  it("browser-released also renews the session id and keeps the url", () => {
    const layout = applyDockLayout(
      defaultDockLayout(browserId),
      { kind: "browser-url", url: "http://localhost:4173/a" },
      available,
    );
    const released = applyDockLayout(layout, { kind: "browser-released" }, available, () => replacementId);
    expect(released.browser).toEqual({ browserId: replacementId, url: "http://localhost:4173/a" });
  });

  it("never closes a pinned tab or the last tab", () => {
    let layout = applyDockLayout(defaultDockLayout(browserId), { kind: "add", id: "runs" }, available);
    layout = applyDockLayout(layout, { kind: "pin", id: "runs", pinned: true }, available);
    expect(applyDockLayout(layout, { kind: "close", id: "runs" }, available)).toBe(layout);
    const single = defaultDockLayout(browserId);
    expect(applyDockLayout(single, { kind: "close", id: "agents" }, available)).toBe(single);
  });

  it("closing the active tab activates its neighbour", () => {
    let layout = defaultDockLayout(browserId);
    for (const id of ["browser", "runs", "git"] as const) {
      layout = applyDockLayout(layout, { kind: "add", id }, available);
    }
    layout = applyDockLayout(layout, { kind: "activate", id: "runs" }, available);
    layout = applyDockLayout(layout, { kind: "close", id: "runs" }, available);
    expect(layout.tabs).toEqual(["agents", "browser", "git"]);
    expect(layout.active).toBe("git");
    layout = applyDockLayout(layout, { kind: "close", id: "git" }, available);
    expect(layout.active).toBe("browser");
  });

  it("clamps moves into range and ignores unknown tabs", () => {
    let layout = defaultDockLayout(browserId);
    for (const id of ["browser", "runs"] as const) layout = applyDockLayout(layout, { kind: "add", id }, available);
    expect(applyDockLayout(layout, { kind: "move", id: "agents", to: 99 }, available).tabs).toEqual([
      "browser",
      "runs",
      "agents",
    ]);
    expect(applyDockLayout(layout, { kind: "move", id: "runs", to: -5 }, available).tabs).toEqual([
      "runs",
      "agents",
      "browser",
    ]);
    expect(applyDockLayout(layout, { kind: "move", id: "git", to: 0 }, available)).toBe(layout);
    expect(applyDockLayout(layout, { kind: "move", id: "agents", to: 0 }, available)).toBe(layout);
  });

  it("does not add unavailable tabs; reset-width and collapsed are idempotent", () => {
    const layout = defaultDockLayout(browserId);
    expect(applyDockLayout(layout, { kind: "add", id: "browser" }, ["agents"])).toBe(layout);
    expect(applyDockLayout(layout, { kind: "reset-width" }, available)).toBe(layout);
    const wide = applyDockLayout(layout, { kind: "resize", width: 600 }, available);
    expect(applyDockLayout(wide, { kind: "reset-width" }, available).width).toBe(DEFAULT_DOCK_WIDTH);
    const collapsed = applyDockLayout(layout, { kind: "collapsed", collapsed: true }, available);
    expect(collapsed.collapsed).toBe(true);
    expect(applyDockLayout(collapsed, { kind: "collapsed", collapsed: true }, available)).toBe(collapsed);
  });

  it("adding a tab opens the dock (collapsed false) and activates it", () => {
    const layout = applyDockLayout(defaultDockLayout(browserId), { kind: "collapsed", collapsed: true }, available);
    const added = applyDockLayout(layout, { kind: "add", id: "runs" }, available);
    expect(added.collapsed).toBe(false);
    expect(added.active).toBe("runs");
  });

  it("keys storage per workspace, including the no-workspace dock", () => {
    expect(dockStorageKey("a")).not.toBe(dockStorageKey("b"));
    expect(dockStorageKey(null)).toBe("kalcode.workspaceDock.v1._");
    expect(dockStorageKey("a/b c")).toBe("kalcode.workspaceDock.v1.a%2Fb%20c");
    saveDockLayout(null, { ...defaultDockLayout(browserId), width: 400 });
    expect(loadDockLayout(null, available).width).toBe(400);
    expect(loadDockLayout("other", available).width).toBe(DEFAULT_DOCK_WIDTH);
  });

  it("round-trips a saved layout and survives corrupt storage", () => {
    const layout = applyDockLayout(defaultDockLayout(browserId), { kind: "add", id: "runs" }, available);
    saveDockLayout("w", layout);
    expect(loadDockLayout("w", available)).toEqual(layout);
    localStorage.setItem(dockStorageKey("w"), "{not json");
    expect(loadDockLayout("w", available).tabs).toEqual(["agents"]);
  });

  it("seeds collapsed from the legacy agents-rail choice only when no layout is saved", () => {
    localStorage.setItem(LEGACY_RAIL_KEY, "closed");
    expect(loadDockLayout("w", available).collapsed).toBe(true);
    localStorage.setItem(LEGACY_RAIL_KEY, "open");
    expect(loadDockLayout("w", available).collapsed).toBe(false);
    localStorage.setItem(LEGACY_RAIL_KEY, "whatever");
    expect(loadDockLayout("w", available).collapsed).toBeNull();

    localStorage.setItem(LEGACY_RAIL_KEY, "closed");
    saveDockLayout("w", defaultDockLayout(browserId));
    expect(loadDockLayout("w", available).collapsed).toBeNull();
  });
});
