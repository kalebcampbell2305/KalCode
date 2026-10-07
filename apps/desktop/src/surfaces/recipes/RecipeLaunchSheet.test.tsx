import type { LaunchRecipe } from "@kalcode/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecipeBlocker, RecipePreflight } from "../../runtime/recipes/model.ts";
import { RecipeLaunchSheet } from "./RecipeLaunchSheet.tsx";

const seams = vi.hoisted(() => ({ api: {} as Record<string, unknown> }));
vi.mock("../../runtime/recipes/RecipeLaunchProvider.tsx", () => ({ useRecipeLaunch: () => seams.api }));
vi.mock("../providers/LaunchAccountPicker.tsx", () => ({
  LaunchSignIn: ({
    reconnect,
    onConnected,
    providerName,
  }: {
    reconnect?: boolean;
    providerName: string;
    onConnected(): Promise<void>;
  }) => (
    <button type="button" onClick={() => void onConnected()}>
      {reconnect ? `Reconnect ${providerName}` : `Sign in ${providerName}`}
    </button>
  ),
}));

const recipe = { id: "r", name: "Release desk", variables: [], components: [] } as unknown as LaunchRecipe;
const blocker = (over: Partial<RecipeBlocker>): RecipeBlocker => ({
  componentKey: "agent-1",
  title: "Codex: choose an account",
  detail: "No account.",
  repair: { kind: "choose-account", providerId: "codex" },
  skippable: true,
  ...over,
});
const preflight = (blockers: RecipeBlocker[], extra: Partial<RecipePreflight> = {}): RecipePreflight =>
  ({
    recipe,
    workspace: { id: "w", name: "KalCode" },
    values: { branch: "main" },
    ask: [],
    blockers,
    consequences: [],
    plan: [],
    layout: null,
    ...extra,
  }) as unknown as RecipePreflight;

function setup(pf: RecipePreflight, inputs = {}) {
  const api = {
    phase: { kind: "review", preflight: pf, inputs },
    accounts: [
      { id: "acc-1", providerId: "codex", displayName: "Work", archivedAt: null },
      { id: "acc-2", providerId: "codex", displayName: "Old", archivedAt: "2026-01-01" },
    ],
    update: vi.fn(),
    confirm: vi.fn(async () => undefined),
    cancel: vi.fn(),
    repair: vi.fn(),
    refreshEnvironment: vi.fn(async () => undefined),
  };
  seams.api = api;
  return api;
}

describe("RecipeLaunchSheet", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks for variables and updates values", async () => {
    const api = setup(
      preflight([], { ask: [{ key: "branch", label: "Branch", defaultValue: "main", askAtLaunch: true }] }),
    );
    render(<RecipeLaunchSheet />);
    await userEvent.type(screen.getByLabelText("Branch"), "x");
    expect(api.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ values: expect.objectContaining({ branch: "mainx" }) }),
    );
  });

  it("reconnects inline and refreshes the launch", async () => {
    const api = setup(
      preflight([
        blocker({
          repair: { kind: "reconnect", providerId: "codex", accountId: "acc-1" },
          title: "Work needs to reconnect",
        }),
      ]),
    );
    render(<RecipeLaunchSheet />);
    await userEvent.click(screen.getByRole("button", { name: "Reconnect Codex" }));
    expect(api.refreshEnvironment).toHaveBeenCalled();
    expect(api.repair).not.toHaveBeenCalled();
  });

  it("chooses a non-archived account inline", async () => {
    const api = setup(preflight([blocker({})]));
    render(<RecipeLaunchSheet />);
    expect(screen.queryByRole("option", { name: "Old" })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Account for Codex: choose an account"), "acc-1");
    expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ accounts: { "agent-1": "acc-1" } }));
  });

  it("runs repair for edit blockers and skips them", async () => {
    const b = blocker({ repair: { kind: "edit" }, title: "Browser can't open" });
    const api = setup(preflight([b]));
    render(<RecipeLaunchSheet />);
    await userEvent.click(screen.getByRole("button", { name: "Edit Recipe" }));
    expect(api.repair).toHaveBeenCalledWith(b);
    await userEvent.click(screen.getByRole("checkbox", { name: /Skip/ }));
    expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ skip: ["agent-1"] }));
  });

  it("keeps a skipped part visible so the skip can be undone", () => {
    const first = setup(preflight([blocker({ repair: { kind: "edit" } })]));
    const { rerender } = render(<RecipeLaunchSheet />);
    seams.api = { ...first, phase: { kind: "review", preflight: preflight([]), inputs: { skip: ["agent-1"] } } };
    rerender(<RecipeLaunchSheet />);
    expect(screen.getByRole("checkbox", { name: /Skip/ })).toBeChecked();
  });

  it("disables Launch while a non-skippable blocker exists", () => {
    setup(
      preflight([
        blocker({
          componentKey: null,
          skippable: false,
          repair: { kind: "open-project", workspaceId: null },
          title: "No project",
        }),
      ]),
    );
    render(<RecipeLaunchSheet />);
    expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open project" })).toBeInTheDocument();
  });

  it("lists consequences, launches and cancels", async () => {
    const api = setup(preflight([], { consequences: ["Starts 6 coding agents"] }));
    render(<RecipeLaunchSheet />);
    expect(screen.getByText("Starts 6 coding agents")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Launch" }));
    expect(api.confirm).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.cancel).toHaveBeenCalled();
  });

  it("shows progress and a cancel while launching", async () => {
    const cancel = vi.fn();
    seams.api = { phase: { kind: "launching", preflight: preflight([]), done: 2, total: 5 }, cancel, accounts: [] };
    render(<RecipeLaunchSheet />);
    expect(screen.getByText("2 of 5 started")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel launch" }));
    expect(cancel).toHaveBeenCalled();
  });
});
