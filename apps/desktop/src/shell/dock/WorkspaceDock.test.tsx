import type { ThreadSummary } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { thread } from "../../surfaces/dashboard/data/testing.ts";
import { DeckUiProvider, useDeckUi } from "../deck/DeckUi.tsx";
import { applyDockLayout, type DockLayout, defaultDockLayout, dockStorageKey, saveDockLayout } from "./layout.ts";
import { WorkspaceDock } from "./WorkspaceDock.tsx";

const mocks = vi.hoisted(() => ({
  threads: [] as ThreadSummary[],
  browserMounts: vi.fn(),
  closeBrowser: vi.fn(async (_browserId: string) => true),
}));

vi.mock("../../runtime/RuntimeProvider.tsx", () => ({ useOptionalRuntime: () => null }));
vi.mock("../../surfaces/dashboard/data/DashboardData.tsx", () => ({
  useCodingAgents: () => ({ state: { status: "ready", data: mocks.threads }, reload: vi.fn() }),
  useArchivedCodingAgents: () => ({ state: { status: "ready", data: [] } }),
}));
vi.mock("../attention/useAttention.ts", () => ({ useAttention: () => ({ ready: false, items: [] }) }));
vi.mock("../deck/DeckData.tsx", () => ({
  useDeckData: () => ({ operations: { data: null, failed: false } }),
}));
vi.mock("../panes/useOpenInPane.ts", () => ({ useOpenInPane: () => vi.fn(async () => ({ handled: true })) }));
vi.mock("../navigation.tsx", () => ({ useNavigation: () => ({ current: "code", navigate: vi.fn() }) }));
vi.mock("../../runtime/uiIntents.tsx", () => ({ useOptionalUiIntents: () => null }));
vi.mock("../../surfaces/code/useLaunchAgent.ts", () => ({ useLaunchAgent: () => vi.fn() }));
vi.mock("@kalcode/ui/components", async (original) => ({
  ...(await original<typeof import("@kalcode/ui/components")>()),
  useToast: () => ({ show: vi.fn() }),
}));
vi.mock("../deck/DockSurfaces.tsx", async (original) => ({
  ...(await original<typeof import("../deck/DockSurfaces.tsx")>()),
  DockSurface: ({ id }: { id: string }) => <div>{id} surface</div>,
}));
vi.mock("../../surfaces/browser/index.ts", async (original) => {
  const React = await import("react");
  const actual = await original<typeof import("../../surfaces/browser/index.ts")>();
  return {
    ...actual,
    createBrowserBridge: () => ({ close: mocks.closeBrowser }),
    BrowserPane: (props: { visible: boolean; onUrlChange: (url: string) => void }) => {
      React.useEffect(() => {
        mocks.browserMounts();
      }, []);
      return (
        <div data-testid="browser-pane" data-visible={String(props.visible)}>
          Live Browser
          <button type="button" onClick={() => props.onUrlChange("http://localhost:4173/app?secret=yes#token")}>
            Navigate test browser
          </button>
        </div>
      );
    },
  };
});

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const WS = "kalcode";
const working = () => thread({ name: "Busy", status: "editing", runtimeKind: "interactive_pty" });
const idle = () => thread({ name: "Quiet", status: "idle", runtimeKind: "interactive_pty" });

function Reveal() {
  const deck = useDeckUi();
  return (
    <button type="button" onClick={deck.revealAgents}>
      Reveal agents
    </button>
  );
}

const tree = (workspaceId: string | null = WS) => (
  <TooltipProvider>
    <DeckUiProvider>
      <WorkspaceDock workspaceId={workspaceId} />
      <Reveal />
    </DeckUiProvider>
  </TooltipProvider>
);

const collapsed = () => screen.queryByRole("complementary", { name: "Workspace dock (collapsed)" });
const openDock = (label = "Agents") => screen.queryByRole("complementary", { name: `Workspace dock, ${label}` });
const tabNames = () => screen.getAllByRole("tab").map((tab) => (tab.textContent ?? "").trim());
const stored = (workspaceId: string | null = WS): DockLayout =>
  JSON.parse(localStorage.getItem(dockStorageKey(workspaceId)) ?? "null");

function seed(change: (layout: DockLayout) => DockLayout, workspaceId: string | null = WS) {
  saveDockLayout(workspaceId, change(defaultDockLayout()));
}
const withTabs = (layout: DockLayout, ids: readonly Parameters<typeof applyDockLayout>[1][]) =>
  ids.reduce((next, change) => applyDockLayout(next, change), layout);

async function addTab(label: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add to dock" }));
  await user.click(await screen.findByRole("menuitem", { name: label }));
}

/** Menu-driven flows take ~1.5 s alone; give them room on a loaded gate worker. */
const SLOW_UI = 30_000;

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  mocks.threads = [];
  mocks.browserMounts.mockClear();
  mocks.closeBrowser.mockClear();
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

describe("WorkspaceDock follows the agents until the person chooses", () => {
  it(
    "stays a rail while no agent runs, opens when one works, and folds back",
    () => {
      mocks.threads = [idle()];
      const view = render(tree());
      expect(collapsed()).toBeInTheDocument();

      mocks.threads = [idle(), working()];
      view.rerender(tree());
      expect(collapsed()).toBeNull();
      expect(openDock()).toHaveAttribute("id", "deck-agents");

      mocks.threads = [idle()];
      view.rerender(tree());
      expect(collapsed()).toBeInTheDocument();
    },
    SLOW_UI,
  );

  it("stays a rail while a just-launched agent is only starting", () => {
    const view = render(tree());
    mocks.threads = [thread({ name: "Launching", status: "starting", runtimeKind: "interactive_pty" })];
    view.rerender(tree());
    expect(collapsed()).toBeInTheDocument();
    expect(collapsed()).not.toHaveAttribute("data-open");
  });

  it("opens when something needs the person", () => {
    mocks.threads = [thread({ name: "Ask", status: "waiting_for_user", runtimeKind: "interactive_pty" })];
    render(tree());
    expect(collapsed()).toBeNull();
    expect(openDock()).toBeInTheDocument();
  });

  it("respects a manual collapse while agents work, across remounts", async () => {
    mocks.threads = [working()];
    const view = render(tree());
    await userEvent.setup().click(screen.getByRole("button", { name: "Collapse dock" }));
    expect(collapsed()).toBeInTheDocument();
    expect(stored().collapsed).toBe(true);
    view.unmount();
    render(tree());
    expect(collapsed()).toBeInTheDocument();
  });

  it("respects a manual open with nothing running, across remounts", async () => {
    const view = render(tree());
    await userEvent.setup().click(screen.getByRole("button", { name: "Show dock" }));
    expect(openDock()).toBeInTheDocument();
    expect(screen.getByText("No agents running")).toBeVisible();
    expect(stored().collapsed).toBe(false);
    view.unmount();
    render(tree());
    expect(collapsed()).toBeNull();
    expect(openDock()).toBeInTheDocument();
  });

  it("keeps a narrow window's rail even when an agent works", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
    mocks.threads = [working()];
    render(tree());
    expect(collapsed()).toBeInTheDocument();
  });

  it("shows a live badge on the Agents tab", () => {
    mocks.threads = [working()];
    render(tree());
    expect(screen.getByRole("tab", { name: "Agents, 1 working" })).toBeInTheDocument();
  });
});

describe("WorkspaceDock tabs", () => {
  it("opens on Agents, then + Browser adds and activates it and mounts the pane once", async () => {
    seed((layout) => ({ ...layout, collapsed: false }));
    render(tree());
    expect(tabNames()).toEqual(["Agents"]);
    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("browser-pane")).toBeNull();

    await addTab("Browser");

    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("browser-pane")).toHaveAttribute("data-visible", "true");
    expect(openDock("Browser")).toBeInTheDocument();
    expect(mocks.browserMounts).toHaveBeenCalledTimes(1);
    expect(stored().width).toBe(520);
  });

  it(
    "keeps Browser mounted but hidden when switching away, without remounting",
    async () => {
      seed((layout) => ({ ...layout, collapsed: false }));
      const user = userEvent.setup();
      render(tree());
      await addTab("Browser");
      await user.click(screen.getByRole("tab", { name: "Agents" }));

      const pane = screen.getByTestId("browser-pane");
      expect(pane).toHaveAttribute("data-visible", "false");
      expect(mocks.browserMounts).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole("tab", { name: "Browser" }));
      expect(screen.getByTestId("browser-pane")).toBe(pane);
      expect(pane).toHaveAttribute("data-visible", "true");
      expect(mocks.browserMounts).toHaveBeenCalledTimes(1);
    },
    SLOW_UI,
  );

  it(
    "offers Browser only when there is a project",
    async () => {
      const user = userEvent.setup();
      const view = render(tree(null));
      await user.click(screen.getByRole("button", { name: "Show dock" }));
      await user.click(screen.getByRole("button", { name: "Add to dock" }));
      expect(await screen.findByRole("menuitem", { name: "Runs" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Browser" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "Git" })).toBeNull();
      await user.keyboard("{Escape}");
      view.unmount();

      // A project's first dock starts the way the person last left the dock: open.
      render(tree(WS));
      expect(screen.queryByRole("button", { name: "Show dock" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Add to dock" }));
      expect(await screen.findByRole("menuitem", { name: "Browser" })).toBeInTheDocument();
    },
    SLOW_UI,
  );

  it(
    "restores tabs, order, active tab, width and collapse per workspace",
    async () => {
      seed((layout) => ({ ...layout, collapsed: false }));
      const user = userEvent.setup();
      const view = render(tree());
      await addTab("Browser");
      await addTab("Runs");
      fireEvent.keyDown(screen.getByRole("tab", { name: "Runs" }), { key: "ArrowLeft", altKey: true });
      expect(tabNames()).toEqual(["Agents", "Runs", "Browser"]);
      await user.click(screen.getByRole("tab", { name: "Browser" }));
      fireEvent.keyDown(screen.getByRole("separator", { name: "Resize workspace dock" }), { key: "ArrowLeft" });
      await user.click(screen.getByRole("button", { name: "Collapse dock" }));
      view.unmount();

      expect(stored()).toMatchObject({
        tabs: ["agents", "runs", "browser"],
        active: "browser",
        width: 544,
        collapsed: true,
      });

      render(tree());
      expect(collapsed()).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Show dock" }));
      expect(tabNames()).toEqual(["Agents", "Runs", "Browser"]);
      expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("separator", { name: "Resize workspace dock" })).toHaveAttribute("aria-valuenow", "544");
    },
    SLOW_UI,
  );

  it("gives a different workspace its own default layout", async () => {
    seed((layout) => withTabs({ ...layout, collapsed: false }, [{ kind: "add", id: "runs" }]));
    const view = render(tree(WS));
    expect(tabNames()).toEqual(["Agents", "Runs"]);
    view.unmount();

    render(tree("website"));
    expect(localStorage.getItem(dockStorageKey("website"))).toBeNull();
    expect(collapsed()).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show dock" }));
    expect(tabNames()).toEqual(["Agents"]);
  });

  it("reorders with Alt+Arrow and keeps focus on the moved tab", async () => {
    seed((layout) =>
      withTabs({ ...layout, collapsed: false }, [
        { kind: "add", id: "runs" },
        { kind: "add", id: "git" },
        { kind: "activate", id: "agents" },
      ]),
    );
    render(tree());
    expect(tabNames()).toEqual(["Agents", "Runs", "Git"]);

    fireEvent.keyDown(screen.getByRole("tab", { name: "Agents" }), { key: "ArrowRight", altKey: true });
    expect(tabNames()).toEqual(["Runs", "Agents", "Git"]);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Agents" })).toHaveFocus());

    fireEvent.keyDown(screen.getByRole("tab", { name: "Git" }), { key: "ArrowLeft", altKey: true });
    expect(tabNames()).toEqual(["Runs", "Git", "Agents"]);
    // Past the edges it stays put.
    fireEvent.keyDown(screen.getByRole("tab", { name: "Runs" }), { key: "ArrowLeft", altKey: true });
    expect(tabNames()).toEqual(["Runs", "Git", "Agents"]);
    expect(stored().tabs).toEqual(["runs", "git", "agents"]);
  });

  it("moves between tabs with plain arrow keys", async () => {
    seed((layout) => withTabs({ ...layout, collapsed: false }, [{ kind: "add", id: "runs" }]));
    render(tree());
    fireEvent.keyDown(screen.getByRole("tab", { name: "Runs" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute("aria-selected", "true");
  });

  it("reorders from the tab's context menu", async () => {
    seed((layout) => withTabs({ ...layout, collapsed: false }, [{ kind: "add", id: "runs" }]));
    const user = userEvent.setup();
    render(tree());
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Runs" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move left" }));
    expect(tabNames()).toEqual(["Runs", "Agents"]);
  });

  it("closes a tab with its X, never the last one, and never a pinned one", async () => {
    seed((layout) =>
      withTabs({ ...layout, collapsed: false }, [
        { kind: "add", id: "runs" },
        { kind: "add", id: "git" },
        { kind: "pin", id: "git", pinned: true },
      ]),
    );
    const user = userEvent.setup();
    render(tree());
    expect(screen.queryByRole("button", { name: "Close Git" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Close Runs" }));
    expect(tabNames()).toEqual(["Agents", "Git"]);
    expect(stored().tabs).toEqual(["agents", "git"]);

    await user.click(screen.getByRole("button", { name: "Close Agents" }));
    expect(tabNames()).toEqual(["Git"]);
    expect(screen.queryByRole("button", { name: /^Close / })).toBeNull();
  });

  it("closing Browser releases its session with the old browser id", async () => {
    seed((layout) => ({ ...layout, collapsed: false }));
    const user = userEvent.setup();
    render(tree());
    await addTab("Browser");
    const before = stored().browser.browserId;

    await user.click(screen.getByRole("button", { name: "Close Browser" }));

    await waitFor(() => expect(mocks.closeBrowser).toHaveBeenCalledTimes(1));
    expect(mocks.closeBrowser).toHaveBeenCalledWith(before);
    expect(screen.queryByTestId("browser-pane")).toBeNull();
    expect(stored().browser.browserId).not.toBe(before);
  });

  it("persists the Browser URL without its query or fragment", async () => {
    seed((layout) => ({ ...layout, collapsed: false }));
    const user = userEvent.setup();
    render(tree());
    await addTab("Browser");
    await user.click(screen.getByRole("button", { name: "Navigate test browser" }));
    expect(stored().browser.url).toBe("http://localhost:4173/app");
  });
});

describe("WorkspaceDock resize and rail", () => {
  it("resizes from the keyboard, persists, and Home resets", () => {
    seed((layout) => ({ ...layout, collapsed: false }));
    render(tree());
    const handle = screen.getByRole("separator", { name: "Resize workspace dock" });
    expect(handle).toHaveAttribute("aria-valuenow", "288");

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle).toHaveAttribute("aria-valuenow", "312");
    expect(stored().width).toBe(312);

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(stored().width).toBe(264);

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "Home" });
    expect(stored().width).toBe(288);
    expect(handle).toHaveAttribute("aria-valuenow", "288");
  });

  it("never narrows below the minimum", () => {
    seed((layout) => ({ ...layout, collapsed: false, width: 240 }));
    render(tree());
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "240");
  });

  it("collapses to a rail of tab buttons and a rail tab opens the dock on it", async () => {
    seed((layout) =>
      withTabs({ ...layout, collapsed: false }, [
        { kind: "add", id: "runs" },
        { kind: "activate", id: "agents" },
      ]),
    );
    const user = userEvent.setup();
    render(tree());
    await user.click(screen.getByRole("button", { name: "Collapse dock" }));

    expect(collapsed()).toBeInTheDocument();
    const rail = screen.getByRole("group", { name: "Dock views" });
    expect(
      within(rail)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Agents", "Runs"]);

    await user.click(within(rail).getByRole("button", { name: "Runs" }));
    expect(openDock("Runs")).toBeInTheDocument();
    expect(screen.getByText("runs surface")).toBeVisible();
    expect(stored()).toMatchObject({ active: "runs", collapsed: false });
  });

  it("names rail buttons with their live detail", () => {
    mocks.threads = [working()];
    seed((layout) => ({ ...layout, collapsed: true }));
    render(tree());
    expect(screen.getByRole("button", { name: "Agents, 1 working" })).toBeInTheDocument();
  });
});

describe("WorkspaceDock reveal", () => {
  it("opens on Agents from the top bar without persisting an open choice", async () => {
    // add() opens the dock; put the choice back to unchosen, as a fresh layout would have it.
    seed((layout) => ({ ...withTabs(layout, [{ kind: "add", id: "runs" }]), collapsed: null }));
    const view = render(tree());
    expect(collapsed()).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Reveal agents" }));

    await waitFor(() => expect(openDock("Agents")).toBeInTheDocument());
    expect(stored().collapsed).toBeNull();
    expect(stored().active).toBe("agents");
    view.unmount();
    render(tree());
    expect(collapsed()).toBeInTheDocument();
  });

  it("reveals over a person's collapse without clearing it", async () => {
    seed((layout) => ({ ...layout, collapsed: true }));
    render(tree());
    await userEvent.setup().click(screen.getByRole("button", { name: "Reveal agents" }));
    await waitFor(() => expect(openDock("Agents")).toBeInTheDocument());
    expect(stored().collapsed).toBe(true);
  });
});
