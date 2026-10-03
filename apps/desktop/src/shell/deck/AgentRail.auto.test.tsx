import type { ThreadSummary } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { thread } from "../../surfaces/dashboard/data/testing.ts";
import { AgentRail } from "./AgentRail.tsx";
import { DeckUiProvider } from "./DeckUi.tsx";

// The agents rail follows the agents until the person pins or collapses it (owner request).
const mocks = vi.hoisted(() => ({ threads: [] as ThreadSummary[] }));
vi.mock("../../surfaces/dashboard/data/DashboardData.tsx", () => ({
  useCodingAgents: () => ({ state: { status: "ready", data: mocks.threads }, reload: vi.fn() }),
  useArchivedCodingAgents: () => ({ state: { status: "ready", data: [] } }),
}));
vi.mock("../navigation.tsx", () => ({ useNavigation: () => ({ current: "code", navigate: vi.fn() }) }));
vi.mock("../../runtime/uiIntents.tsx", () => ({ useOptionalUiIntents: () => null }));
vi.mock("../../surfaces/code/useLaunchAgent.ts", () => ({ useLaunchAgent: () => vi.fn() }));
vi.mock("@kalcode/ui/components", async (original) => ({
  ...(await original<typeof import("@kalcode/ui/components")>()),
  useToast: () => ({ show: vi.fn() }),
}));

const KEY = "kalcode.deck.agentsRail.v2";
const working = () => thread({ name: "Busy", status: "editing", runtimeKind: "interactive_pty" });
const idle = () => thread({ name: "Quiet", status: "idle", runtimeKind: "interactive_pty" });

const tree = () => (
  <TooltipProvider>
    <DeckUiProvider>
      <AgentRail />
    </DeckUiProvider>
  </TooltipProvider>
);
const collapsed = () => screen.queryByRole("complementary", { name: "Agents (collapsed)" });
const open = () => screen.queryByRole("complementary", { name: /^Agents/ });

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  mocks.threads = [];
});

it("stays a strip while no agent runs, and opens when the first one starts", () => {
  mocks.threads = [idle()];
  const view = render(tree());
  expect(collapsed()).toBeInTheDocument();
  expect(screen.queryByText("No agents running")).toBeNull();

  mocks.threads = [idle(), working()];
  view.rerender(tree());
  expect(collapsed()).toBeNull();
  expect(open()).toHaveAttribute("id", "deck-agents");

  // And folds back once nothing runs or needs the person.
  mocks.threads = [idle()];
  view.rerender(tree());
  expect(collapsed()).toBeInTheDocument();
});

it("opens when something needs the person", () => {
  mocks.threads = [thread({ name: "Ask", status: "waiting_for_user", runtimeKind: "interactive_pty" })];
  render(tree());
  expect(collapsed()).toBeNull();
});

it("respects a manual collapse while agents work, across restarts", async () => {
  mocks.threads = [working()];
  const view = render(tree());
  await userEvent.setup().click(screen.getByRole("button", { name: "Hide agents" }));
  expect(collapsed()).toBeInTheDocument();
  expect(window.localStorage.getItem(KEY)).toBe("closed");
  view.unmount();
  render(tree());
  expect(collapsed()).toBeInTheDocument();
});

it("respects a manual pin with nothing running, across restarts", async () => {
  const view = render(tree());
  await userEvent.setup().click(screen.getByRole("button", { name: "Show agents" }));
  expect(screen.getByText("No agents running")).toBeInTheDocument();
  expect(window.localStorage.getItem(KEY)).toBe("open");
  view.unmount();
  render(tree());
  expect(collapsed()).toBeNull();
});

it("keeps a narrow window's strip even when an agent works", () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
  mocks.threads = [working()];
  render(tree());
  expect(collapsed()).toBeInTheDocument();
});
