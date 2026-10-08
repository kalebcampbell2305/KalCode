import type { LaunchRecipe, ProviderAccount, RecipeComponent } from "@kalcode/protocol";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecipeEditor, validateRecipe } from "./RecipeEditor.tsx";

const seams = vi.hoisted(() => {
  const listProviderAccounts = vi.fn(async () => [] as ProviderAccount[]);
  const listProviderAccountBindings = vi.fn(async () => []);
  return {
    library: {} as Record<string, unknown>,
    providerSessions: null as Record<string, unknown> | null,
    listProviderAccounts,
    listProviderAccountBindings,
    client: {
      listProviderAccounts,
      listProviderAccountBindings,
      squads: { snapshot: vi.fn(async () => ({ squads: [] })) },
    },
  };
});
vi.mock("../../runtime/recipes/RecipeLaunchProvider.tsx", () => ({
  useRecipeLibrary: () => seams.library,
  resolveRecipeDefaultAccount: (accounts: ProviderAccount[]) =>
    accounts.find((candidate) => candidate.isDefault && candidate.archivedAt === null) ?? null,
}));
vi.mock("../providers/ProviderAccountSessions.tsx", () => ({
  useOptionalProviderAccountSessions: () => seams.providerSessions,
}));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({ workspaces: [{ id: "w1", name: "KalCode" }], active: { id: "w1", name: "KalCode" } }),
}));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({ client: seams.client }),
}));

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: "account-a",
    providerId: "claude-code",
    displayName: "Work",
    providerReportedIdentity: null,
    authenticationState: "authenticated",
    isDefault: true,
    createdAt: "2026-10-01T00:00:00Z",
    lastUsedAt: null,
    lastCheckedAt: null,
    lastErrorCode: null,
    archivedAt: null,
    ...overrides,
  };
}

type AgentComponent = Extract<RecipeComponent, { kind: "agent" }>;

function recipeAgent(overrides: Partial<AgentComponent> = {}): LaunchRecipe {
  return {
    id: "recipe-a",
    name: "Exact model desk",
    schemaVersion: 1,
    workspaceId: "w1",
    pinned: false,
    position: 0,
    variables: [],
    components: [
      {
        kind: "agent",
        key: "agent-1",
        providerId: "claude-code",
        providerAccountId: "account-a",
        model: "claude-exact-future",
        effort: "future-effort",
        name: null,
        task: null,
        ...overrides,
      },
    ],
    layout: null,
    updatedAt: "2026-10-01T00:00:00Z",
  };
}

function modelSessions(status: "available" | "stale", effortMetadata = true) {
  const discoverModels = vi.fn(async () => undefined);
  const selected = account();
  return {
    discoverModels,
    value: {
      accounts: [selected],
      states: new Map([
        [
          selected.id,
          {
            models: {
              status,
              source: "runtime",
              ...(effortMetadata ? { supportedEfforts: ["low"] } : {}),
              items: [
                {
                  id: "claude-exact-future",
                  displayName: "Claude Exact Future",
                  isDefault: true,
                  defaultEffort: "low",
                  ...(effortMetadata ? { supportedEfforts: ["low"] } : {}),
                },
              ],
              reason: status === "stale" ? "Refresh needed" : null,
            },
          },
        ],
      ]),
      discoverModels,
    },
  };
}

describe("RecipeEditor", () => {
  const save = vi.fn();
  const close = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    seams.providerSessions = null;
    seams.listProviderAccounts.mockResolvedValue([]);
    seams.listProviderAccountBindings.mockResolvedValue([]);
    seams.library = {
      recipes: [],
      save,
      editor: { open: vi.fn(), close, recipe: null, isOpen: true },
    };
  });

  it("saves a new Recipe with a generated key", async () => {
    save.mockImplementation(async (r: LaunchRecipe) => r);
    const user = userEvent.setup();
    render(<RecipeEditor />);
    await user.type(screen.getByLabelText("Name"), "Desk");
    await user.click(screen.getByRole("button", { name: "Add Terminal" }));
    await user.click(screen.getByRole("button", { name: "Save Recipe" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Desk",
        workspaceId: "w1",
        components: [expect.objectContaining({ kind: "terminal", key: "terminal-1" })],
      }),
    );
    expect(close).toHaveBeenCalled();
  });

  it("shows a native rejection inline and stays open", async () => {
    save.mockRejectedValue(new Error("Recipes cannot store secrets"));
    const user = userEvent.setup();
    render(<RecipeEditor />);
    await user.type(screen.getByLabelText("Name"), "Desk");
    await user.click(screen.getByRole("button", { name: "Save Recipe" }));
    expect(await screen.findByText("Recipes cannot store secrets")).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
  });

  it("blocks an unnamed Recipe without calling native", async () => {
    const user = userEvent.setup();
    render(<RecipeEditor />);
    await user.click(screen.getByRole("button", { name: "Save Recipe" }));
    expect(await screen.findByText("Give the Recipe a name.")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("reorders and removes parts", async () => {
    const user = userEvent.setup();
    render(<RecipeEditor />);
    await user.click(screen.getByRole("button", { name: "Add Terminal" }));
    await user.click(screen.getByRole("button", { name: "Add Browser" }));
    await user.click(screen.getByRole("button", { name: "Move browser-1 up" }));
    const keys = screen.getAllByText(/^(terminal|browser)-1$/).map((node) => node.textContent);
    expect(keys).toEqual(["browser-1", "terminal-1"]);
    await user.click(screen.getByRole("button", { name: "Remove browser-1" }));
    expect(screen.queryByText("browser-1")).not.toBeInTheDocument();
  });

  it("preserves and saves an exact effort while the runtime catalog is stale", async () => {
    const sessions = modelSessions("stale");
    seams.providerSessions = sessions.value;
    seams.library = {
      recipes: [],
      save,
      editor: { open: vi.fn(), close, recipe: recipeAgent(), isOpen: true },
    };
    const user = userEvent.setup();

    render(<RecipeEditor />);

    expect(screen.getByLabelText(/Effort/)).toHaveValue("future-effort");
    expect(screen.getByRole("option", { name: "Future-effort" })).toBeInTheDocument();
    await waitFor(() => expect(sessions.discoverModels).toHaveBeenCalledWith("account-a"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        components: [expect.objectContaining({ effort: "future-effort", model: "claude-exact-future" })],
      }),
    );
  });

  it("retains but blocks an exact effort a fresh runtime catalog disproves", async () => {
    const sessions = modelSessions("available");
    seams.providerSessions = sessions.value;
    seams.library = {
      recipes: [],
      save,
      editor: { open: vi.fn(), close, recipe: recipeAgent(), isOpen: true },
    };
    const user = userEvent.setup();

    render(<RecipeEditor />);

    expect(screen.getByLabelText(/Effort/)).toHaveValue("future-effort");
    expect(screen.getByRole("option", { name: "Unavailable · Future-effort" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/no longer reports effort "future-effort"/)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText(/Effort/), "low");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ components: [expect.objectContaining({ effort: "low" })] }),
    );
  });

  it("preserves an exact effort when fresh runtime data has no effort metadata", async () => {
    const sessions = modelSessions("available", false);
    seams.providerSessions = sessions.value;
    seams.library = {
      recipes: [],
      save,
      editor: { open: vi.fn(), close, recipe: recipeAgent(), isOpen: true },
    };
    const user = userEvent.setup();

    render(<RecipeEditor />);

    expect(screen.getByLabelText(/Effort/)).toHaveValue("future-effort");
    expect(screen.getByRole("option", { name: "Future-effort" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ components: [expect.objectContaining({ effort: "future-effort" })] }),
    );
  });

  it("keeps an implicit account unresolved and offers retry when bindings cannot be read", async () => {
    const sessions = modelSessions("available");
    seams.providerSessions = sessions.value;
    seams.listProviderAccountBindings.mockRejectedValueOnce(new Error("Bindings unavailable"));
    seams.library = {
      recipes: [],
      save,
      editor: {
        open: vi.fn(),
        close,
        recipe: recipeAgent({ providerAccountId: null }),
        isOpen: true,
      },
    };
    const user = userEvent.setup();

    render(<RecipeEditor />);

    expect(await screen.findByText(/Default account couldn't be resolved/)).toBeVisible();
    expect(sessions.discoverModels).not.toHaveBeenCalled();

    seams.listProviderAccountBindings.mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: "Retry account choices" }));
    await waitFor(() => expect(seams.listProviderAccountBindings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(sessions.discoverModels).toHaveBeenCalledWith("account-a"));
    expect(screen.queryByText(/Default account couldn't be resolved/)).not.toBeInTheDocument();
  });

  it("validates variable keys", () => {
    const recipe = {
      name: "x",
      components: [],
      variables: [{ key: "Bad Key", label: "", defaultValue: "", askAtLaunch: false }],
    } as unknown as LaunchRecipe;
    expect(validateRecipe(recipe)[0]).toMatch(/Bad Key/);
  });
});
