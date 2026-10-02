import { afterEach, describe, expect, it } from "vitest";
import { computeGeometry, findLeaf, leaves, makeLeaf, setCollapsed } from "./model.ts";
import {
  activateAndDispatchPaneCommand,
  applyPaneControl,
  clearQueuedPaneCommands,
  dispatchPaneCommand,
  listenForPaneCommands,
  type PaneCommand,
  paneCanvasListening,
  paneQueryCandidates,
  providerPaneAliases,
  resolvePaneQuery,
  resolvePaneTabQuery,
  selectDistinctProviderThreads,
} from "./paneCommands.ts";

const split: PaneCommand = { kind: "split", axis: "horizontal" };

describe("pane command bus", () => {
  afterEach(() => clearQueuedPaneCommands());

  it("reports that nothing handled a command when no canvas listens", () => {
    expect(paneCanvasListening()).toBe(false);
    expect(dispatchPaneCommand(split)).toEqual({ handled: false, message: "Open Code to arrange panes." });
  });

  it("delivers to the canvas on screen; the newest registration wins", () => {
    const first: PaneCommand[] = [];
    const second: PaneCommand[] = [];
    const stopFirst = listenForPaneCommands((c) => {
      first.push(c);
      return { handled: true };
    });
    const stopSecond = listenForPaneCommands((c) => {
      second.push(c);
      return { handled: true };
    });
    dispatchPaneCommand(split);
    expect(first).toEqual([]);
    expect(second).toEqual([split]);
    // An older canvas unmounting doesn't unregister the newer one.
    stopFirst();
    expect(paneCanvasListening()).toBe(true);
    stopSecond();
    expect(paneCanvasListening()).toBe(false);
  });

  it("delivers bounded browser controls without widening them into script authority", () => {
    const received: PaneCommand[] = [];
    const stop = listenForPaneCommands((command) => {
      received.push(command);
      return { handled: true };
    }, "workspace-a");
    const command: PaneCommand = {
      kind: "browser-control",
      command: { kind: "reload", browserId: "0192f3c4-0000-7000-8000-00000000000c" },
    };

    expect(dispatchPaneCommand(command, { scope: "workspace-a" })).toEqual({ handled: true });
    expect(received).toEqual([command]);
    expect(JSON.stringify(received)).not.toContain("script");
    stop();
  });

  it("queues a command until a canvas mounts, and a scoped one until that workspace's canvas mounts", () => {
    expect(dispatchPaneCommand(split, { queue: true })).toEqual({ handled: true });
    const open: PaneCommand = { kind: "open", content: { kind: "dashboard" } };
    dispatchPaneCommand(open, { queue: true, scope: "ws-b" });

    const a: PaneCommand[] = [];
    const stopA = listenForPaneCommands((c) => {
      a.push(c);
      return { handled: true };
    }, "ws-a");
    // Workspace A's canvas takes the unscoped command, not B's.
    expect(a).toEqual([split]);
    expect(paneCanvasListening("ws-b")).toBe(false);
    // While A is on screen, a command scoped to B keeps waiting.
    dispatchPaneCommand({ kind: "even" }, { queue: true, scope: "ws-b" });
    expect(a).toEqual([split]);
    stopA();

    const b: PaneCommand[] = [];
    const stopB = listenForPaneCommands((c) => {
      b.push(c);
      return { handled: true };
    }, "ws-b");
    expect(b).toEqual([open, { kind: "even" }]);
    stopB();
  });

  it("keeps a scoped command queued instead of delivering it to the visible wrong workspace", () => {
    const wrong: PaneCommand[] = [];
    const stopWrong = listenForPaneCommands((command) => {
      wrong.push(command);
      return { handled: true };
    }, "workspace-a");

    expect(dispatchPaneCommand({ kind: "maximize" }, { queue: true, scope: "workspace-b" })).toEqual({
      handled: true,
    });
    expect(wrong).toEqual([]);
    stopWrong();

    const right: PaneCommand[] = [];
    const stopRight = listenForPaneCommands((command) => {
      right.push(command);
      return { handled: true };
    }, "workspace-b");
    expect(right).toEqual([{ kind: "maximize" }]);
    stopRight();
  });

  it("awaits named workspace activation before navigating and queues only for that workspace", async () => {
    const order: string[] = [];
    const wrong: PaneCommand[] = [];
    const stopWrong = listenForPaneCommands((command) => {
      wrong.push(command);
      return { handled: true };
    }, "workspace-a");

    const result = await activateAndDispatchPaneCommand(
      "workspace-b",
      { kind: "restore" },
      async (workspaceId) => {
        order.push(`activate:${workspaceId}`);
        return true;
      },
      () => order.push("navigate"),
    );
    expect(result).toEqual({ handled: true });
    expect(order).toEqual(["activate:workspace-b", "navigate"]);
    expect(wrong).toEqual([]);
    stopWrong();

    const right: PaneCommand[] = [];
    const stopRight = listenForPaneCommands((command) => {
      right.push(command);
      return { handled: true };
    }, "workspace-b");
    expect(right).toEqual([{ kind: "restore" }]);
    stopRight();
  });

  it("does not navigate or dispatch when workspace activation fails", async () => {
    let navigated = false;
    const result = await activateAndDispatchPaneCommand(
      "missing",
      { kind: "restore" },
      async () => false,
      () => {
        navigated = true;
      },
    );
    expect(result).toEqual({ handled: false, message: "Couldn't switch to that workspace." });
    expect(navigated).toBe(false);
  });

  it("reports the eventual result of a queued scoped command", async () => {
    const results: { handled: boolean; message?: string }[] = [];
    await activateAndDispatchPaneCommand(
      "workspace-b",
      { kind: "maximize" },
      async () => true,
      () => undefined,
      (result) => results.push(result),
    );
    expect(results).toEqual([]);

    const stop = listenForPaneCommands(
      () => ({ handled: false, message: "No pane matches “Codex 2”." }),
      "workspace-b",
    );
    expect(results).toEqual([{ handled: false, message: "No pane matches “Codex 2”." }]);
    stop();
  });

  it("reports when queue pressure drops an older command instead of silently succeeding", () => {
    const results: { handled: boolean; message?: string }[] = [];
    for (let index = 0; index < 9; index++) {
      dispatchPaneCommand(
        { kind: "open", content: { kind: "widget", widgetId: `widget-${index}` } },
        { queue: true, scope: "workspace", onResult: (result) => results.push(result) },
      );
    }

    expect(results).toEqual([{ handled: false, message: "That pane command expired before Code was ready." }]);
  });

  it("never delivers a cancelled queued close when its canvas later mounts", () => {
    const controller = new AbortController();
    const received: PaneCommand[] = [];
    dispatchPaneCommand({ kind: "close" }, { queue: true, scope: "workspace", signal: controller.signal });
    controller.abort();
    const stop = listenForPaneCommands((command) => {
      received.push(command);
      return { handled: true };
    }, "workspace");
    stop();
    expect(received).toEqual([]);
  });

  it("cancellation during workspace activation prevents navigation and queued commands", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const result = await activateAndDispatchPaneCommand(
      "workspace",
      { kind: "close" },
      async () => {
        controller.abort();
        return true;
      },
      () => order.push("navigate"),
      () => order.push("report"),
      controller.signal,
    );
    const stop = listenForPaneCommands(() => {
      order.push("close");
      return { handled: true };
    }, "workspace");
    stop();
    expect(result.handled).toBe(false);
    expect(order).toEqual([]);
  });
});

describe("pane query resolution", () => {
  const layout = {
    schemaVersion: 1 as const,
    root: {
      kind: "split" as const,
      axis: "horizontal" as const,
      ratios: [500, 500],
      children: [
        makeLeaf(
          [
            { kind: "terminal" as const, terminalId: "shell" },
            { kind: "thread" as const, threadId: "codex-two" },
          ],
          "left",
        ),
        makeLeaf([{ kind: "thread" as const, threadId: "claude-one" }], "right"),
      ],
    },
    maximizedPaneId: null,
    dock: [],
  };

  it("finds an inactive tab by its exact title and provider ordinal alias", () => {
    const names = new Map([
      ["terminal:shell", { title: "PowerShell", aliases: [] }],
      ["thread:codex-two", { title: "Fix authentication", aliases: ["Codex 2"] }],
      ["thread:claude-one", { title: "Review API", aliases: ["Claude 1", "Claude Code 1"] }],
    ]);
    const candidates = paneQueryCandidates(layout, (key) => names.get(key) ?? null);

    expect(resolvePaneQuery("Fix authentication", candidates)).toEqual({ kind: "found", paneId: "left" });
    expect(resolvePaneQuery("codex 2", candidates)).toEqual({ kind: "found", paneId: "left" });
    expect(resolvePaneQuery("Claude 1", candidates)).toEqual({ kind: "found", paneId: "right" });
  });

  it("builds stable oldest-first provider ordinal aliases", () => {
    const aliases = providerPaneAliases(
      [
        { threadId: "codex-old", providerId: "codex" },
        { threadId: "claude-old", providerId: "claude-code" },
        { threadId: "codex-new", providerId: "codex" },
        { threadId: "claude-new", providerId: "claude-code" },
      ],
      (providerId) =>
        providerId === "codex" ? { full: "Codex", short: "Codex" } : { full: "Claude Code", short: "Claude" },
    );

    expect([...aliases]).toEqual([
      ["thread:codex-old", ["Codex 1"]],
      ["thread:claude-old", ["Claude Code 1", "Claude 1"]],
      ["thread:codex-new", ["Codex 2"]],
      ["thread:claude-new", ["Claude Code 2", "Claude 2"]],
    ]);
  });

  it("prefers an exact match and rejects an ambiguous partial match without selecting a pane", () => {
    const candidates = [
      { paneId: "a", names: ["Codex 2", "Investigate login"] },
      { paneId: "b", names: ["Codex 20", "Investigate logout"] },
    ];

    expect(resolvePaneQuery("Codex 2", candidates)).toEqual({ kind: "found", paneId: "a" });
    expect(resolvePaneQuery("investigate", candidates)).toEqual({ kind: "ambiguous" });
    expect(resolvePaneQuery("missing", candidates)).toEqual({ kind: "missing" });
  });

  it("resolves a named tab without collapsing two tabs in one pane into a single target", () => {
    const candidates = [
      { paneId: "shared", tabIndex: 0, names: ["Agent frontend"] },
      { paneId: "shared", tabIndex: 1, names: ["Agent release"] },
    ];

    expect(resolvePaneTabQuery("Agent release", candidates)).toEqual({
      kind: "found",
      paneId: "shared",
      tabIndex: 1,
    });
    expect(resolvePaneTabQuery("agent", candidates)).toEqual({ kind: "ambiguous" });
  });

  it("applies named resize, move, collapse and expand to only the resolved pane", () => {
    const candidates = [
      { paneId: "left", names: ["Codex 2"] },
      { paneId: "right", names: ["Claude 1"] },
    ];
    const beforeWidth = computeGeometry(layout, 1006, 600).panes.get("left")?.width ?? 0;
    const resized = applyPaneControl(layout, { kind: "resize", query: "Codex 2", grow: true }, candidates, "right", {
      width: 1006,
      height: 600,
    });
    expect(resized.handled).toBe(true);
    if (!resized.handled) return;
    expect(computeGeometry(resized.layout, 1006, 600).panes.get("left")?.width).toBeGreaterThan(beforeWidth);

    const moved = applyPaneControl(
      resized.layout,
      { kind: "move", query: "Codex 2", beside: "Claude 1" },
      candidates,
      "left",
      { width: 1006, height: 600 },
    );
    expect(moved.handled).toBe(true);
    if (!moved.handled) return;
    expect(leaves(moved.layout.root).map((leaf) => leaf.paneId)).toEqual(["right", "left"]);

    const collapsed = applyPaneControl(moved.layout, { kind: "collapse", query: "Codex 2" }, candidates, "right", {
      width: 1006,
      height: 600,
    });
    expect(collapsed.handled).toBe(true);
    if (!collapsed.handled) return;
    expect(findLeaf(collapsed.layout, "left")?.collapsed).toBe(true);
    expect(findLeaf(collapsed.layout, "right")?.collapsed).toBe(false);

    const expanded = applyPaneControl(collapsed.layout, { kind: "expand", query: "Codex 2" }, candidates, "right", {
      width: 1006,
      height: 600,
    });
    expect(expanded.handled).toBe(true);
    if (!expanded.handled) return;
    expect(findLeaf(expanded.layout, "left")?.collapsed).toBe(false);

    const maximized = applyPaneControl(expanded.layout, { kind: "maximize", query: "Claude 1" }, candidates, "left", {
      width: 1006,
      height: 600,
    });
    expect(maximized.handled).toBe(true);
    if (!maximized.handled) return;
    expect(maximized.layout.maximizedPaneId).toBe("right");
    const restored = applyPaneControl(maximized.layout, { kind: "restore", query: null }, candidates, "right", {
      width: 1006,
      height: 600,
    });
    expect(restored.handled && restored.layout.maximizedPaneId).toBeNull();
  });

  it("does not mutate the layout when a named control is ambiguous or cannot change state", () => {
    const ambiguous = [
      { paneId: "left", names: ["Review"] },
      { paneId: "right", names: ["Review"] },
    ];
    expect(
      applyPaneControl(layout, { kind: "maximize", query: "Review" }, ambiguous, "left", { width: 1006, height: 600 }),
    ).toEqual({ handled: false, message: "More than one pane matches “Review”." });

    const collapsed = setCollapsed(layout, "left", true);
    const noChange = applyPaneControl(
      collapsed,
      { kind: "collapse", query: "Codex 2" },
      [
        { paneId: "left", names: ["Codex 2"] },
        { paneId: "right", names: ["Claude 1"] },
      ],
      "right",
      { width: 1006, height: 600 },
    );
    expect(noChange).toEqual({ handled: true, layout: collapsed, paneId: "left" });
  });
});

describe("legacy provider selection", () => {
  it("selects a different existing thread for every repeated provider request", () => {
    const selected = selectDistinctProviderThreads(
      ["codex", "codex", "claude-code"],
      [
        { threadId: "codex-old", providerId: "codex" },
        { threadId: "claude", providerId: "claude-code" },
        { threadId: "codex-new", providerId: "codex" },
      ],
    );

    expect(selected).toEqual({ threadIds: ["codex-new", "codex-old", "claude"], missing: [] });
  });
});
