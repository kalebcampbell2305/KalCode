import type { LaunchRecipe } from "@kalcode/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecipesLibrary } from "./RecipesLibrary.tsx";

const seams = vi.hoisted(() => ({
  library: {} as Record<string, unknown>,
  request: vi.fn(async () => ({ ok: true, message: "" })),
}));

vi.mock("../../account/AccountProvider.tsx", () => ({
  useOptionalAccount: () => ({ snapshot: { phase: "ready", tier: "free" } }),
}));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({ workspaces: [{ id: "w1", name: "KalCode" }], active: { id: "w1", name: "KalCode" } }),
}));
vi.mock("../../runtime/recipes/RecipeLaunchProvider.tsx", () => ({
  useRecipeLibrary: () => seams.library,
  useRecipeRequest: () => seams.request,
}));

const recipe = (id: string, name: string, position: number): LaunchRecipe => ({
  id,
  name,
  schemaVersion: 1,
  workspaceId: id === "a" ? "w1" : null,
  pinned: false,
  position,
  variables: [],
  components: [{ kind: "terminal", key: "terminal-1", name: null, command: null }],
  layout: null,
  updatedAt: "",
});

describe("RecipesLibrary", () => {
  const save = vi.fn(async (r: LaunchRecipe) => r);
  const reorder = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  beforeEach(() => {
    vi.clearAllMocks();
    seams.library = {
      recipes: [recipe("a", "Alpha", 0), recipe("b", "Beta", 1), recipe("c", "Gamma", 2)],
      limit: 3,
      loading: false,
      error: null,
      save,
      remove,
      reorder,
      togglePin: vi.fn(async () => undefined),
      duplicate: vi.fn(),
      editor: { open: vi.fn(), close: vi.fn(), recipe: null, isOpen: false },
      library: { open: vi.fn(), close: vi.fn(), isOpen: true },
    };
  });

  it("shows project chip, counts and the plan limit", () => {
    render(<RecipesLibrary />);
    expect(screen.getByText("KalCode")).toBeInTheDocument();
    expect(screen.getAllByText("1 terminal")).toHaveLength(3);
    expect(screen.getByText("3 of 3 on Free")).toBeInTheDocument();
  });

  it("commits an inline rename with Enter", async () => {
    const user = userEvent.setup();
    render(<RecipesLibrary />);
    await user.dblClick(screen.getByText("Alpha"));
    const input = screen.getByLabelText("Recipe name");
    await user.clear(input);
    await user.type(input, "Release desk{Enter}");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "a", name: "Release desk" }));
  });

  it("cancels a rename with Escape", async () => {
    const user = userEvent.setup();
    render(<RecipesLibrary />);
    await user.dblClick(screen.getByText("Alpha"));
    await user.type(screen.getByLabelText("Recipe name"), "x{Escape}");
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("starts rename with F2", () => {
    render(<RecipesLibrary />);
    const row = screen.getByRole("listitem", { name: "Beta" });
    row.focus();
    fireEvent.keyDown(row, { key: "F2" });
    expect(screen.getByLabelText("Recipe name")).toHaveValue("Beta");
  });

  it("reorders with Alt+Arrow", () => {
    render(<RecipesLibrary />);
    fireEvent.keyDown(screen.getByRole("listitem", { name: "Alpha" }), { key: "ArrowDown", altKey: true });
    expect(reorder).toHaveBeenCalledWith(["b", "a", "c"]);
    fireEvent.keyDown(screen.getByRole("listitem", { name: "Gamma" }), { key: "ArrowUp", altKey: true });
    expect(reorder).toHaveBeenLastCalledWith(["a", "c", "b"]);
  });

  it("does not move past the ends", () => {
    render(<RecipesLibrary />);
    fireEvent.keyDown(screen.getByRole("listitem", { name: "Alpha" }), { key: "ArrowUp", altKey: true });
    expect(reorder).not.toHaveBeenCalled();
  });

  it("launches a Recipe", async () => {
    const user = userEvent.setup();
    render(<RecipesLibrary />);
    await user.click(screen.getByRole("button", { name: "Launch Beta" }));
    expect(seams.request).toHaveBeenCalledWith({ recipeId: "b" });
  });

  it("confirms delete inline", async () => {
    const user = userEvent.setup();
    render(<RecipesLibrary />);
    await user.click(screen.getByRole("button", { name: "More for Gamma" }));
    await user.click(await screen.findByRole("menuitem", { name: /Delete/ }));
    expect(remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(remove).toHaveBeenCalledWith("c");
  });

  it("offers capture when empty", async () => {
    (seams.library as { recipes: LaunchRecipe[] }).recipes = [];
    const heard = vi.fn();
    window.addEventListener("kalcode:recipe-capture", heard);
    const user = userEvent.setup();
    render(<RecipesLibrary />);
    await user.click(screen.getByRole("button", { name: "Save this desk" }));
    expect(heard).toHaveBeenCalled();
    window.removeEventListener("kalcode:recipe-capture", heard);
  });
});
