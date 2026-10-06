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
    expect(prefs.groupOf["newest-move"]).toBe("Builds");
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
});
