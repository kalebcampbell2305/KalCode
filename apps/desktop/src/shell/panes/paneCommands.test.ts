import { afterEach, describe, expect, it } from "vitest";
import {
  clearQueuedPaneCommands,
  dispatchPaneCommand,
  listenForPaneCommands,
  type PaneCommand,
  paneCanvasListening,
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
});
