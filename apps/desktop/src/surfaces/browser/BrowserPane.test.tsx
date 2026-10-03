import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPane } from "./BrowserPane.tsx";
import type { BrowserBridge, BrowserState } from "./browserBridge.ts";
import type { LiveBrowserServices } from "./useLiveBrowserServices.ts";

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
    inspect: vi.fn(async () => ({ available: true, errorCount: 0, errors: [], picking: false, picked: null })),
    pick: vi.fn(async (_id: string, active: boolean) => active),
    screenshot: vi.fn(async () => ({ path: "C:\\Pictures\\KalCode\\shot.png", fileName: "shot.png" })),
    revealScreenshot: vi.fn(async () => undefined),
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

  it("explains a failed attach with a Retry and an external fallback, and never says Ready", async () => {
    const attach = vi
      .fn<BrowserBridge["attach"]>()
      .mockRejectedValueOnce({
        category: "internal",
        code: "browser_unavailable",
        message: "The embedded browser isn't available on this computer.",
        retryable: false,
      })
      .mockResolvedValue(nativeState());
    const openExternal = vi.fn<BrowserBridge["openExternal"]>(async () => undefined);
    const bridge = testBridge({ attach, openExternal });

    render(pane(bridge));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("KalCode couldn't open this browser pane.");
    expect(failure).toHaveTextContent("The embedded browser isn't available on this computer.");
    expect(screen.getByText("Couldn't open")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open in system browser" }));
    expect(openExternal).toHaveBeenCalledWith("http://localhost:3000/");

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("localhost", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't open")).not.toBeInTheDocument();
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

  it("lets a custom viewport width be typed digit by digit and bounds it when committed", async () => {
    render(pane(testBridge()));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Responsive viewport"), "custom");
    const width = screen.getByLabelText("Custom viewport width");
    expect(width).toHaveValue(900);

    await user.clear(width);
    await user.type(width, "1280");
    expect(width).toHaveValue(1280);
    await user.tab();
    expect(width).toHaveValue(1280);

    await user.clear(width);
    await user.type(width, "90{Enter}");
    expect(width).toHaveValue(320);
    await user.clear(width);
    await user.type(width, "9999");
    await user.tab();
    expect(width).toHaveValue(3840);
    await user.clear(width);
    await user.tab();
    expect(width).toHaveValue(3840);
  });

  it("confirms Copy URL, and reports a clipboard that refuses", async () => {
    render(pane(testBridge()));
    const user = userEvent.setup();
    // user-event installs its own clipboard; observe that one.
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await waitFor(() => expect(screen.getByText("localhost", { selector: "span" })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Copy URL" }));
    expect(writeText).toHaveBeenCalledWith("http://localhost:3000/");
    expect(await screen.findByRole("button", { name: "URL copied" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy URL" })).toBeInTheDocument(), {
      timeout: 2500,
    });

    writeText.mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy URL" }));
    expect(await screen.findByText("KalCode couldn't copy the address.")).toBeInTheDocument();
  });
});

describe("Live Browser", () => {
  const agent = {
    threadId: "agent-1",
    name: "Claude Code 2",
    providerId: "claude-code",
    providerName: "Claude Code",
    accountLabel: null,
    lastActivityAt: "2026-10-03T10:00:00Z",
    terminalId: "pty-1",
  };

  function services(overrides: Partial<LiveBrowserServices> = {}): LiveBrowserServices {
    return {
      snapshot: {
        services: [],
        environments: [
          {
            workspaceId,
            kind: "production",
            branch: "main",
            version: null,
            urls: ["https://atlas.dev"],
            deploymentStatus: "deployed_unverified",
            health: "not_probed",
            platform: "Cloudflare Pages",
            lastDeploy: null,
            runId: null,
            variables: [],
            observedAt: "2026-10-03T10:00:00Z",
            notes: [],
          },
        ],
      },
      listAgents: vi.fn(async () => [agent]),
      ask: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  function livePane(bridge: BrowserBridge, live: LiveBrowserServices) {
    return (
      <BrowserPane
        content={{ kind: "browser", browserId, url: null }}
        workspaceId={workspaceId}
        context={{ paneId: "pane-1", tabId: "tab-1", focused: true, focusRequest: 0 }}
        bridge={bridge}
        visible
        onRequestFocus={() => undefined}
        onUrlChange={() => undefined}
        services={live}
      />
    );
  }

  beforeEach(() => {
    localStorage.clear();
    // jsdom lays nothing out; give the stage a real size so the pane counts as visible.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 60, 800, 500));
  });
  afterEach(() => vi.restoreAllMocks());

  it("attaches a picked element, errors and a screenshot, then asks the agent in one prompt", async () => {
    const user = userEvent.setup();
    const picked = {
      selector: "main > button.pay",
      tag: "button",
      text: "Pay now",
      html: '<button class="pay">Pay now</button>',
    };
    let picking = false;
    const bridge = testBridge({
      pick: vi.fn(async (_id: string, active: boolean) => {
        picking = active;
        return active;
      }),
      inspect: vi.fn(async () => {
        const result = {
          available: true,
          errorCount: 2,
          errors: ["TypeError: cart is undefined", "Failed to load img /logo.png"],
          picking: false,
          picked: picking ? picked : null,
        };
        picking = false;
        return result;
      }),
    });
    const live = services();
    render(livePane(bridge, live));
    await waitFor(() => expect(bridge.attach).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "2 console errors" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Take screenshot" }));
    expect(await screen.findByText("Screenshot saved.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Pick an element" }));
    const element = await screen.findByText("button.pay", {}, { timeout: 3_000 });
    expect(element.tagName).toBe("CODE");
    expect(screen.getByRole("region", { name: "Ask an agent about this page" })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByLabelText("Agent")).toHaveValue("agent-1"));
    await user.type(screen.getByLabelText("Question"), "Why is pay disabled?{Enter}");
    await waitFor(() => expect(live.ask).toHaveBeenCalledTimes(1));
    const [askedAgent, prompt] = (live.ask as ReturnType<typeof vi.fn>).mock.calls[0] as [typeof agent, string];
    expect(askedAgent.threadId).toBe("agent-1");
    expect(prompt).toContain("Why is pay disabled?");
    expect(prompt).toContain("Selected element: main > button.pay");
    expect(prompt).toContain("Console errors (2)");
    expect(prompt).toContain("Screenshot of the page: C:\\Pictures\\KalCode\\shot.png");
    expect(await screen.findByText("Sent to Claude Code 2.")).toBeInTheDocument();
  });

  it("offers to launch an agent when none is running", async () => {
    const user = userEvent.setup();
    render(livePane(testBridge(), services({ listAgents: vi.fn(async () => []) })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ask Agent" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Ask Agent" }));
    expect(await screen.findByText("No coding agent is running in this workspace.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch an agent" })).toBeInTheDocument();
  });

  it("switches targets in one click and asks once for an unknown URL, then remembers it", async () => {
    const user = userEvent.setup();
    const bridge = testBridge();
    render(livePane(bridge, services()));
    await waitFor(() => expect(bridge.attach).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: "Local" })).toHaveAttribute("aria-pressed", "true"));

    await user.click(screen.getByRole("button", { name: "Production" }));
    expect(bridge.navigate).toHaveBeenCalledWith(browserId, "https://atlas.dev/");

    await user.click(screen.getByRole("button", { name: "Preview" }));
    const address = screen.getByLabelText("Web address");
    expect(address).toHaveAttribute("placeholder", "Enter your Preview URL");
    await user.type(address, "pr-7.atlas.dev{Enter}");
    expect(bridge.navigate).toHaveBeenCalledWith(browserId, "https://pr-7.atlas.dev/");
    expect(JSON.parse(localStorage.getItem(`kalcode.liveBrowser.targets.${workspaceId}`) ?? "{}")).toMatchObject({
      preview: "https://pr-7.atlas.dev/",
    });
  });

  it("guides Google sign-in to the system browser without touching credentials", async () => {
    const user = userEvent.setup();
    const bridge = testBridge({
      attach: vi.fn(async () => nativeState("http://localhost:3000/login")),
      info: vi.fn(async () => nativeState("https://accounts.google.com/v3/signin/rejected?rrk=46")),
    });
    render(livePane(bridge, services()));
    expect(
      await screen.findByText("Google blocked sign-in in this embedded browser.", {}, { timeout: 3_000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue in browser" }));
    // The site's own page goes to the system browser, never Google's rejection page.
    expect(bridge.openExternal).toHaveBeenCalledWith("http://localhost:3000/login");
  });

  it("explains a denied sign-in pop-up and can open it in the pane instead", async () => {
    const user = userEvent.setup();
    const popup = "https://accounts.google.com/o/oauth2/v2/auth?client_id=demo";
    const bridge = testBridge({
      attach: vi.fn(async () => ({ ...nativeState(), blockedPopup: popup, blockedPopupSeq: 1 })),
      info: vi.fn(async () => ({ ...nativeState(), blockedPopup: popup, blockedPopupSeq: 1 })),
    });
    render(livePane(bridge, services()));
    expect(await screen.findByText("accounts.google.com wants to open a sign-in window.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open here" }));
    expect(bridge.navigate).toHaveBeenCalledWith(browserId, popup);
  });
});
