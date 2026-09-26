import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPane } from "./BrowserPane.tsx";
import type { BrowserBridge, BrowserState } from "./browserBridge.ts";

const browserId = "550e8400-e29b-41d4-a716-446655440000";
const workspaceId = "550e8400-e29b-41d4-a716-446655440001";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterEach(() => vi.unstubAllGlobals());

function nativeState(url = "http://localhost:3000/"): BrowserState {
  return {
    browserId,
    workspaceId,
    url,
    title: "localhost",
    loading: false,
    visible: false,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
  };
}

function testBridge(overrides: Partial<BrowserBridge> = {}): BrowserBridge {
  return {
    attach: vi.fn(async () => nativeState()),
    setView: vi.fn(async () => nativeState()),
    navigate: vi.fn(async (_id, url) => nativeState(url)),
    action: vi.fn(async () => nativeState()),
    focus: vi.fn(async () => true),
    info: vi.fn(async () => nativeState()),
    close: vi.fn(async () => true),
    hideAll: vi.fn(async () => 0),
    openExternal: vi.fn(async () => undefined),
    subscribeFocus: vi.fn(async () => () => undefined),
    ...overrides,
  };
}

function pane(bridge: BrowserBridge) {
  return (
    <BrowserPane
      content={{ kind: "browser", browserId, url: null }}
      workspaceId={workspaceId}
      context={{ paneId: "pane-1", tabId: "tab-1", focused: true, focusRequest: 0 }}
      bridge={bridge}
      visible
      onRequestFocus={() => undefined}
      onUrlChange={() => undefined}
    />
  );
}

describe("BrowserPane address editing", () => {
  it("does not let a late native status response overwrite the address being typed", async () => {
    let resolveAttach: (state: BrowserState) => void = () => undefined;
    const attach = vi.fn(
      () =>
        new Promise<BrowserState>((resolve) => {
          resolveAttach = resolve;
        }),
    );
    const bridge = testBridge({ attach });
    render(pane(bridge));
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    const input = screen.getByLabelText("Web address");
    const user = userEvent.setup();
    await user.click(input);
    await user.clear(input);
    await user.type(input, "http://127.0.0.1:5173/app?draft=true#form");

    await act(async () => resolveAttach(nativeState()));

    expect(input).toHaveValue("http://127.0.0.1:5173/app?draft=true#form");
  });

  it("updates native x/y after a position-only pane move", async () => {
    let x = 24;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("type") === "button" && this.getAttribute("aria-label")?.startsWith("Browser")) {
        return { x, y: 80, left: x, top: 80, right: x + 700, bottom: 580, width: 700, height: 500, toJSON() {} };
      }
      return { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 700, width: 1200, height: 700, toJSON() {} };
    });
    const setView = vi.fn(async (request: Parameters<BrowserBridge["setView"]>[0]) => ({
      ...nativeState(),
      bounds: request.bounds,
      visible: request.visible,
    }));
    const bridge = testBridge({ setView });
    const view = render(pane(bridge));
    await waitFor(() => expect(setView).toHaveBeenCalled());
    setView.mockClear();

    x = 468;
    await act(async () => {
      view.container.firstElementChild?.setAttribute("class", "pane-moved");
    });

    await waitFor(() => expect(setView.mock.calls.some(([request]) => request.bounds.x === 468)).toBe(true));
  });

  it("issues a priority hide while an ordinary geometry update is still pending", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("type") === "button" && this.getAttribute("aria-label")?.startsWith("Browser")) {
        return { x: 20, y: 60, left: 20, top: 60, right: 820, bottom: 660, width: 800, height: 600, toJSON() {} };
      }
      return { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 700, width: 1200, height: 700, toJSON() {} };
    });
    let resolveFirst: (state: BrowserState) => void = () => undefined;
    const setView = vi.fn((request: Parameters<BrowserBridge["setView"]>[0]) => {
      if (setView.mock.calls.length === 1) {
        return new Promise<BrowserState>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ ...nativeState(), bounds: request.bounds, visible: request.visible });
    });
    const bridge = testBridge({ setView });
    render(pane(bridge));
    await waitFor(() => expect(setView).toHaveBeenCalledTimes(1));

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    await act(async () => {
      document.body.append(dialog);
    });
    await waitFor(() =>
      expect(setView.mock.calls.some(([request], index) => index > 0 && request.visible === false)).toBe(true),
    );

    const priorityHide = setView.mock.calls.find(([request], index) => index > 0 && request.visible === false)?.[0];
    if (!priorityHide) throw new Error("Priority browser hide was not sent.");
    await act(async () => {
      dialog.remove();
      resolveFirst(nativeState());
    });
    await waitFor(() =>
      expect(
        setView.mock.calls.some(
          ([request]) => request.visible && request.visibilityVersion > priorityHide.visibilityVersion,
        ),
      ).toBe(true),
    );
  });

  it("never lets queued work re-show a browser after its tab unmounts", async () => {
    let resolveFirst: (state: BrowserState) => void = () => undefined;
    const setView = vi.fn((request: Parameters<BrowserBridge["setView"]>[0]) => {
      if (setView.mock.calls.length === 1) {
        return new Promise<BrowserState>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ ...nativeState(), bounds: request.bounds, visible: request.visible });
    });
    const bridge = testBridge({ setView });
    const view = render(pane(bridge));
    await waitFor(() => expect(setView).toHaveBeenCalledTimes(1));

    view.unmount();
    await waitFor(() => expect(setView.mock.calls.some(([request]) => request.visible === false)).toBe(true));
    const cleanupVersion = Math.max(
      ...setView.mock.calls
        .filter(([request]) => request.visible === false)
        .map(([request]) => request.visibilityVersion),
    );
    await act(async () => resolveFirst(nativeState()));

    expect(
      setView.mock.calls
        .filter(([request]) => request.visibilityVersion >= cleanupVersion)
        .every(([request]) => request.visible === false),
    ).toBe(true);
  });

  it("uses a newer native visibility version after a React unmount and remount", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x: 20,
      y: 60,
      left: 20,
      top: 60,
      right: 820,
      bottom: 660,
      width: 800,
      height: 600,
      toJSON() {},
    }));
    const attach = vi.fn(async (_request: Parameters<BrowserBridge["attach"]>[0]) => nativeState());
    const bridge = testBridge({ attach });
    const first = render(pane(bridge));
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
    const firstCall = attach.mock.calls[0];
    if (!firstCall) throw new Error("Browser attach was not called.");
    const firstVersion = firstCall[0].visibilityVersion;
    first.unmount();

    render(pane(bridge));
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    const secondCall = attach.mock.calls[1];
    if (!secondCall) throw new Error("Browser reattach was not called.");
    expect(secondCall[0].visibilityVersion).toBeGreaterThan(firstVersion);
  });

  it("keeps the embedded browser in keyboard order and transfers focus to the native child", async () => {
    const bridge = testBridge();
    render(pane(bridge));
    await waitFor(() => expect(bridge.attach).toHaveBeenCalledTimes(1));

    const surface = screen.getByRole("button", { name: "Browser: localhost" });
    surface.focus();

    expect(bridge.focus).toHaveBeenCalledWith(browserId);
  });

  it("polls native status after attach so completed navigation replaces the loading state", async () => {
    vi.useFakeTimers();
    try {
      const settled = { ...nativeState("http://localhost:3000/two"), title: "Fixture Two" };
      const loading = {
        ...settled,
        url: "http://localhost:3000/one",
        title: "Fixture One",
        loading: true,
      };
      const action = vi.fn(async () => loading);
      const info = vi.fn(async () => settled);
      const bridge = testBridge({ action, info });
      render(pane(bridge));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
      await act(async () => {
        screen.getByRole("button", { name: "Reload" }).click();
        await Promise.resolve();
      });
      expect(screen.getByRole("button", { name: "Stop loading" })).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(751);
      });

      expect(info).toHaveBeenCalledWith(browserId);
      expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
      expect(screen.getByText("Fixture Two")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a bounded attach while an earlier native child is closing", async () => {
    const attach = vi
      .fn<BrowserBridge["attach"]>()
      .mockRejectedValueOnce({
        category: "internal",
        code: "browser_closing",
        message: "That browser pane is closing.",
        retryable: true,
      })
      .mockRejectedValueOnce({
        category: "internal",
        code: "browser_starting",
        message: "That browser pane is still starting.",
        retryable: true,
      })
      .mockResolvedValue(nativeState());
    const bridge = testBridge({ attach });

    render(pane(bridge));

    await waitFor(() => expect(attach).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("KalCode couldn't open this browser pane.")).not.toBeInTheDocument();
  });

  it("does not retry an old visible attach after unmount during backoff", async () => {
    vi.useFakeTimers();
    try {
      const attach = vi.fn<BrowserBridge["attach"]>().mockRejectedValue({
        category: "internal",
        code: "browser_closing",
        message: "That browser pane is closing.",
        retryable: true,
      });
      const view = render(pane(testBridge({ attach })));
      await act(async () => {
        await Promise.resolve();
      });
      expect(attach).toHaveBeenCalledTimes(1);

      view.unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25);
      });

      expect(attach).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
