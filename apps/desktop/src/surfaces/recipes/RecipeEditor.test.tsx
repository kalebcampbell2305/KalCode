import type { LaunchRecipe } from "@kalcode/protocol";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecipeEditor, validateRecipe } from "./RecipeEditor.tsx";

const seams = vi.hoisted(() => ({ library: {} as Record<string, unknown> }));
vi.mock("../../runtime/recipes/RecipeLaunchProvider.tsx", () => ({ useRecipeLibrary: () => seams.library }));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({ workspaces: [{ id: "w1", name: "KalCode" }], active: { id: "w1", name: "KalCode" } }),
}));
vi.mock("../../runtime/RuntimeProvider.tsx", () => ({
  useRuntime: () => ({
    client: {
      listProviderAccounts: async () => [],
      squads: { snapshot: async () => ({ squads: [] }) },
    },
  }),
}));

describe("RecipeEditor", () => {
  const save = vi.fn();
  const close = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("validates variable keys", () => {
    const recipe = {
      name: "x",
      components: [],
      variables: [{ key: "Bad Key", label: "", defaultValue: "", askAtLaunch: false }],
    } as unknown as LaunchRecipe;
    expect(validateRecipe(recipe)[0]).toMatch(/Bad Key/);
  });
});
