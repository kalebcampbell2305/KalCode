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
  await screen.findByRole("heading", { level: 1, name: "Activity" });
  return { user: userEvent.setup(), client };
}

const board = () => within(screen.getByRole("region", { name: "Agents" }));
const needsYouNav = () =>
  within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /^Needs you/ });
const dashboardNav = () =>
  within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Activity" });

describe("Stable Dashboard", () => {
  it("empty: says no agents yet and launches a coding agent from Code, never a Thread", async () => {
    const { user } = await mount("empty");
    const agents = board();
    await agents.findByRole("heading", { name: "No agents yet" });
    const actions = agents.getAllByRole("button").map((button) => button.textContent);
    expect(actions).toEqual(["Launch an agent"]);
    expect(agents.queryByRole("button", { name: "Show archived" })).toBeNull();
    const copy = screen.getByText(/agent from Code/);
    expect(copy.textContent).toMatch(/A CLI you type into a plain terminal isn't tracked here/);
    expect(screen.queryByText(/No active sessions/)).toBeNull();

    await user.click(agents.getByRole("button", { name: "Launch an agent" }));
    expect(screen.queryByRole("heading", { level: 1, name: "Threads" })).toBeNull();
  });

  it("archived only: says so, lists them read-only on request and restores one", async () => {
    const { user } = await mount("archived");
    const agents = board();
    await agents.findByRole("heading", { name: "All 3 agents are archived" });
    expect(agents.queryByRole("heading", { name: "No agents yet" })).toBeNull();
    expect(agents.getByRole("button", { name: "Launch an agent" })).toBeInTheDocument();
    const toggle = agents.getByRole("button", { name: "Show archived" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(agents.queryAllByRole("article")).toHaveLength(0);

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const archived = within(agents.getByRole("region", { name: /^Archived/ }));
    const cards = archived.getAllByRole("article");
    // Newest archived first (hundreds stay usable: the view pages through them).
    expect(cards.map((card) => card.querySelector("h3")?.textContent).sort()).toEqual([
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
    // Restored: it is back on the board in its own Failed group, the rest stay archived.
    await waitFor(() => expect(agents.getAllByRole("article", { name: "Deploy preview build" })).toHaveLength(1));
    expect(agents.queryByRole("heading", { name: /agents are archived/ })).toBeNull();
    const stillArchived = within(agents.getByRole("region", { name: /^Archived/ }));
    expect(stillArchived.getAllByRole("article")).toHaveLength(2);
    expect(agents.getByRole("button", { name: "Failed, 1" })).toBeInTheDocument();
    expect(agents.getByRole("button", { name: "Needs you, 0" })).toBeInTheDocument();
  });

  it("populated: shows the board and the Sidebar counts what needs you", async () => {
    const { user } = await mount("busy");
    const agents = board();
    await waitFor(() => expect(agents.getAllByRole("article").length).toBeGreaterThan(0));
    expect(agents.queryByRole("heading", { name: "No agents yet" })).toBeNull();
    expect(agents.queryByRole("heading", { name: /archived/ })).toBeNull();
    const waiting = agents.getByRole("button", { name: /^Needs you, \d+$/ });
    const count = Number(waiting.getAttribute("aria-label")?.split(", ")[1]);
    expect(count).toBeGreaterThan(0);

    // Activity carries no duplicate count. The sidebar's one inbox, Needs you, counts what
    // genuinely needs the person: the board's needs-you agents, one overlapping-edit pair, the
    // failed agent and Operation, and the two finished agents waiting for review (busy fixture).
    const nav = dashboardNav();
    expect(nav.textContent).toBe("Activity");
    expect(nav).not.toHaveAttribute("aria-describedby");
    expect(count).toBe(3);
    expect(agents.getByRole("button", { name: "Failed, 1" })).toBeInTheDocument();
    const inbox = needsYouNav();
    await waitFor(() => expect(inbox).toHaveAccessibleName("Needs you, 8 waiting"));
    expect(inbox.textContent).toBe("Needs you8");
    // Every card shows how long its agent has run.
    for (const card of agents.getAllByRole("article")) {
      expect(card.querySelector('time[data-kind="elapsed"]')?.textContent).toMatch(/^Running time /);
    }

    // The inbox lists them blockers first, each with what happened and the next action.
    await user.click(inbox);
    const sheet = within(await screen.findByRole("dialog", { name: "Needs you" }));
    const items = within(sheet.getByRole("region", { name: "Needs you now" })).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector("p:nth-of-type(2)")?.textContent)).toEqual([
      "Approval: Needs your permission",
      "Approval: Needs your permission",
      "Question: Asked you a question",
      "Blocked: Fix flaky checkout test and Write invoices migration changed the same files",
      "Failed: Failed",
      "Failed: Package desktop failed",
      "Review: Finished · 12 files changed",
      "Review: Finished · 9 files changed",
    ]);
  });

  it("counts a failed Operation even when no coding agent needs attention", async () => {
    const { user } = await mount("archived");
    await board().findByRole("heading", { name: "All 3 agents are archived" });
    expect(dashboardNav().textContent).toBe("Activity");
    const inbox = needsYouNav();
    await waitFor(() => expect(inbox).toHaveAccessibleName("Needs you, 1 waiting"));
    expect(inbox.textContent).toBe("Needs you1");
    await user.click(inbox);
    const sheet = within(await screen.findByRole("dialog", { name: "Needs you" }));
    const item = sheet.getByRole("listitem", { name: /Failed:\s*Package desktop failed/ });
    expect(within(item).getByText("Operations")).toBeInTheDocument();
  });
});

describe("Development Dashboard", () => {
  it("empty: launching an agent is the one action", async () => {
    await mount("empty", "development");
    const agents = board();
    await agents.findByRole("heading", { name: "No agents yet" });
    expect(agents.getAllByRole("button").map((button) => button.textContent)).toEqual(["Launch an agent"]);
    expect(screen.getByText(/agent from Code/).textContent).toMatch(
      /A CLI you type into a plain terminal isn't tracked here/,
    );
  });
});
