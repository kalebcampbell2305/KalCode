import { describe, expect, it } from "vitest";
import { moveGroup, moveItem, placeBefore, stepGroup, stepItem } from "./arrange.ts";
import { DEFAULT_PREFS, groupIdsInOrder, type OrgItem, type OrgPrefs, organize } from "./model.ts";

const item = (key: string, group: OrgItem["group"] = "Agents"): OrgItem => ({
  key,
  content: { kind: "agent", agentId: key },
  kind: "agent",
  title: key,
  status: { badge: "working", detail: "" },
  group,
  glyph: "claude",
  order: key,
});

const items = [item("claude"), item("codex"), item("test-pc"), item("frontend", "Frontend")];
const prefs: OrgPrefs = { ...DEFAULT_PREFS, customGroups: [{ id: "g:web", name: "Website" }] };
const keysOf = (p: OrgPrefs) => organize(items, p, null).map((g) => [g.id, g.members.map((m) => m.key)]);

describe("placeBefore", () => {
  it("moves a value before another, or to the end", () => {
    expect(placeBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(placeBefore(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(placeBefore(["a", "b"], "z", "b")).toEqual(["a", "z", "b"]);
  });
});

describe("moveItem", () => {
  it("reorders inside a group and persists the whole visible order", () => {
    const groups = organize(items, prefs, null);
    const next = moveItem(prefs, groups, items[2] as OrgItem, "Agents", "claude");
    expect(keysOf(next)[1]).toEqual(["Agents", ["test-pc", "claude", "codex"]]);
    expect(next.groupOf).toEqual({});
  });

  it("moves the same item to another group and back without changing anything else", () => {
    const moved = moveItem(prefs, organize(items, prefs, null), items[2] as OrgItem, "g:web", null);
    expect(moved.groupOf).toEqual({ "test-pc": "g:web" });
    expect(keysOf(moved)).toContainEqual(["g:web", ["test-pc"]]);
    const back = moveItem(moved, organize(items, moved, null), items[2] as OrgItem, "Agents", "codex");
    expect(back.groupOf).toEqual({});
    expect(keysOf(back)[1]).toEqual(["Agents", ["claude", "test-pc", "codex"]]);
  });

  it("puts an item dropped into an empty group there, and keeps it after a rename of the group", () => {
    const moved = moveItem(prefs, organize(items, prefs, null), items[0] as OrgItem, "g:web", null);
    const renamed = { ...moved, customGroups: [{ id: "g:web", name: "Site" }] };
    const web = organize(items, renamed, null).find((g) => g.id === "g:web");
    expect([web?.name, web?.members.map((m) => m.key)]).toEqual(["Site", ["claude"]]);
  });
});

describe("moveGroup", () => {
  it("reorders groups by id", () => {
    const next = moveGroup(prefs, "g:web", "Frontend");
    expect(groupIdsInOrder(next).indexOf("g:web")).toBeLessThan(groupIdsInOrder(next).indexOf("Frontend"));
    expect(organize(items, next, null).map((g) => g.id)).toEqual(["g:web", "Frontend", "Agents"]);
  });
});

describe("keyboard steps", () => {
  const groups = organize(items, prefs, null);
  const visible = (g: (typeof groups)[number]) => g.active;

  it("steps an item within its group and across group edges", () => {
    expect(stepItem(groups, visible, "codex", -1)).toEqual({ group: "Agents", before: "claude" });
    expect(stepItem(groups, visible, "claude", 1)).toEqual({ group: "Agents", before: "test-pc" });
    expect(stepItem(groups, visible, "test-pc", 1)).toEqual({ group: "g:web", before: null });
    expect(stepItem(groups, visible, "frontend", -1)).toBeNull();
  });

  it("steps a group up and down", () => {
    expect(groups.map((g) => g.id)).toEqual(["Frontend", "Agents", "g:web"]);
    expect(stepGroup(groups, "Agents", -1)).toBe("Frontend");
    expect(stepGroup(groups, "Frontend", 1)).toBe("g:web");
    expect(stepGroup(groups, "Agents", 1)).toBeNull();
    expect(stepGroup(groups, "g:web", 1)).toBeUndefined();
  });
});
