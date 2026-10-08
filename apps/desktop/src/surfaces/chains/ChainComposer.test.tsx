import type { ChainStartRequest, ProviderAccount, ThreadSummary } from "@kalcode/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChainComposer } from "./ChainComposer.tsx";
import { buildStartRequest, draftDependencies, suggestName, validateDraft } from "./model.ts";

// Radix measures controls with ResizeObserver, which jsdom lacks.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const store = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../../runtime/chains/useChains.tsx", () => ({ useOptionalChains: () => store }));

const account = (id: string, providerId: string, displayName: string): ProviderAccount =>
  ({
    id,
    providerId,
    displayName,
    providerReportedIdentity: null,
    authenticationState: "authenticated",
    isDefault: true,
    archivedAt: null,
  }) as unknown as ProviderAccount;

const ACCOUNTS = [account("claude-work", "claude-code", "Work"), account("codex-b", "codex", "Codex B")];
const MODELS: Record<
  string,
  { id: string; displayName: string; isDefault: boolean; defaultEffort: string | null; supportedEfforts: string[] }[]
> = {
  "claude-code": [
    {
      id: "claude-opus-4-6",
      displayName: "Opus 4.6",
      isDefault: true,
      defaultEffort: "high",
      supportedEfforts: ["low", "medium", "high"],
    },
  ],
  codex: [
    {
      id: "gpt-5",
      displayName: "GPT-5",
      isDefault: true,
      defaultEffort: null,
      supportedEfforts: ["low", "medium", "high"],
    },
  ],
};

vi.mock("./routeOptions.ts", async (original) => {
  const actual = await original<typeof import("./routeOptions.ts")>();
  return {
    ...actual,
    useRouteOptions: () => ({
      ready: true,
      error: null,
      groups: [
        { providerId: "claude-code", name: "Claude Code", accounts: [ACCOUNTS[0]] },
        { providerId: "codex", name: "Codex", accounts: [ACCOUNTS[1]] },
      ],
      account: (id: string) => ACCOUNTS.find((a) => a.id === id),
      usable: () => true,
      models: (providerId: string) => ({ items: MODELS[providerId] ?? [], pending: false, error: null }),
      discover: () => {},
      defaultRoute: (
        _workspace: string,
        seed?: { providerId?: string; providerAccountId?: string; model?: string; effort?: string } | null,
      ) =>
        seed?.providerId
          ? {
              providerId: seed.providerId,
              providerAccountId: seed.providerAccountId ?? "",
              model: seed.model ?? "",
              effort: seed.effort ?? "",
            }
          : { providerId: "claude-code", providerAccountId: "claude-work", model: "", effort: "" },
    }),
  };
});

beforeEach(() => {
  store.start = vi.fn(async (request: ChainStartRequest) => ({ id: "chain-1", ...request }));
});

const SOURCE = {
  id: "agent-a",
  name: "Implement sidebar",
  providerId: "codex",
  providerAccountId: "codex-b",
  model: "gpt-5",
  effort: "high",
  branch: "kal/sidebar",
  workspaceId: "ws",
} as unknown as ThreadSummary;

describe("ChainComposer", () => {
  it("starts the default Implement → Review → Fix → Test chain with zero route choices", async () => {
    const onStarted = vi.fn();
    render(<ChainComposer workspaceId="ws" featureAvailable onStarted={onStarted} />);
    await userEvent.click(screen.getByRole("textbox", { name: "Goal" }));
    await userEvent.paste("Persist the sidebar width across restarts.");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Persist the sidebar width across restarts");
    await userEvent.click(screen.getByRole("button", { name: "Start chain" }));

    expect(store.start).toHaveBeenCalledTimes(1);
    const request = store.start.mock.calls[0]?.[0] as ChainStartRequest;
    expect(request.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(request).toMatchObject({
      workspaceId: "ws",
      name: "Persist the sidebar width across restarts",
      worktree: "shared",
      acceptance: [],
    });
    expect(request.steps.map((s) => [s.key, s.intent, s.dependsOn])).toEqual([
      ["implement", "implement", []],
      ["review", "review", ["implement"]],
      ["fix", "fix", ["review"]],
      ["test", "test", ["fix"]],
    ]);
    // Defaults resolve to exact values: the account's default model and its reported effort.
    expect(request.steps[0]).toMatchObject({
      providerId: "claude-code",
      providerAccountId: "claude-work",
      model: "claude-opus-4-6",
      effort: "high",
      instructions: null,
    });
    expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ id: "chain-1" }));
  });

  it("prefills Review → Fix from the source agent and its configuration", async () => {
    render(<ChainComposer workspaceId="ws" source={SOURCE} featureAvailable onStarted={() => {}} />);
    expect(screen.getByRole("button", { name: "Review → Fix" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "Goal" })).toHaveValue(
      "Review the work in Implement sidebar (kal/sidebar) and fix what the review finds.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Start chain" }));
    const request = store.start.mock.calls[0]?.[0] as ChainStartRequest;
    expect(request.name).toBe("Review the work in Implement sidebar");
    expect(request.steps.map((s) => s.intent)).toEqual(["review", "fix"]);
    expect(request.steps[0]).toMatchObject({
      providerId: "codex",
      providerAccountId: "codex-b",
      model: "gpt-5",
      effort: "high",
    });
  });

  it("switches presets and requires a goal before starting", async () => {
    render(<ChainComposer workspaceId="ws" featureAvailable onStarted={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Review → Fix" }));
    expect(screen.getAllByRole("listitem", { name: /^Step \d/ })).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Start chain" }));
    expect(store.start).not.toHaveBeenCalled();
    expect(screen.getByText("Describe the goal so every step knows the task.")).toBeInTheDocument();
  });

  it("refuses parallel writers in a shared worktree, allows them in the project checkout", async () => {
    render(<ChainComposer workspaceId="ws" featureAvailable onStarted={() => {}} />);
    await userEvent.click(screen.getByRole("textbox", { name: "Goal" }));
    await userEvent.paste("Two fixes at once");
    // Step 3 (Fix) runs alongside Review; make Review a writer too (Continue).
    await userEvent.click(screen.getByRole("checkbox", { name: "Runs alongside Review" }));
    const review = screen.getByRole("radiogroup", { name: "Step 2 task" });
    await userEvent.click(within(review).getByRole("radio", { name: "Continue" }));
    expect(screen.getByText(/Continue and Fix would edit the shared worktree at the same time/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start chain" }));
    expect(store.start).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("radio", { name: "Project checkout" }));
    expect(screen.queryByText(/would edit the shared worktree/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start chain" }));
    const request = store.start.mock.calls[0]?.[0] as ChainStartRequest;
    expect(request.worktree).toBe("project");
    expect(request.steps.map((s) => [s.key, s.dependsOn])).toEqual([
      ["implement", []],
      ["continue", ["implement"]],
      ["fix", ["implement"]],
      ["test", ["continue", "fix"]],
    ]);
  });

  it("reuses the request id when the same draft is retried after a failure", async () => {
    store.start = vi.fn(async () => {
      throw { category: "validation", code: "x", message: "KalCode could not reach the runtime.", retryable: false };
    });
    render(<ChainComposer workspaceId="ws" featureAvailable onStarted={() => {}} />);
    await userEvent.click(screen.getByRole("textbox", { name: "Goal" }));
    await userEvent.paste("Retry me");
    await userEvent.click(screen.getByRole("button", { name: "Start chain" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not reach the runtime");
    await userEvent.click(screen.getByRole("button", { name: "Start chain" }));
    const [first, second] = store.start.mock.calls.map((call) => (call[0] as ChainStartRequest).requestId);
    expect(first).toBe(second);
  });

  it("keeps Start disabled without the plan", () => {
    render(<ChainComposer workspaceId="ws" featureAvailable={false} onStarted={() => {}} />);
    expect(screen.getByRole("button", { name: "Start chain" })).toBeDisabled();
  });
});

describe("chain draft model", () => {
  it("suggests short names and builds dependencies from parallel rows", () => {
    expect(suggestName("fix the flaky login test (CI) and add a retry")).toBe("Fix the flaky login test");
    expect(suggestName("  ")).toBe("");
    expect(
      draftDependencies([
        { intent: "implement", parallel: false },
        { intent: "review", parallel: false },
        { intent: "test", parallel: true },
        { intent: "fix", parallel: false },
      ]),
    ).toEqual([[], ["implement"], ["implement"], ["review", "test"]]);
  });

  it("validates like native start", () => {
    const route = { providerId: "codex", providerAccountId: "a", model: "", effort: "" };
    const issues = validateDraft({
      name: "",
      goal: "",
      worktree: "shared",
      steps: [
        { id: "1", intent: "implement", instructions: "", parallel: false, route },
        { id: "2", intent: "fix", instructions: "", parallel: true, route: null },
      ],
    });
    // Step 2 has no account, would start alongside step 1 in a chain-made shared tree, and
    // would edit that tree at the same time as step 1.
    expect(issues.map((issue) => issue.field)).toEqual(["goal", "name", "2", "2", "2"]);
    expect(
      validateDraft({
        name: "n",
        goal: "g",
        worktree: "shared",
        existingWorktree: true,
        steps: [
          { id: "1", intent: "review", instructions: "", parallel: false, route },
          { id: "2", intent: "test", instructions: "", parallel: true, route },
        ],
      }),
    ).toEqual([]);
    const request = buildStartRequest({
      requestId: "r",
      workspaceId: "ws",
      name: " Chain ",
      goal: " Goal ",
      acceptance: [" a ", ""],
      worktree: "project",
      steps: [
        { intent: "review", instructions: "", parallel: false, route: { ...route, model: "m", effort: "e" } },
        {
          intent: "review",
          instructions: " Look at tests ",
          parallel: false,
          route: { ...route, model: "m", effort: "e" },
        },
      ],
    });
    expect(request).toMatchObject({ name: "Chain", goal: "Goal", acceptance: ["a"] });
    expect(request.steps.map((s) => [s.key, s.name, s.instructions, s.dependsOn])).toEqual([
      ["review", "Review", null, []],
      ["review-2", "Review 2", "Look at tests", ["review"]],
    ]);
  });
});
