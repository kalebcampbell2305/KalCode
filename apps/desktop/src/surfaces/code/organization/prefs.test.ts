import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ITEMS, parsePrefs, useOrgPrefs } from "./prefs.ts";

const keys = (count: number, prefix = "old") => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

afterEach(() => {
  window.localStorage.clear();
});

describe("organization preferences", () => {
  it("reading keeps the newest entries when more than the limit is stored", () => {
    const pinned = [...keys(MAX_ITEMS), "newest-pin"];
    const groupOf = Object.fromEntries([...keys(MAX_ITEMS), "newest-move"].map((key) => [key, "Builds"]));
    const prefs = parsePrefs(JSON.stringify({ pinned, groupOf }));
    expect(prefs.pinned).toHaveLength(MAX_ITEMS);
    expect(prefs.pinned).toContain("newest-pin");
    expect(prefs.pinned).not.toContain("old-0");
    expect(Object.keys(prefs.groupOf)).toHaveLength(MAX_ITEMS);
    expect(prefs.groupOf["newest-move"]).toBe("custom:Builds");
    expect(prefs.groupOf["old-0"]).toBeUndefined();
  });

  it("a new pin and move survive a reload after the limit of history", () => {
    window.localStorage.setItem(
      "kalcode.code.organization.ws",
      JSON.stringify({
        pinned: keys(MAX_ITEMS),
        groupOf: Object.fromEntries(keys(MAX_ITEMS).map((key) => [key, "Builds"])),
      }),
    );
    const first = renderHook(() => useOrgPrefs("ws"));
    act(() => first.result.current.togglePin("new-pin"));
    act(() => first.result.current.moveTo("new-move", "Tests"));
    // Moving an old item again makes it the newest move.
    act(() => first.result.current.moveTo("old-0", "Tests"));
    const stored = JSON.parse(window.localStorage.getItem("kalcode.code.organization.ws") ?? "{}");
    expect(stored.pinned).toHaveLength(MAX_ITEMS);
    expect(Object.keys(stored.groupOf)).toHaveLength(MAX_ITEMS);
    first.unmount();

    const reloaded = renderHook(() => useOrgPrefs("ws"));
    const { prefs } = reloaded.result.current;
    expect(prefs.pinned).toContain("new-pin");
    expect(prefs.groupOf["new-move"]).toBe("Tests");
    expect(prefs.groupOf["old-0"]).toBe("Tests");
  });

  it("reads the earlier name-keyed format as stable ids", () => {
    const prefs = parsePrefs(
      JSON.stringify({
        customGroups: ["Website", "Tests"],
        groupOf: { "agent:a": "Website", "agent:b": "Frontend" },
        collapsedGroups: ["Website", "Agents"],
      }),
    );
    expect(prefs.customGroups).toEqual([{ id: "custom:Website", name: "Website" }]);
    expect(prefs.groupOf).toEqual({ "agent:a": "custom:Website", "agent:b": "Frontend" });
    expect(prefs.collapsedGroups).toEqual(["custom:Website", "Agents"]);
  });

  it("persists group names, order, item order and collapse across a reload", () => {
    const first = renderHook(() => useOrgPrefs("ws"));
    let id: string | null = null;
    act(() => {
      id = first.result.current.addGroup("Website");
    });
    const webId = id as unknown as string;
    act(() => first.result.current.renameGroup(webId, "  Web   site "));
    act(() => first.result.current.renameGroup("Agents", "AI"));
    act(() => first.result.current.moveTo("agent:a", webId));
    act(() => first.result.current.setCollapsed(webId, true));
    act(() => first.result.current.update((p) => ({ ...p, groupOrder: [webId, "Agents"], itemOrder: ["x", "y"] })));
    first.unmount();

    const { prefs } = renderHook(() => useOrgPrefs("ws")).result.current;
    expect(prefs.customGroups).toEqual([{ id: webId, name: "Web site" }]);
    expect(prefs.groupLabels).toEqual({ Agents: "AI" });
    expect(prefs.groupOf).toEqual({ "agent:a": webId });
    expect(prefs.collapsedGroups).toEqual([webId]);
    expect(prefs.groupOrder).toEqual([webId, "Agents"]);
    expect(prefs.itemOrder).toEqual(["x", "y"]);
  });

  it("removing an added group sends its items home; naming a built-in group its own name restores it", () => {
    const hook = renderHook(() => useOrgPrefs("ws"));
    let id: string | null = null;
    act(() => {
      id = hook.result.current.addGroup("Release train");
    });
    const groupId = id as unknown as string;
    act(() => hook.result.current.moveTo("agent:a", groupId));
    act(() => hook.result.current.removeGroup(groupId));
    act(() => hook.result.current.renameGroup("Tests", "QA"));
    act(() => hook.result.current.renameGroup("Tests", "Tests"));
    expect(hook.result.current.prefs.customGroups).toEqual([]);
    expect(hook.result.current.prefs.groupOf).toEqual({});
    expect(hook.result.current.prefs.groupLabels).toEqual({});
  });
});
