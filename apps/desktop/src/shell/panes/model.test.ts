import type { PaneContent, PaneLayout, PaneNode } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { updateBrowserUrl } from "../../surfaces/browser/browserModel.ts";
import {
  activateTab,
  addTab,
  applyPreset,
  applyShape,
  arrangeContents,
  canSplit,
  childSizes,
  closePane,
  computeGeometry,
  contentKey,
  DEFAULT_GEOMETRY,
  dockPane,
  emptyLayout,
  equalRatios,
  evenDivider,
  findContent,
  findLeaf,
  leaves,
  MAX_PANE_DEPTH,
  MAX_PANES,
  makeLeaf,
  matchingPreset,
  migrateAgentContents,
  movePane,
  moveTab,
  neighbourPane,
  normalizeNode,
  parseLayout,
  presetShape,
  removeContents,
  removeTab,
  reopenPane,
  reorderTab,
  resizeDivider,
  resizePane,
  resizePaneRelative,
  setCollapsed,
  setMaximized,
  shapeOf,
  splitPane,
  swapPanes,
  toRatios,
  undock,
  validateLayout,
} from "./model.ts";

const term = (id: string): PaneContent => ({ kind: "terminal", terminalId: id });
const thread = (id: string): PaneContent => ({ kind: "thread", threadId: id });

function layoutOf(root: PaneNode): PaneLayout {
  return { schemaVersion: 1, root, maximizedPaneId: null, dock: [] };
}

/** Two panes side by side: a (t1, t2) | b (t3). */
function twoPanes(): PaneLayout {
  return layoutOf({
    kind: "split",
    axis: "horizontal",
    ratios: [500, 500],
    children: [makeLeaf([term("t1"), term("t2")], "a"), makeLeaf([term("t3")], "b")],
  });
}

function expectValid(layout: PaneLayout) {
  expect(validateLayout(layout)).toBeNull();
}

describe("coding agent pane identity", () => {
  it("round trips agent tabs and dock items separately from Threads", () => {
    const agent: PaneContent = { kind: "agent", agentId: "live-provider-session" };
    const layout = layoutOf(makeLeaf([agent, thread("conversation")], "code", 1));
    layout.dock = [{ kind: "agent", agentId: "background-provider-session" }];
    expect(parseLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    expect(contentKey(agent)).toBe("agent:live-provider-session");
    expect(contentKey(agent)).not.toBe(contentKey(thread("live-provider-session")));
  });

  it("migrates only confirmed legacy agent tabs and dock entries while preserving geometry", () => {
    const untouched = makeLeaf([thread("conversation"), term("shell")], "chat");
    const layout = layoutOf({
      kind: "split",
      axis: "vertical",
      ratios: [650, 350],
      children: [{ ...makeLeaf([thread("agent-1"), thread("unknown")], "code", 1), collapsed: true }, untouched],
    });
    layout.maximizedPaneId = "chat";
    layout.dock = [thread("agent-2"), thread("unconfirmed")];
    const migrated = migrateAgentContents(layout, new Set(["agent-1", "agent-2"]));
    expect(leaves(migrated.root)[0]).toEqual({
      ...leaves(layout.root)[0],
      tabs: [{ kind: "agent", agentId: "agent-1" }, thread("unknown")],
    });
    expect(leaves(migrated.root)[1]).toBe(untouched);
    expect(migrated.root.kind === "split" && migrated.root.ratios).toBe(
      layout.root.kind === "split" && layout.root.ratios,
    );
    expect(migrated.maximizedPaneId).toBe("chat");
    expect(migrated.dock).toEqual([{ kind: "agent", agentId: "agent-2" }, thread("unconfirmed")]);
    expect(leaves(layout.root)[0]?.tabs[0]).toEqual(thread("agent-1"));
    expect(migrateAgentContents(migrated, new Set(["agent-1", "agent-2"]))).toBe(migrated);
    expect(migrateAgentContents(layout, new Set())).toBe(layout);
    expectValid(migrated);
  });
});

describe("ratios", () => {
  it("always sum to 1000 with every share positive", () => {
    for (const weights of [[1], [1, 1, 1], [1, 2, 3, 4, 5, 6, 7], [0.0001, 999], [3, 3, 3], [1e9, 1]]) {
      const ratios = toRatios(weights);
      expect(ratios.reduce((a, b) => a + b, 0)).toBe(1000);
      expect(ratios.every((r) => r >= 1 && Number.isInteger(r))).toBe(true);
    }
    expect(equalRatios(3)).toEqual([334, 333, 333]);
    expect(equalRatios(6).reduce((a, b) => a + b, 0)).toBe(1000);
  });
});

describe("normalization", () => {
  it("collapses single-child splits and flattens same-axis nesting, keeping shares", () => {
    const nested: PaneNode = {
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [
        makeLeaf([], "a"),
        {
          kind: "split",
          axis: "horizontal",
          ratios: [500, 500],
          children: [
            makeLeaf([], "b"),
            { kind: "split", axis: "vertical", ratios: [1000], children: [makeLeaf([], "c")] },
          ],
        },
      ],
    };
    const flat = normalizeNode(nested);
    expect(flat.kind).toBe("split");
    if (flat.kind !== "split") return;
    expect(flat.children.map((c) => (c.kind === "leaf" ? c.paneId : "split"))).toEqual(["a", "b", "c"]);
    expect(flat.ratios).toEqual([500, 250, 250]);
    expect(normalizeNode(flat)).toEqual(flat);
  });
});

describe("splitting and closing", () => {
  it("splits side by side and stacked; the result validates", () => {
    const start = layoutOf(makeLeaf([term("t1")], "a"));
    const right = splitPane(start, "a", "horizontal", makeLeaf([], "b"));
    expectValid(right);
    expect(leaves(right.root).map((l) => l.paneId)).toEqual(["a", "b"]);
    const down = splitPane(right, "b", "vertical", makeLeaf([], "c"));
    expectValid(down);
    expect(leaves(down.root).map((l) => l.paneId)).toEqual(["a", "b", "c"]);
    // Splitting along the parent's axis adds a sibling instead of nesting.
    const third = splitPane(right, "a", "horizontal", makeLeaf([], "d"), "before");
    expect(third.root.kind === "split" && third.root.children.length).toBe(3);
    expect(leaves(third.root).map((l) => l.paneId)).toEqual(["d", "a", "b"]);
  });

  it("respects the pane and depth limits", () => {
    let layout = layoutOf(makeLeaf([], "p0"));
    for (let i = 1; i < MAX_PANES + 5; i++) {
      layout = splitPane(layout, `p${i - 1}`, i % 2 ? "horizontal" : "vertical", makeLeaf([], `p${i}`));
    }
    expectValid(layout);
    expect(leaves(layout.root).length).toBeLessThanOrEqual(MAX_PANES);
    // Alternating axes nest; the depth never exceeds the limit.
    const depth = (n: PaneNode): number => (n.kind === "leaf" ? 1 : 1 + Math.max(...n.children.map(depth)));
    expect(depth(layout.root)).toBeLessThanOrEqual(MAX_PANE_DEPTH);
  });

  it("closing a pane keeps its tabs for reopening in the same place; the last pane is emptied", () => {
    const { layout, closed } = closePane(twoPanes(), "b");
    expectValid(layout);
    expect(leaves(layout.root).map((l) => l.paneId)).toEqual(["a"]);
    expect(closed?.pane.tabs).toEqual([term("t3")]);
    expect(closed?.anchorPaneId).toBe("a");
    expect(closed?.zone).toBe("right");
    const reopened = reopenPane(layout, closed as NonNullable<typeof closed>);
    expectValid(reopened);
    expect(leaves(reopened.root).map((l) => l.paneId)).toEqual(["a", "b"]);
    expect(findLeaf(reopened, "b")?.tabs).toEqual([term("t3")]);

    const lone = closePane(layout, "a");
    expect(leaves(lone.layout.root)).toHaveLength(1);
    expect(leaves(lone.layout.root)[0]?.tabs).toEqual([]);
    expect(lone.closed?.pane.tabs).toEqual([term("t1"), term("t2")]);
  });

  it("reopening restores the pane's place in the tree and its share of the space", () => {
    // a (70%) | [b over c]
    const layout = layoutOf({
      kind: "split",
      axis: "horizontal",
      ratios: [700, 300],
      children: [
        makeLeaf([term("t1")], "a"),
        { kind: "split", axis: "vertical", ratios: [500, 500], children: [makeLeaf([], "b"), makeLeaf([], "c")] },
      ],
    });
    const { layout: without, closed } = closePane(layout, "a");
    const back = reopenPane(without, closed as NonNullable<typeof closed>);
    expect(back.root).toEqual(layout.root);
  });

  it("reopening skips contents that are shown elsewhere meanwhile", () => {
    const { layout, closed } = closePane(twoPanes(), "b");
    const moved = addTab(layout, "a", term("t3"));
    const reopened = reopenPane(moved, closed as NonNullable<typeof closed>);
    expect(findLeaf(reopened, "b")?.tabs).toEqual([]);
    expect(findContent(reopened, "terminal:t3")?.paneId).toBe("a");
  });
});

describe("tabs", () => {
  it("adds, activates, reorders and removes tabs; a content is never shown twice", () => {
    let layout = twoPanes();
    layout = addTab(layout, "b", term("t4"));
    expect(findLeaf(layout, "b")?.activeTab).toBe(1);
    // Adding what is already shown brings it forward where it is.
    layout = addTab(layout, "b", term("t1"));
    expect(findContent(layout, "terminal:t1")).toEqual({ paneId: "a", index: 0 });
    expect(findLeaf(layout, "a")?.activeTab).toBe(0);
    layout = activateTab(layout, "a", 1);
    layout = reorderTab(layout, "a", 1, 0);
    expect(findLeaf(layout, "a")?.tabs).toEqual([term("t2"), term("t1")]);
    expect(findLeaf(layout, "a")?.activeTab).toBe(0);
    layout = removeTab(layout, "a", 0);
    expect(findLeaf(layout, "a")?.tabs).toEqual([term("t1")]);
    expectValid(layout);
    layout = removeContents(layout, new Set(["terminal:t1", "terminal:t3"]));
    expect(findLeaf(layout, "a")?.tabs).toEqual([]);
    expect(findLeaf(layout, "b")?.tabs).toEqual([term("t4")]);
    expectValid(layout);
  });

  it("moves a tab into another pane or onto its edge; an emptied pane closes", () => {
    const into = moveTab(twoPanes(), "b", 0, "a", "center");
    expectValid(into);
    expect(leaves(into.root).map((l) => l.paneId)).toEqual(["a"]);
    expect(findLeaf(into, "a")?.tabs.map(contentKey)).toEqual(["terminal:t1", "terminal:t2", "terminal:t3"]);

    const below = moveTab(twoPanes(), "a", 1, "b", "bottom");
    expectValid(below);
    expect(findLeaf(below, "a")?.tabs).toEqual([term("t1")]);
    const moved = findContent(below, "terminal:t2");
    expect(moved?.paneId).not.toBe("a");
    expect(moved?.paneId).not.toBe("b");
    const geometry = computeGeometry(below, 1000, 800);
    const b = geometry.panes.get("b");
    const m = geometry.panes.get(moved?.paneId ?? "");
    expect(m && b && m.y > b.y).toBe(true);

    // Splitting a pane off itself is allowed when it has other tabs.
    const self = moveTab(twoPanes(), "a", 0, "a", "left");
    expect(leaves(self.root)).toHaveLength(3);
    expect(moveTab(twoPanes(), "b", 0, "b", "left")).toEqual(twoPanes());
  });

  it("moves whole panes and swaps them", () => {
    const moved = movePane(twoPanes(), "a", "b", "bottom");
    expectValid(moved);
    expect(leaves(moved.root).map((l) => l.paneId)).toEqual(["b", "a"]);
    expect(moved.root.kind === "split" && moved.root.axis).toBe("vertical");
    const merged = movePane(twoPanes(), "b", "a", "center");
    expect(leaves(merged.root).map((l) => l.paneId)).toEqual(["a"]);
    const swapped = swapPanes(twoPanes(), "a", "b");
    expect(leaves(swapped.root).map((l) => l.paneId)).toEqual(["b", "a"]);
    expect(findLeaf(swapped, "a")?.tabs).toEqual([term("t1"), term("t2")]);
  });
});

describe("maximize, collapse, dock", () => {
  it("maximizes one pane and restores; a missing pane is ignored", () => {
    const max = setMaximized(twoPanes(), "b");
    expect(max.maximizedPaneId).toBe("b");
    expectValid(max);
    expect(setMaximized(max, null).maximizedPaneId).toBeNull();
    expect(setMaximized(twoPanes(), "nope").maximizedPaneId).toBeNull();
    // Closing the maximized pane clears it.
    expect(closePane(max, "b").layout.maximizedPaneId).toBeNull();
  });

  it("collapses a pane to its header, but never the last open one", () => {
    const collapsed = setCollapsed(twoPanes(), "a", true);
    expect(findLeaf(collapsed, "a")?.collapsed).toBe(true);
    expect(setCollapsed(collapsed, "b", true)).toEqual(collapsed);
    const geometry = computeGeometry(collapsed, 1000, 600);
    expect(geometry.panes.get("a")?.width).toBe(DEFAULT_GEOMETRY.collapsedSize);
    // Activating a tab reopens it.
    expect(findLeaf(activateTab(collapsed, "a", 1), "a")?.collapsed).toBe(false);
  });

  it("docks a pane's tabs and brings them back", () => {
    const docked = dockPane(twoPanes(), "b");
    expectValid(docked);
    expect(docked.dock).toEqual([term("t3")]);
    expect(leaves(docked.root).map((l) => l.paneId)).toEqual(["a"]);
    const back = undock(docked, 0, "a");
    expect(back.dock).toEqual([]);
    expect(findContent(back, "terminal:t3")?.paneId).toBe("a");
  });
});

describe("presets", () => {
  it("builds 2, 3, 4 and 6 pane shapes", () => {
    for (const [preset, n] of [
      ["two", 2],
      ["three", 3],
      ["four", 4],
      ["six", 6],
    ] as const) {
      const layout = layoutOf(presetShape(preset));
      expectValid(layout);
      expect(leaves(layout.root)).toHaveLength(n);
      expect(matchingPreset(layout)).toBe(preset);
    }
  });

  it("redistributes existing panes into a preset without losing anything", () => {
    const six = applyPreset(twoPanes(), "six");
    expectValid(six);
    const all = leaves(six.root);
    expect(all).toHaveLength(6);
    expect(all[0]?.paneId).toBe("a");
    expect(all[0]?.tabs).toEqual([term("t1"), term("t2")]);
    expect(all[1]?.paneId).toBe("b");
    expect(all.slice(2).every((l) => l.tabs.length === 0)).toBe(true);

    // Fewer slots than panes: the last slot collects the rest.
    const four = applyPreset(six, "four");
    const three = layoutOf({
      kind: "split",
      axis: "horizontal",
      ratios: equalRatios(3),
      children: [makeLeaf([term("x")], "x"), makeLeaf([term("y")], "y"), makeLeaf([term("z")], "z")],
    });
    const two = applyPreset(three, "two");
    expectValid(two);
    expect(leaves(two.root).map((l) => l.tabs.map(contentKey))).toEqual([["terminal:x"], ["terminal:y", "terminal:z"]]);
    expect(leaves(four.root)).toHaveLength(4);
  });

  it("applies a saved custom shape", () => {
    const custom = shapeOf(presetShape("three"));
    const applied = applyShape(twoPanes(), custom);
    expectValid(applied);
    expect(leaves(applied.root)).toHaveLength(3);
    expect(leaves(applied.root)[0]?.tabs).toEqual([term("t1"), term("t2")]);
  });

  it("arranges four exact provider threads as a 2 by 2 grid without duplicating an id", () => {
    const arranged = arrangeContents(emptyLayout(), [
      thread("codex-1"),
      thread("codex-2"),
      thread("claude-1"),
      thread("claude-2"),
      thread("codex-2"),
    ]);

    expect(arranged).not.toBeNull();
    if (!arranged) return;
    expectValid(arranged);
    expect(arranged.root.kind).toBe("split");
    if (arranged.root.kind !== "split") return;
    expect(arranged.root.axis).toBe("vertical");
    expect(arranged.root.children.map((row) => (row.kind === "split" ? row.axis : "leaf"))).toEqual([
      "horizontal",
      "horizontal",
    ]);
    expect(leaves(arranged.root).map((leaf) => leaf.tabs.map(contentKey))).toEqual([
      ["thread:codex-1"],
      ["thread:codex-2"],
      ["thread:claude-1"],
      ["thread:claude-2"],
    ]);
  });

  it("retains existing pane contents and dock items while adding exact provider panes", () => {
    const start = { ...twoPanes(), dock: [thread("background")] };
    const arranged = arrangeContents(start, [thread("codex-1"), thread("claude-1")]);

    expect(arranged).not.toBeNull();
    if (!arranged) return;
    expectValid(arranged);
    expect(arranged.dock).toEqual([thread("background")]);
    expect(leaves(arranged.root).map((leaf) => leaf.tabs.map(contentKey))).toEqual([
      ["terminal:t1", "terminal:t2"],
      ["terminal:t3"],
      ["thread:codex-1"],
      ["thread:claude-1"],
    ]);
  });

  it("keeps four new provider panes in a 2 by 2 subgroup beside existing work", () => {
    const arranged = arrangeContents(twoPanes(), [
      thread("codex-1"),
      thread("codex-2"),
      thread("claude-1"),
      thread("claude-2"),
    ]);

    expect(arranged).not.toBeNull();
    if (!arranged) return;
    const targetKeys = new Set(["thread:codex-1", "thread:codex-2", "thread:claude-1", "thread:claude-2"]);
    const targetGrid = (node: PaneNode): PaneNode | null => {
      const keys = leaves(node).flatMap((leaf) => leaf.tabs.map(contentKey));
      if (keys.length === 4 && keys.every((key) => targetKeys.has(key))) return node;
      if (node.kind === "leaf") return null;
      return node.children.map(targetGrid).find((child) => child !== null) ?? null;
    };
    const grid = targetGrid(arranged.root);
    expect(grid?.kind).toBe("split");
    if (grid?.kind !== "split") return;
    expect(grid.axis).toBe("vertical");
    expect(grid.children.map((row) => (row.kind === "split" ? row.axis : "leaf"))).toEqual([
      "horizontal",
      "horizontal",
    ]);
    expect(findLeaf(arranged, "a")?.tabs).toEqual([term("t1"), term("t2")]);
    expect(findLeaf(arranged, "b")?.tabs).toEqual([term("t3")]);
  });

  it("balances mixed provider quantities without a sparse final row", () => {
    const arranged = arrangeContents(
      emptyLayout(),
      Array.from({ length: 7 }, (_, index) => thread(`provider-${index + 1}`)),
    );

    expect(arranged?.root.kind).toBe("split");
    if (arranged?.root.kind !== "split") return;
    expect(arranged.root.axis).toBe("vertical");
    expect(arranged.root.children.map((row) => leaves(row).length)).toEqual([3, 2, 2]);
  });
});

describe("geometry and resizing", () => {
  it("lays panes out edge to edge with gutters", () => {
    const { panes, dividers } = computeGeometry(twoPanes(), 1006, 500);
    expect(panes.get("a")).toEqual({ x: 0, y: 0, width: 500, height: 500 });
    expect(panes.get("b")).toEqual({ x: 506, y: 0, width: 500, height: 500 });
    expect(dividers).toHaveLength(1);
    expect(dividers[0]?.rect).toEqual({ x: 500, y: 0, width: 6, height: 500 });
  });

  it("keeps panes at their minimum size when space is short", () => {
    const layout = layoutOf({
      kind: "split",
      axis: "horizontal",
      ratios: [980, 10, 10],
      children: [makeLeaf([], "a"), makeLeaf([], "b"), makeLeaf([], "c")],
    });
    const sizes = childSizes(layout.root as never, 1000);
    expect(sizes[1]).toBe(DEFAULT_GEOMETRY.minWidth);
    expect(sizes[2]).toBe(DEFAULT_GEOMETRY.minWidth);
    expect(Math.round(sizes.reduce((a, b) => a + b, 0) + 2 * DEFAULT_GEOMETRY.gutter)).toBe(1000);
  });

  it("moves a divider, clamped to both neighbours' minimums, and evens it out", () => {
    const layout = twoPanes();
    const { dividers } = computeGeometry(layout, 1006, 600);
    const divider = dividers[0];
    if (!divider) throw new Error("divider");
    const grown = resizeDivider(layout, divider, 200);
    expectValid(grown);
    expect(computeGeometry(grown, 1006, 600).panes.get("a")?.width).toBeCloseTo(700, 0);
    const clamped = resizeDivider(layout, divider, 5000);
    expect(computeGeometry(clamped, 1006, 600).panes.get("b")?.width).toBeCloseTo(DEFAULT_GEOMETRY.minWidth, 0);
    const even = evenDivider(grown, divider.path, divider.index);
    expect(even.root.kind === "split" && even.root.ratios).toEqual([500, 500]);
  });

  it("grows a pane toward a direction through the nearest matching split", () => {
    const layout = splitPane(twoPanes(), "b", "vertical", makeLeaf([], "c"));
    const taller = resizePane(layout, "b", "down", 60, 1006, 606);
    const before = computeGeometry(layout, 1006, 606).panes.get("b")?.height ?? 0;
    const after = computeGeometry(taller, 1006, 606).panes.get("b")?.height ?? 0;
    expect(after - before).toBeCloseTo(60, 0);
    const wider = resizePane(layout, "c", "left", 100, 1006, 606);
    expect(computeGeometry(wider, 1006, 606).panes.get("c")?.width).toBeCloseTo(600, 0);
    // No neighbour that way: unchanged.
    expect(resizePane(layout, "a", "left", 100, 1006, 606)).toBe(layout);
  });

  it("grows and shrinks a named pane relative to its nearest divider", () => {
    const start = twoPanes();
    const before = computeGeometry(start, 1006, 600).panes.get("b")?.width ?? 0;
    const grown = resizePaneRelative(start, "b", true, 60, 1006, 600);
    const grownWidth = computeGeometry(grown, 1006, 600).panes.get("b")?.width ?? 0;
    expect(grownWidth - before).toBeCloseTo(60, 0);

    const shrunk = resizePaneRelative(grown, "b", false, 60, 1006, 600);
    expect(computeGeometry(shrunk, 1006, 600).panes.get("b")?.width).toBeCloseTo(before, 0);
  });

  it("finds the neighbouring pane in each direction", () => {
    const layout = splitPane(twoPanes(), "b", "vertical", makeLeaf([], "c"));
    expect(neighbourPane(layout, "a", "right")).toBe("b");
    expect(neighbourPane(layout, "b", "down")).toBe("c");
    expect(neighbourPane(layout, "c", "up")).toBe("b");
    expect(neighbourPane(layout, "c", "left")).toBe("a");
    expect(neighbourPane(layout, "a", "left")).toBeNull();
  });
});

describe("stored layouts", () => {
  it("round-trips through JSON and drops unknown content kinds", () => {
    const layout = addTab(twoPanes(), "b", { kind: "dashboard" });
    expect(parseLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    const stored = JSON.parse(JSON.stringify(layout));
    stored.root.children[1].tabs.push({ kind: "hologram", id: "x" });
    const parsed = parseLayout(stored);
    expect(parsed && findLeaf(parsed, "b")?.tabs).toEqual([term("t3"), { kind: "dashboard" }]);
  });

  it("refuses malformed layouts", () => {
    expect(parseLayout(null)).toBeNull();
    expect(parseLayout({ schemaVersion: 2, root: makeLeaf(), maximizedPaneId: null, dock: [] })).toBeNull();
    const duplicate = layoutOf({
      kind: "split",
      axis: "horizontal",
      ratios: [500, 500],
      children: [makeLeaf([], "a"), makeLeaf([], "a")],
    });
    expect(validateLayout(duplicate)).toBe("bad_pane_id");
    expect(parseLayout(duplicate)).toBeNull();
    expect(validateLayout({ ...twoPanes(), maximizedPaneId: "zzz" })).toBe("unknown_maximized_pane");
    expect(canSplit(emptyLayout(), "nope", "horizontal")).toBe(false);
  });

  it("the default layout takes contents and validates", () => {
    const start = emptyLayout();
    expectValid(start);
    const paneId = leaves(start.root)[0]?.paneId ?? "";
    const layout = addTab(start, paneId, thread("x"));
    expect(leaves(layout.root)[0]?.tabs).toEqual([thread("x")]);
    expectValid(layout);
  });
});

it("keeps two browser sessions at the same URL distinct and identity stable across navigation", () => {
  const first: PaneContent = { kind: "browser", browserId: "browser-one", url: "http://localhost:3000" };
  const second: PaneContent = { kind: "browser", browserId: "browser-two", url: "http://localhost:3000" };
  expect(contentKey(first)).not.toBe(contentKey(second));
  expect(contentKey({ ...first, url: "http://localhost:5173" } as PaneContent)).toBe(contentKey(first));
  const arranged = arrangeContents(emptyLayout(), [first, second]);
  if (!arranged) throw new Error("browser panes should fit");
  expect(leaves(arranged.root).flatMap((pane) => pane.tabs)).toHaveLength(2);
});

it("updates only the selected browser URL across panes and dock without losing identity", () => {
  const a: PaneContent = { kind: "browser", browserId: "a", url: null };
  const b: PaneContent = { kind: "browser", browserId: "b", url: null };
  const original = { ...layoutOf(makeLeaf([a, b])), dock: [a] };
  const changed = updateBrowserUrl(original, "a", "http://localhost:3000");
  expect(leaves(changed.root)[0]?.tabs).toEqual([{ ...a, url: "http://localhost:3000/" }, b]);
  expect(changed.dock).toEqual([{ ...a, url: "http://localhost:3000/" }]);
  expect(original.dock[0]).toEqual(a);
});
