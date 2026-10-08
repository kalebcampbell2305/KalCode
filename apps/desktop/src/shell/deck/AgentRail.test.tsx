import type { ThreadSummary } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { type KalTidyApi, KalTidyContext } from "../../surfaces/code/kaltidy/kalTidyContext.ts";
import { thread } from "../../surfaces/dashboard/data/testing.ts";
import { AgentsView, useAgentSections } from "./AgentRail.tsx";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const mocks = vi.hoisted(() => ({ threads: [] as ThreadSummary[] }));
vi.mock("../../surfaces/dashboard/data/DashboardData.tsx", () => ({
  useCodingAgents: () => ({ state: { status: "ready", data: mocks.threads }, reload: vi.fn() }),
  useArchivedCodingAgents: () => ({ state: { status: "ready", data: [] } }),
}));
vi.mock("../../surfaces/dashboard/useNow.ts", () => ({ useClock: () => NOW }));
vi.mock("../navigation.tsx", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("../../runtime/uiIntents.tsx", () => ({ useOptionalUiIntents: () => null }));
vi.mock("../../surfaces/code/useLaunchAgent.ts", () => ({ useLaunchAgent: () => vi.fn() }));

function View() {
  const agents = useAgentSections();
  return <AgentsView agents={agents} />;
}

const recent = new Date(NOW - 5 * 60_000).toISOString();
const agent = (name: string, status: ThreadSummary["status"]) =>
  thread({ name, status, runtimeKind: "interactive_pty", lastActivityAt: recent });

function kalTidy(dismissed: Promise<boolean>): KalTidyApi {
  return {
    openReview: vi.fn(),
    stopIdle: vi.fn(),
    clearFailed: vi.fn(),
    clearFinished: vi.fn(),
    dismissAgent: vi.fn(() => dismissed),
    closeAll: vi.fn(),
  };
}

function mount(api: KalTidyApi) {
  render(
    <TooltipProvider>
      <KalTidyContext.Provider value={api}>
        <View />
      </KalTidyContext.Provider>
    </TooltipProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  mocks.threads = [agent("Broke", "failed"), agent("Busy", "editing"), agent("Shipped", "completed")];
});

it("offers an X only on agents whose session is over", () => {
  mount(kalTidy(Promise.resolve(true)));
  expect(screen.getByRole("button", { name: "Clear Broke" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Clear Shipped" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Clear Busy" })).toBeNull();
});

it("clears through KalTidy's canonical removal and the row leaves at once", async () => {
  let finish: (removed: boolean) => void = () => undefined;
  const api = kalTidy(new Promise((resolve) => (finish = resolve)));
  const user = mount(api);
  await user.click(screen.getByRole("button", { name: "Clear Shipped" }));
  expect(api.dismissAgent).toHaveBeenCalledExactlyOnceWith(mocks.threads[2]?.id);
  const row = screen.getByText("Shipped").closest("li");
  expect(row).toHaveAttribute("data-leaving");
  await act(async () => finish(true));
  expect(row).toHaveAttribute("data-leaving");
});

it("shows a cleared agent again, with its X, when it is restored later", async () => {
  const api = kalTidy(Promise.resolve(true));
  const tree = () => (
    <TooltipProvider>
      <KalTidyContext.Provider value={api}>
        <View />
      </KalTidyContext.Provider>
    </TooltipProvider>
  );
  const { rerender } = render(tree());
  const user = userEvent.setup();
  const shipped = mocks.threads[2] as ThreadSummary;
  await user.click(screen.getByRole("button", { name: "Clear Shipped" }));
  // Archived: the next read no longer lists it.
  mocks.threads = mocks.threads.filter((t) => t.id !== shipped.id);
  rerender(tree());
  expect(screen.queryByText("Shipped")).toBeNull();
  // Unarchived (from the Fleet's Archived view): the same agent is back in the list.
  mocks.threads = [...mocks.threads, shipped];
  rerender(tree());
  const row = screen.getByText("Shipped").closest("li") as HTMLElement;
  expect(row).not.toHaveAttribute("data-leaving");
  expect(row).not.toHaveAttribute("aria-hidden");
  expect(within(row).getByRole("button", { name: "Clear Shipped" })).toBeEnabled();
});

it("brings the row back when the removal fails", async () => {
  let finish: (removed: boolean) => void = () => undefined;
  const api = kalTidy(new Promise((resolve) => (finish = resolve)));
  const user = mount(api);
  await user.click(screen.getByRole("button", { name: "Clear Broke" }));
  const row = screen.getByText("Broke").closest("li") as HTMLElement;
  expect(row).toHaveAttribute("data-leaving");
  await act(async () => finish(false));
  expect(row).not.toHaveAttribute("data-leaving");
  expect(within(row).getByRole("button", { name: "Clear Broke" })).toBeEnabled();
});

it("shows no X without KalTidy", () => {
  render(
    <TooltipProvider>
      <View />
    </TooltipProvider>,
  );
  expect(screen.queryByRole("button", { name: /^Clear / })).toBeNull();
});
