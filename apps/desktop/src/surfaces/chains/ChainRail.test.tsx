import type { Chain, ChainStep, ChainStepPhase, OperationRecord } from "@kalcode/protocol";
import { TooltipProvider } from "@kalcode/ui/components";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type ChainControls, StepPanel } from "./ChainCard.tsx";
import { ChainRail } from "./ChainRail.tsx";
import { railLayout, STEP_PHASE_META, stepActions } from "./model.ts";

vi.mock("./routeOptions.ts", async (original) => ({
  ...(await original<typeof import("./routeOptions.ts")>()),
  useRouteOptions: () => ({
    ready: true,
    error: null,
    groups: [],
    account: () => undefined,
    usable: () => false,
    models: () => ({ items: [], pending: false, error: null }),
    discover: () => {},
    defaultRoute: () => ({ providerId: "codex", providerAccountId: "", model: "", effort: "" }),
  }),
}));

// Radix measures controls with ResizeObserver, which jsdom lacks.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const step = (key: string, position: number, phase: ChainStepPhase, extra: Partial<ChainStep> = {}): ChainStep => ({
  key,
  name: key[0]?.toUpperCase() + key.slice(1),
  intent: key as ChainStep["intent"],
  instructions: null,
  dependsOn: [],
  position,
  operationId: `op-${key}`,
  attempt: 1,
  phase,
  waitingReason: null,
  report: null,
  ...extra,
});

const operation = (id: string, providerId: string, model: string | null): OperationRecord =>
  ({
    id,
    spec: { providerId, model, effort: "high", providerAccountId: "acct" },
    accountLabel: "Work",
    threadId: `thread-${id}`,
  }) as unknown as OperationRecord;

function chainOf(steps: ChainStep[], extra: Partial<Chain> = {}): Chain {
  return {
    id: "chain-1",
    name: "Sidebar width",
    goal: "Persist the sidebar width",
    acceptance: [],
    workspaceId: "ws",
    worktree: "shared",
    branch: "chain/abc",
    createdAt: "2026-10-07T00:00:00.000Z",
    paused: false,
    cancelled: false,
    supersededReason: null,
    phase: "running",
    nextAction: "Waiting for Review to finish",
    steps,
    ...extra,
  };
}

const ops = new Map(
  ["implement", "review", "fix", "test"].map((key) => [
    `op-${key}`,
    operation(`op-${key}`, key === "review" ? "codex" : "claude-code", key === "review" ? "gpt-5" : "claude-opus-4-6"),
  ]),
);

const renderRail = (chain: Chain, onStep = vi.fn()) =>
  render(
    <TooltipProvider>
      <ChainRail chain={chain} operationsById={ops} onStep={onStep} />
    </TooltipProvider>,
  );

describe("ChainRail", () => {
  it("is an ordered list of focusable step nodes with spoken step, intent, route and phase", async () => {
    const chain = chainOf([
      step("implement", 0, "passed", {
        report: { result: "passed", summary: "Done", tests: [], blockers: [], source: "agent", recordedAt: "" },
      }),
      step("review", 1, "working", { dependsOn: ["implement"] }),
      step("fix", 2, "waiting", { dependsOn: ["review"], waitingReason: "Waiting for Review" }),
      step("test", 3, "waiting", { dependsOn: ["fix"], waitingReason: "Waiting for Fix" }),
    ]);
    const onStep = vi.fn();
    renderRail(chain, onStep);
    const list = screen.getByRole("list", { name: "Steps of Sidebar width" });
    expect(list.tagName).toBe("OL");
    const nodes = within(list).getAllByRole("button");
    expect(nodes).toHaveLength(4);
    expect(nodes[1]).toHaveAccessibleName("Step 2 of 4, Review, Codex gpt-5, working");
    expect(nodes[2]).toHaveAccessibleName("Step 3 of 4, Fix, Claude Code claude-opus-4-6, waiting, Waiting for Review");
    nodes[1]?.focus();
    await userEvent.keyboard("{Enter}");
    expect(onStep).toHaveBeenCalledWith(expect.objectContaining({ key: "review" }));
    expect(screen.getByText("Waiting for Review to finish")).toBeInTheDocument();
  });

  it("colours each phase by meaning and lights connectors after satisfied steps", () => {
    const tones: Record<ChainStepPhase, string> = {
      waiting: "waiting",
      starting: "active",
      working: "active",
      needs_report: "attention",
      passed: "passed",
      changes_requested: "passed",
      failed: "failed",
      blocked: "blocked",
      paused: "waiting",
      skipped: "muted",
      cancelled: "muted",
      superseded: "muted",
    };
    for (const [phase, tone] of Object.entries(tones)) expect(STEP_PHASE_META[phase as ChainStepPhase].tone).toBe(tone);

    const chain = chainOf([
      step("implement", 0, "passed"),
      step("review", 1, "failed", { dependsOn: ["implement"] }),
      step("fix", 2, "blocked", { dependsOn: ["review"], waitingReason: "Blocked by Review" }),
    ]);
    const { container } = renderRail(chain);
    const node = (key: string) => container.querySelector(`[data-step-key="${key}"]`);
    expect(node("implement")).toHaveAttribute("data-tone", "passed");
    expect(node("review")).toHaveAttribute("data-tone", "failed");
    expect(node("fix")).toHaveAttribute("data-tone", "blocked");
    expect(screen.getByText("Failed")).toBeInTheDocument();
    const reviewCell = node("review")?.closest("li");
    expect(reviewCell?.querySelector("[data-state]")).toHaveAttribute("data-state", "lit");
    const fixCell = node("fix")?.closest("li");
    expect(fixCell?.querySelector("[data-state]")).toHaveAttribute("data-state", "blocked");
  });

  it("only the working step carries the energy trace", () => {
    const chain = chainOf([
      step("implement", 0, "working"),
      step("review", 1, "waiting", { dependsOn: ["implement"] }),
    ]);
    const { container } = renderRail(chain);
    expect(container.querySelectorAll('[data-phase="working"] > span[aria-hidden="true"]:first-child')).toHaveLength(1);
    expect(container.querySelector('[data-phase="waiting"]')?.firstElementChild?.className).not.toMatch(/trace/);
  });

  it("stacks parallel steps in one column", () => {
    const layout = railLayout([
      step("implement", 0, "passed"),
      step("review", 1, "working", { dependsOn: ["implement"] }),
      step("test", 2, "working", { dependsOn: ["implement"] }),
      step("fix", 3, "waiting", { dependsOn: ["review", "test"] }),
    ]);
    expect(layout.columns).toBe(3);
    expect(layout.rows).toBe(2);
    expect(layout.cells.map((cell) => [cell.step.key, cell.column, cell.row])).toEqual([
      ["implement", 0, 0],
      ["review", 1, 0],
      ["test", 1, 1],
      ["fix", 2, 0],
    ]);
  });
});

describe("step actions per phase", () => {
  it("offers only the actions that are safe for each phase", () => {
    expect(stepActions({ phase: "waiting", waitingReason: null })).toEqual(["reroute", "skip"]);
    expect(stepActions({ phase: "working", waitingReason: null })).toEqual(["open", "record"]);
    expect(stepActions({ phase: "needs_report", waitingReason: null })).toEqual(["open", "record", "retry", "skip"]);
    expect(stepActions({ phase: "failed", waitingReason: null })).toEqual(["open", "retry", "skip"]);
    // Blocked by an earlier failure: resolve that step instead; this one can only be skipped.
    expect(stepActions({ phase: "blocked", waitingReason: "Blocked until Review is resolved." })).toEqual(["skip"]);
    // Held for its own reason (a signed-out account): move it to another agent or skip it.
    expect(
      stepActions({ phase: "blocked", waitingReason: "This Squad member's selected provider account is unavailable." }),
    ).toEqual(["reroute", "skip"]);
    expect(stepActions({ phase: "paused", waitingReason: "Chain paused." })).toEqual(["reroute", "skip"]);
    expect(stepActions({ phase: "cancelled", waitingReason: null })).toEqual(["retry", "skip"]);
    expect(stepActions({ phase: "passed", waitingReason: null })).toEqual(["open"]);
    expect(stepActions({ phase: "skipped", waitingReason: null })).toEqual([]);
    expect(stepActions({ phase: "superseded", waitingReason: null })).toEqual([]);
    // A cancelled chain keeps Open agent and nothing that changes it.
    expect(stepActions({ phase: "failed", waitingReason: null }, { phase: "cancelled" })).toEqual(["open"]);
  });

  const controls = (): ChainControls => ({
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
    retryStep: vi.fn(async () => chainOf([])),
    skipStep: vi.fn(async () => chainOf([])),
    rerouteStep: vi.fn(async () => chainOf([])),
    recordStep: vi.fn(async () => chainOf([])),
  });

  it("records an outcome for a step that needs a report", async () => {
    const api = controls();
    const target = step("review", 1, "needs_report");
    render(
      <StepPanel
        chain={chainOf([step("implement", 0, "passed"), target], { phase: "needs_you" })}
        step={target}
        operation={ops.get("op-review")}
        controls={api}
        onOpenAgent={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Open agent" })).toBeInTheDocument();
    // An unreported step can also be run again on a fresh attempt.
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Record outcome" }));
    await userEvent.click(screen.getByRole("radio", { name: "Changes requested" }));
    // An empty summary is refused inline, never sent.
    await userEvent.click(screen.getAllByRole("button", { name: "Record outcome" })[1] as HTMLElement);
    expect(api.recordStep).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Add a short summary");
    await userEvent.type(screen.getByLabelText("Summary"), "Two findings");
    await userEvent.click(screen.getAllByRole("button", { name: "Record outcome" })[1] as HTMLElement);
    expect(api.recordStep).toHaveBeenCalledWith("chain-1", "review", "changes_requested", "Two findings");
  });

  it("retries a failed step on the same agent and shows a refusal inline", async () => {
    const api = controls();
    api.retryStep = vi.fn(async () => {
      throw {
        category: "validation",
        code: "x",
        message: "Codex is signed out. Reconnect it or choose Claude Code.",
        retryable: false,
      };
    });
    const target = step("fix", 2, "failed");
    render(
      <StepPanel
        chain={chainOf([target], { phase: "blocked" })}
        step={target}
        operation={ops.get("op-fix")}
        controls={api}
        onOpenAgent={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Record outcome" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await userEvent.click(screen.getByRole("button", { name: "Retry step" }));
    expect(api.retryStep).toHaveBeenCalledWith("chain-1", "fix", null);
    expect(await screen.findByRole("alert")).toHaveTextContent("Codex is signed out");
  });

  it("skips a waiting step and offers a reroute", async () => {
    const api = controls();
    const target = step("test", 3, "waiting", { waitingReason: "Waiting for Fix" });
    render(
      <StepPanel
        chain={chainOf([target])}
        step={target}
        operation={ops.get("op-test")}
        controls={api}
        onOpenAgent={() => {}}
      />,
    );
    expect(screen.getByText("Waiting for Fix")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change agent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open agent" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(api.skipStep).toHaveBeenCalledWith("chain-1", "test");
  });
});
