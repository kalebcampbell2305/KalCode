import type { ThreadSummary } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { type KalTidyApi, KalTidyContext } from "../../surfaces/code/kaltidy/kalTidyContext.ts";
import { thread } from "../../surfaces/dashboard/data/testing.ts";
import { AgentRail } from "./AgentRail.tsx";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const mocks = vi.hoisted(() => ({ threads: [] as ThreadSummary[] }));
vi.mock("../../surfaces/dashboard/data/DashboardData.tsx", () => ({
  useCodingAgents: () => ({ state: { status: "ready", data: mocks.threads }, reload: vi.fn() }),
  useArchivedCodingAgents: () => ({ state: { status: "ready", data: [] } }),
}));
vi.mock("../../surfaces/dashboard/useNow.ts", () => ({ useNow: () => NOW }));
vi.mock("./DeckUi.tsx", () => ({
  useDeckUi: () => ({ agentsOpen: true, setAgentsOpen: vi.fn(), setAgentsActive: vi.fn() }),
}));
vi.mock("../navigation.tsx", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("../../runtime/uiIntents.tsx", () => ({ useOptionalUiIntents: () => null }));
vi.mock("../../surfaces/code/useLaunchAgent.ts", () => ({ useLaunchAgent: () => vi.fn() }));

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
        <AgentRail />
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
      <AgentRail />
    </TooltipProvider>,
  );
  expect(screen.queryByRole("button", { name: /^Clear / })).toBeNull();
});
