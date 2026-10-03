import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampDock,
  DOCK_MAX_PX,
  DOCK_MIN_PX,
  FAILED_FOLD_AT,
  isFolded,
  readLayout,
  toggleExpanded,
  useFleetLayout,
} from "./fleetLayout.ts";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("Fleet layout", () => {
  it("is remembered across restarts: panel width, folded groups and expanded cards", () => {
    const first = renderHook(() => useFleetLayout());
    act(() => {
      first.result.current.setDockWidth(420);
      first.result.current.setFolded("status:done", true);
      first.result.current.toggleCard("agent-1");
    });
    first.unmount();
    const next = renderHook(() => useFleetLayout());
    expect(next.result.current.layout).toEqual({
      dockWidth: 420,
      folded: { "status:done": true },
      expanded: ["agent-1"],
    });
  });

  it("a drag in progress isn't saved until it ends", () => {
    const { result } = renderHook(() => useFleetLayout());
    act(() => result.current.setDockWidth(500, false));
    expect(result.current.layout.dockWidth).toBe(500);
    expect(readLayout().dockWidth).toBeNull();
  });

  it("keeps the panel width within bounds and survives bad or blocked storage", () => {
    expect(clampDock(10)).toBe(DOCK_MIN_PX);
    expect(clampDock(9999)).toBe(DOCK_MAX_PX);
    window.localStorage.setItem("kalcode.fleet.layout", "{not json");
    expect(readLayout()).toEqual({ dockWidth: null, folded: {}, expanded: [] });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readLayout()).toEqual({ dockWidth: null, folded: {}, expanded: [] });
  });

  it("folds a long failed group by default, and the person's choice wins", () => {
    expect(isFolded({ folded: {} }, "status:failed", FAILED_FOLD_AT)).toBe(false);
    expect(isFolded({ folded: {} }, "status:failed", FAILED_FOLD_AT + 1)).toBe(true);
    expect(isFolded({ folded: { "status:failed": false } }, "status:failed", 500)).toBe(false);
    expect(isFolded({ folded: {} }, "status:idle", 500)).toBe(false);
  });

  it("remembers a bounded number of expanded cards", () => {
    let expanded: string[] = [];
    for (let i = 0; i < 250; i += 1) expanded = toggleExpanded(expanded, `a${i}`);
    expect(expanded).toHaveLength(200);
    expect(expanded[0]).toBe("a50");
    expect(toggleExpanded(["a", "b"], "a")).toEqual(["b"]);
  });
});
