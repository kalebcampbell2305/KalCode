import type { SurfaceFlag } from "@kalcode/protocol";
import { ToastProvider, TooltipProvider } from "@kalcode/ui/components";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "../../account/AccountProvider.tsx";
import { AccountClient } from "../../ipc/account.ts";
import { KalCodeClient } from "../../ipc/client.ts";
import { createMemoryTransport, type MemoryScenario } from "../../ipc/memoryTransport.ts";
import { RuntimeProvider } from "../../runtime/RuntimeProvider.tsx";
import nativeStableSurfaces from "../../shell/fixtures/stable-native-surfaces.json";
import { Shell } from "../../shell/Shell.tsx";

// The Dashboard as Stable renders it (flags as in Shell.stable.test.tsx): the honest empty state,
// the all-archived state with its read-only archived cards, a populated board, and the Sidebar's
// "needs you" count. Development (provider panes visible) keeps its Code path in the copy.
vi.mock("../code/TerminalView.tsx", () => ({ TerminalView: () => null }));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

type Channel = "stable" | "development";

async function mount(scenario: MemoryScenario, channel: Channel = "stable") {
  const transport = createMemoryTransport(scenario, { detectDelayMs: 0 });
  const client = new KalCodeClient(transport);
  const boot = await client.boot();
  if (channel === "stable") {
    boot.info.channel = "stable";
    boot.info.flags.surfaces = (nativeStableSurfaces as SurfaceFlag[]).map((flag) => ({ ...flag }));
    boot.info.flags.features = boot.info.flags.features.map((flag) => ({
      ...flag,
      visible: flag.state === "available",
    }));
  }
  render(
    <ToastProvider>
      <TooltipProvider>
        <AccountProvider client={new AccountClient(transport)}>
          <RuntimeProvider client={client} info={boot.info} initialSettings={await client.getSettings()}>
            <Shell />
          </RuntimeProvider>
        </AccountProvider>
      </TooltipProvider>
    </ToastProvider>,
  );
  await screen.findByRole("heading", { level: 1, name: "Dashboard" });
  return { user: userEvent.setup(), client };
}

const board = () => within(screen.getByRole("region", { name: "Agents" }));
const dashboardNav = () =>
  within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Dashboard" });

describe("Stable Dashboard", () => {
  it("empty: says no sessions yet, leads with New Session and doesn't promise terminal CLIs", async () => {
    const { user } = await mount("empty");
    const agents = board();
    await agents.findByRole("heading", { name: "No sessions yet" });
    const actions = agents.getAllByRole("button").map((button) => button.textContent);
    expect(actions).toEqual(["New Session"]);
    expect(agents.queryByRole("button", { name: "Open Code" })).toBeNull();
    expect(agents.queryByRole("button", { name: "Show archived" })).toBeNull();
    const copy = screen.getByText(/This build tracks sessions started from Threads/);
    expect(copy.textContent).toMatch(/a CLI you run yourself in a Code terminal isn't tracked/);
    expect(screen.queryByText(/No active sessions/)).toBeNull();

    await user.click(agents.getByRole("button", { name: "New Session" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Threads" })).toBeInTheDocument();
  });

  it("archived only: says so, lists them read-only on request and restores one", async () => {
    const { user } = await mount("archived");
    const agents = board();
    await agents.findByRole("heading", { name: "All 3 sessions are archived" });
    expect(agents.queryByRole("heading", { name: "No sessions yet" })).toBeNull();
    expect(agents.getByRole("button", { name: "New Session" })).toBeInTheDocument();
    const toggle = agents.getByRole("button", { name: "Show archived" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(agents.queryAllByRole("article")).toHaveLength(0);

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const archived = within(agents.getByRole("region", { name: /^Archived/ }));
    const cards = archived.getAllByRole("article");
    expect(cards.map((card) => card.querySelector("h3")?.textContent)).toEqual([
      "Add light theme tokens",
      "Deploy preview build",
      "Generate API client",
    ]);
    for (const card of cards) {
      // Read-only: no actions menu, no Open, no Retry; only Unarchive.
      expect(
        within(card)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Unarchive"]);
      expect(card.textContent).toContain("Archived");
    }

    await user.click(archived.getByRole("button", { name: "Unarchive Deploy preview build" }));
    // Restored: it is back on the board (Failed waits for you), the rest stay archived.
    await waitFor(() => expect(agents.getAllByRole("article", { name: "Deploy preview build" })).toHaveLength(1));
    expect(agents.queryByRole("heading", { name: /sessions are archived/ })).toBeNull();
    const stillArchived = within(agents.getByRole("region", { name: /^Archived/ }));
    expect(stillArchived.getAllByRole("article")).toHaveLength(2);
    expect(agents.getByRole("button", { name: "Waiting for you, 1" })).toBeInTheDocument();
  });

  it("populated: shows the board and the Sidebar counts what needs you", async () => {
    await mount("busy");
    const agents = board();
    await waitFor(() => expect(agents.getAllByRole("article").length).toBeGreaterThan(0));
    expect(agents.queryByRole("heading", { name: "No sessions yet" })).toBeNull();
    expect(agents.queryByRole("heading", { name: /archived/ })).toBeNull();
    const waiting = agents.getByRole("button", { name: /^Waiting for you, \d+$/ });
    const count = Number(waiting.getAttribute("aria-label")?.split(", ")[1]);
    expect(count).toBeGreaterThan(0);

    // The badge shows the same number; the button keeps its name and describes the count.
    const nav = dashboardNav();
    await waitFor(() => expect(nav.textContent).toBe(`Dashboard${count}`));
    expect(nav).toHaveAccessibleName("Dashboard");
    expect(nav).toHaveAccessibleDescription(`${count} sessions need you`);
    // Every card shows when it started.
    for (const card of agents.getAllByRole("article")) {
      expect(card.querySelector('time[data-kind="started"]')?.textContent).toMatch(/^Started /);
    }
  });

  it("the Sidebar shows no count when nothing needs you", async () => {
    await mount("archived");
    await board().findByRole("heading", { name: "All 3 sessions are archived" });
    const nav = dashboardNav();
    expect(nav.textContent).toBe("Dashboard");
    expect(nav).not.toHaveAttribute("aria-describedby");
  });
});

describe("Development Dashboard", () => {
  it("empty: keeps the provider-pane path to Code as a secondary action", async () => {
    await mount("empty", "development");
    const agents = board();
    await agents.findByRole("heading", { name: "No sessions yet" });
    expect(agents.getAllByRole("button").map((button) => button.textContent)).toEqual(["New Session", "Open Code"]);
    expect(screen.getByText(/in a provider pane from Code/).textContent).toMatch(
      /A CLI you type into a plain terminal isn't tracked here/,
    );
  });
});
