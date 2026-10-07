import type { PaneContent, PaneLayout } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import {
  allContents,
  arrangeDesk,
  contentKey,
  DESK_VISIBLE_PANES,
  emptyLayout,
  findContent,
  leaves,
  makeLeaf,
} from "./model.ts";

const terminal = (id: string): PaneContent => ({ kind: "terminal", terminalId: id });

function layoutWith(tabs: PaneContent[]): PaneLayout {
  return { ...emptyLayout(), root: makeLeaf(tabs) };
}

describe("arrangeDesk", () => {
  it("fills a four-pane preset in reading order on an empty layout", () => {
    const contents = [terminal("t1"), terminal("t2"), terminal("t3"), terminal("t4")];
    const next = arrangeDesk(emptyLayout(), contents, "four");
    expect(next).not.toBeNull();
    const panes = leaves((next as PaneLayout).root);
    expect(panes).toHaveLength(4);
    expect(panes.map((pane) => pane.tabs)).toEqual(contents.map((content) => [content]));
  });

  it("places overflow from a two-pane preset as a round-robin tab", () => {
    const next = arrangeDesk(emptyLayout(), [terminal("t1"), terminal("t2"), terminal("t3")], "two");
    expect(next).not.toBeNull();
    const panes = leaves((next as PaneLayout).root);
    expect(panes).toHaveLength(2);
    expect(panes[0]?.tabs).toEqual([terminal("t1"), terminal("t3")]);
    expect(panes[1]?.tabs).toEqual([terminal("t2")]);
    expect(panes[0]?.activeTab).toBe(0);
  });

  it("ignores the preset beside existing work and keeps every existing tab", () => {
    const existing = layoutWith([terminal("keep")]);
    const next = arrangeDesk(existing, [terminal("t1"), terminal("t2")], "four");
    expect(next).not.toBeNull();
    const layout = next as PaneLayout;
    expect(allContents(layout)).toEqual(expect.arrayContaining([terminal("keep"), terminal("t1"), terminal("t2")]));
    expect(findContent(layout, contentKey(terminal("keep")))?.paneId).toBe(leaves(existing.root)[0]?.paneId);
    // The existing pane plus the two new panes: the preset's four slots are not applied.
    expect(leaves(layout.root)).toHaveLength(3);
  });

  it("keeps the desk to DESK_VISIBLE_PANES panes and adds the rest as tabs", () => {
    const contents = Array.from({ length: DESK_VISIBLE_PANES + 2 }, (_, i) => terminal(`t${i}`));
    const next = arrangeDesk(emptyLayout(), contents, null);
    expect(next).not.toBeNull();
    const layout = next as PaneLayout;
    const panes = leaves(layout.root);
    expect(DESK_VISIBLE_PANES).toBe(8);
    expect(panes).toHaveLength(8);
    expect(allContents(layout)).toHaveLength(contents.length);
    expect(panes[0]?.tabs).toEqual([terminal("t0"), terminal("t8")]);
    expect(panes[1]?.tabs).toEqual([terminal("t1"), terminal("t9")]);
  });

  it("de-duplicates repeated contents so each appears once", () => {
    const next = arrangeDesk(emptyLayout(), [terminal("t1"), terminal("t1"), terminal("t2")], "two");
    expect(next).not.toBeNull();
    const layout = next as PaneLayout;
    expect(allContents(layout)).toEqual([terminal("t1"), terminal("t2")]);
  });

  it("leaves the layout unchanged when there are no contents", () => {
    const layout = layoutWith([terminal("keep")]);
    expect(arrangeDesk(layout, [], "four")).toBe(layout);
  });
});
