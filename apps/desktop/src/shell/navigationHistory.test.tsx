import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Destination } from "./navigation.tsx";
import { initialHistory, navigationEntryLabel, visitLocation } from "./navigationHistory.ts";
import { IS_MAC, useShortcuts } from "./shortcuts.ts";
import { useNavigationHistory } from "./useNavigationHistory.ts";

const visible = new Set<Destination>(["code", "dashboard", "settings", "providers", "threads"]);

describe("navigation history", () => {
  it("refreshes a renamed run without creating a second navigation visit", () => {
    const location = {
      destination: "operations" as const,
      label: "Codex",
      target: { kind: "operations" as const, tab: "runs" as const, runId: "run-one" },
    };
    const original = visitLocation(initialHistory("operations"), location);
    const renamed = visitLocation(original, { ...location, label: "Billing Webhooks" });
    expect(renamed.entries).toHaveLength(original.entries.length);
    expect(renamed.entries[renamed.index]?.id).toBe(original.entries[original.index]?.id);
    expect(renamed.entries[renamed.index]?.label).toBe("Billing Webhooks");
    expect(renamed.nextId).toBe(original.nextId);
  });
  it("resolves renamed agents in old visits without changing their restore identity", () => {
    const visit = {
      id: 9,
      destination: "code" as const,
      workspaceId: "project",
      label: "Claude Code",
      target: { kind: "pane" as const, content: { kind: "agent" as const, agentId: "agent-one" } },
    };
    expect(navigationEntryLabel(visit, new Map([["agent-one", "Fix Login Form"]]))).toBe("Fix Login Form");
    expect(navigationEntryLabel(visit, new Map([["agent-one", "New agent"]]))).toBe("New agent");
    expect(navigationEntryLabel(visit, new Map())).toBe("Claude Code");
    expect(visit.target.content.agentId).toBe("agent-one");
  });
  it("enriches a surface with pane identity, deduplicates URL changes and bounds long sessions", () => {
    let state = initialHistory("code");
    state = visitLocation(state, {
      destination: "code",
      workspaceId: "w1",
      target: { kind: "pane", content: { kind: "browser", browserId: "b1", url: "https://example.com" } },
    });
    expect(state.entries).toHaveLength(1);
    const same = visitLocation(state, {
      destination: "code",
      workspaceId: "w1",
      target: { kind: "pane", content: { kind: "browser", browserId: "b1", url: "https://example.com/next" } },
    });
    expect(same).toBe(state);
    for (let i = 0; i < 250; i += 1) state = visitLocation(state, { destination: "code", workspaceId: `w${i}` });
    expect(state.entries).toHaveLength(200);
    expect(state.index).toBe(199);
  });

  it("replays Back and Forward and replaces the forward branch with a new visit", async () => {
    const { result } = renderHook(() => useNavigationHistory("dashboard", visible));
    act(() => {
      result.current.navigate("code");
      result.current.navigate("settings");
    });
    await act(() => result.current.back());
    expect(result.current.current).toBe("code");
    expect(result.current.canGoForward).toBe(true);
    await act(() => result.current.forward());
    expect(result.current.current).toBe("settings");
    await act(() => result.current.back());
    act(() => result.current.navigate("providers"));
    expect(result.current.history.map((entry) => entry.destination)).toEqual(["dashboard", "code", "providers"]);
    expect(result.current.canGoForward).toBe(false);
  });

  it("replays workspace and live pane identity without duplicating observed visits", async () => {
    const { result } = renderHook(() => useNavigationHistory("code", visible));
    const selected: string[] = [];
    act(() => {
      result.current.registerRestorer((entry) => {
        if (entry.target?.kind !== "pane") return undefined;
        selected.push(entry.workspaceId ?? "");
        result.current.recordLocation(entry);
        return true;
      });
      result.current.recordLocation({
        destination: "code",
        workspaceId: "one",
        target: { kind: "pane", content: { kind: "terminal", terminalId: "t1" } },
      });
      result.current.recordLocation({
        destination: "code",
        workspaceId: "two",
        target: { kind: "pane", content: { kind: "browser", browserId: "b1", url: "about:blank" } },
      });
    });
    await act(() => result.current.back());
    expect(selected).toEqual(["one"]);
    expect(result.current.history).toHaveLength(2);
    await act(() => result.current.forward());
    expect(selected).toEqual(["one", "two"]);
  });

  it("skips closed targets without opening them or clearing forward history", async () => {
    const { result } = renderHook(() => useNavigationHistory("dashboard", visible));
    const restore = vi.fn((entry) => (entry.destination === "code" ? false : undefined));
    act(() => {
      result.current.registerRestorer(restore, "prepare");
      result.current.navigate("code");
      result.current.navigate("settings");
    });
    await act(() => result.current.back());
    expect(result.current.current).toBe("dashboard");
    expect(result.current.history).toHaveLength(3);
    await act(() => result.current.forward());
    expect(result.current.current).toBe("settings");
  });

  it("a newer navigation cancels an asynchronous replay before it can steal focus", async () => {
    const { result } = renderHook(() => useNavigationHistory("dashboard", visible));
    let resolve!: () => void;
    const waiting = new Promise<void>((done) => {
      resolve = done;
    });
    const focus = vi.fn(() => true);
    act(() => {
      result.current.navigate("code");
      result.current.navigate("settings");
      result.current.registerRestorer(async () => {
        await waiting;
        return true;
      }, "prepare");
      result.current.registerRestorer(focus);
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.back();
    });
    act(() => result.current.navigate("providers"));
    await act(async () => {
      resolve();
      await pending;
    });
    expect(result.current.current).toBe("providers");
    expect(focus).not.toHaveBeenCalled();
  });

  it("rapid Back requests advance the pending cursor and only restore the latest target", async () => {
    const { result } = renderHook(() => useNavigationHistory("dashboard", visible));
    let resolve!: () => void;
    const waiting = new Promise<void>((done) => {
      resolve = done;
    });
    act(() => {
      result.current.navigate("code");
      result.current.navigate("settings");
      result.current.registerRestorer(async (entry) => {
        if (entry.destination === "code") await waiting;
        return true;
      }, "prepare");
    });
    let first!: Promise<void>;
    act(() => {
      first = result.current.back();
    });
    await act(() => result.current.back());
    expect(result.current.current).toBe("dashboard");
    await act(async () => {
      resolve();
      await first;
    });
    expect(result.current.current).toBe("dashboard");
    expect(result.current.historyIndex).toBe(0);
  });

  it("restores content focus after navigation controls took focus", async () => {
    const main = document.createElement("main");
    main.id = "main";
    const input = document.createElement("input");
    main.append(input);
    const button = document.createElement("button");
    document.body.append(main, button);
    const { result, unmount } = renderHook(() => useNavigationHistory("settings", visible));
    act(() => {
      input.focus();
      button.focus();
      result.current.navigate("providers");
    });
    await act(() => result.current.back());
    expect(document.activeElement).toBe(input);
    unmount();
    main.remove();
    button.remove();
  });

  it("keeps the original workspace, surface and pane when every Forward target has closed", async () => {
    const { result } = renderHook(() => useNavigationHistory("code", visible));
    let workspace = "one";
    let closed = false;
    const focused: string[] = [];
    act(() => {
      result.current.registerRestorer((entry) => {
        workspace = entry.workspaceId ?? workspace;
        return true;
      }, "prepare");
      result.current.registerRestorer((entry) => {
        if (closed && entry.workspaceId === "two") return false;
        focused.push(entry.workspaceId ?? "");
        return true;
      });
      result.current.recordLocation({
        destination: "code",
        workspaceId: "one",
        target: { kind: "pane", content: { kind: "terminal", terminalId: "one" } },
      });
      result.current.recordLocation({
        destination: "code",
        workspaceId: "two",
        target: { kind: "pane", content: { kind: "terminal", terminalId: "two" } },
      });
    });
    await act(() => result.current.back());
    closed = true;
    await act(() => result.current.forward());
    expect(result.current.historyIndex).toBe(0);
    expect(result.current.current).toBe("code");
    expect(workspace).toBe("one");
    expect(focused).toEqual(["one", "one"]);
  });

  it("keyboard Back replays through asynchronous restorers instead of cancelling itself", async () => {
    const { result } = renderHook(() => {
      const history = useNavigationHistory("dashboard", visible);
      useShortcuts({
        openPalette: () => undefined,
        toggleSidebar: () => undefined,
        back: () => void history.back(),
        forward: () => void history.forward(),
      });
      return history;
    });
    const focus = vi.fn(() => undefined);
    act(() => {
      // Like NavigationBridge: the prepare phase always awaits (workspace activation, thread reads).
      result.current.registerRestorer(async () => undefined, "prepare");
      result.current.registerRestorer(focus);
      result.current.navigate("code");
    });
    const chord = IS_MAC ? { key: "[", metaKey: true } : { key: "ArrowLeft", altKey: true };
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: IS_MAC ? "Meta" : "Alt", bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent("keydown", { ...chord, bubbles: true }));
    });
    await waitFor(() => expect(result.current.current).toBe("dashboard"));
    expect(result.current.historyIndex).toBe(0);
    await waitFor(() =>
      expect(focus).toHaveBeenCalledWith(expect.objectContaining({ destination: "dashboard" }), expect.any(Function)),
    );
  });
});
