import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Destination } from "./navigation.tsx";
import {
  initialHistory,
  navigationEntryLabel,
  navigationHistoryStorageKey,
  visitLocation,
} from "./navigationHistory.ts";
import { useNavigationHistory } from "./useNavigationHistory.ts";

const visible = new Set<Destination>(["code", "dashboard", "settings", "providers", "threads"]);

describe("navigation history", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

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

  it("restores bounded recent navigation after a remount while exposing the previous session location", () => {
    const key = "kalcode.test.navigation.account-a";
    const first = renderHook(() => useNavigationHistory("dashboard", visible, key));
    act(() => {
      first.result.current.navigate("code");
      first.result.current.navigate("settings");
    });
    first.unmount();

    const restarted = renderHook(() => useNavigationHistory("dashboard", visible, key));
    expect(restarted.result.current.current).toBe("dashboard");
    expect(restarted.result.current.history.map((entry) => entry.destination)).toEqual([
      "dashboard",
      "code",
      "settings",
    ]);
    expect(restarted.result.current.previousSessionLocation?.destination).toBe("settings");
    expect(restarted.result.current.historyIndex).toBe(2);
  });

  it("validates untrusted storage, keeps only visible destinations and strips browser URLs", () => {
    const key = "kalcode.test.navigation.untrusted";
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        index: 3,
        nextId: 99,
        entries: [
          { id: 1, destination: "admin", label: "Hidden" },
          { id: 2, destination: "providers", target: { kind: "provider", tab: "unknown" } },
          {
            id: 3,
            destination: "code",
            workspaceId: "workspace-one",
            target: {
              kind: "pane",
              content: {
                kind: "browser",
                browserId: "browser-one",
                url: "https://example.com/private?token=secret",
                runtimeHandle: 747,
              },
            },
            processId: 747,
          },
          { id: 4, destination: "threads", target: { kind: "thread", threadId: "thread-one" } },
        ],
      }),
    );

    const restored = renderHook(() => useNavigationHistory("dashboard", visible, key));
    expect(restored.result.current.history).toEqual([
      { id: 2, destination: "providers" },
      {
        id: 3,
        destination: "code",
        workspaceId: "workspace-one",
        target: { kind: "pane", content: { kind: "browser", browserId: "browser-one", url: null } },
      },
      { id: 4, destination: "threads", target: { kind: "thread", threadId: "thread-one" } },
    ]);
    expect(JSON.stringify(restored.result.current.history)).not.toContain("example.com");
    expect(JSON.stringify(restored.result.current.history)).not.toContain("runtimeHandle");
    expect(restored.result.current.previousSessionLocation?.target).toEqual({
      kind: "thread",
      threadId: "thread-one",
    });
  });

  it("persists Browser pane identity without persisting its raw URL", () => {
    const key = "kalcode.test.navigation.browser";
    const browser = renderHook(() => useNavigationHistory("code", visible, key));
    act(() =>
      browser.result.current.recordLocation({
        destination: "code",
        workspaceId: "workspace-one",
        target: {
          kind: "pane",
          content: { kind: "browser", browserId: "browser-one", url: "https://example.com/?access_token=secret" },
        },
      }),
    );

    const raw = localStorage.getItem(key);
    expect(raw).not.toContain("example.com");
    expect(raw).not.toContain("secret");
    expect(JSON.parse(raw ?? "{}").entries[0].target.content).toEqual({
      kind: "browser",
      browserId: "browser-one",
      url: null,
    });
  });

  it("falls back safely for malformed storage and does not persist without an explicit key", () => {
    localStorage.setItem("kalcode.test.navigation.malformed", "{not-json");
    const malformed = renderHook(() => useNavigationHistory("dashboard", visible, "kalcode.test.navigation.malformed"));
    expect(malformed.result.current.history).toEqual([{ id: 0, destination: "dashboard" }]);
    expect(malformed.result.current.previousSessionLocation).toBeNull();
    malformed.unmount();

    localStorage.clear();
    const isolated = renderHook(() => useNavigationHistory("dashboard", visible));
    act(() => isolated.result.current.navigate("code"));
    expect(localStorage.length).toBe(0);
  });

  it("keeps navigation histories separated by KalCode account storage key", () => {
    const accountAKey = navigationHistoryStorageKey("account/a");
    const accountBKey = navigationHistoryStorageKey("account/b");
    const accountA = renderHook(() => useNavigationHistory("dashboard", visible, accountAKey));
    act(() => accountA.result.current.navigate("code"));
    accountA.unmount();

    const accountB = renderHook(() => useNavigationHistory("dashboard", visible, accountBKey));
    act(() => accountB.result.current.navigate("providers"));
    accountB.unmount();

    const switched = renderHook(({ storageKey }) => useNavigationHistory("dashboard", visible, storageKey), {
      initialProps: { storageKey: accountAKey },
    });
    expect(switched.result.current.history.map((entry) => entry.destination)).toEqual(["dashboard", "code"]);
    switched.rerender({ storageKey: accountBKey });
    expect(switched.result.current.history.map((entry) => entry.destination)).toEqual(["dashboard", "providers"]);
    expect(switched.result.current.previousSessionLocation?.destination).toBe("providers");
    expect(accountAKey).not.toBe(accountBKey);
  });
});
