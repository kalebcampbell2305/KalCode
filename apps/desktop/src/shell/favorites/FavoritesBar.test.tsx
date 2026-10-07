import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShortcuts } from "../shortcuts.ts";
import { FavoriteButton } from "./FavoriteActions.tsx";
import { FavoritesBar } from "./FavoritesBar.tsx";
import { type FavoriteEntry, type FavoriteTarget, favoriteKey } from "./model.ts";
import { visibleFavorites } from "./selection.ts";
import { FAVORITES_STORAGE_KEY } from "./store.ts";

const mocks = vi.hoisted(() => ({
  active: { id: "w1", name: "Project One" },
  threads: [] as { id: string; name: string }[],
  open: vi.fn(),
  check: vi.fn(),
  find: vi.fn(),
}));
vi.mock("../../surfaces/dashboard/data/DashboardData.tsx", () => ({
  useThreadSummaries: () => ({ state: { status: "ready", data: mocks.threads } }),
}));
vi.mock("../../runtime/WorkspaceProvider.tsx", () => ({
  useWorkspaces: () => ({ active: mocks.active }),
  useOptionalWorkspaces: () => ({ active: mocks.active }),
}));
vi.mock("../rail/search/SearchProvider.tsx", () => ({ useOptionalSearchActions: () => ({ openWith: mocks.find }) }));
vi.mock("./useOpenFavorite.ts", () => ({
  useFavoriteResolver: () => ({ open: mocks.open, check: mocks.check, preview: null, closePreview: vi.fn() }),
}));
vi.mock("../context/FilePreview.tsx", () => ({ FilePreview: () => null }));

const target = (id: string): FavoriteTarget => ({ kind: "terminal", id, workspaceId: "w1" });
function entry(id: string, title: string, scopeId: string | null = "w1"): FavoriteEntry {
  return { key: favoriteKey(target(id), scopeId), target: target(id), title, scopeId };
}
function seed(entries: FavoriteEntry[]) {
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify({ version: 1, entries }));
}
function saved(): FavoriteEntry[] {
  return JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) ?? "{}").entries;
}
beforeEach(() => {
  localStorage.clear();
  mocks.active = { id: "w1", name: "Project One" };
  mocks.threads = [];
  mocks.check.mockReset().mockResolvedValue(null);
  mocks.open.mockReset().mockResolvedValue({ opened: true });
  mocks.find.mockClear();
});
afterEach(cleanup);

describe("favorites strip", () => {
  it.each(["agent", "thread"] as const)(
    "shows canonical automatic/manual renames for a pinned %s without changing its saved identity",
    async (kind) => {
      const savedTarget: FavoriteTarget = { kind, id: "session-1", workspaceId: "w1" };
      const pinned = { key: favoriteKey(savedTarget, null), target: savedTarget, title: "New agent", scopeId: null };
      seed([pinned]);
      mocks.threads = [{ id: "session-1", name: "New agent" }];
      const view = render(<FavoritesBar />);
      expect(screen.getByRole("button", { name: "New agent" })).toBeVisible();
      // DashboardData's canonical cache refreshes from thread.renamed events for
      // both first-task naming and an explicit user rename.
      mocks.threads = [{ id: "session-1", name: "Fix Login Race" }];
      view.rerender(<FavoritesBar />);
      expect(screen.getByRole("button", { name: "Fix Login Race" })).toBeVisible();
      mocks.threads = [{ id: "session-1", name: "Login Review" }];
      view.rerender(<FavoritesBar />);
      await userEvent.click(screen.getByRole("button", { name: "Login Review" }));
      expect(mocks.open).toHaveBeenLastCalledWith({ ...pinned, title: "Login Review" });
      expect(saved()).toEqual([pinned]);
      expect(mocks.threads).toEqual([{ id: "session-1", name: "Login Review" }]);
      mocks.threads = [{ id: "session-1", name: "   " }];
      view.rerender(<FavoritesBar />);
      expect(screen.getByRole("button", { name: "New agent" })).toBeVisible();
      mocks.threads = [];
      view.rerender(<FavoritesBar />);
      expect(screen.getByRole("button", { name: "New agent" })).toBeVisible();
    },
  );

  it("deduplicates global/scoped targets and changes visible favorites with the workspace", () => {
    const entries = [entry("one", "One"), entry("two", "Two", "w2"), entry("one", "One", null)];
    expect(visibleFavorites(entries, "w1").map((item) => item.scopeId)).toEqual([null]);
    seed(entries);
    const view = render(<FavoritesBar />);
    expect(screen.getByRole("list", { name: "Global pins" })).toHaveTextContent("One");
    expect(screen.queryByRole("list", { name: "Workspace favorites" })).toBeNull();
    mocks.active = { id: "w2", name: "Project Two" };
    view.rerender(<FavoritesBar />);
    expect(screen.getByRole("list", { name: "Workspace favorites" })).toHaveTextContent("Two");
  });

  it("persists keyboard order, retains focus, and leaves the other scope untouched", async () => {
    seed([entry("one", "One"), entry("global", "Global", null), entry("two", "Two")]);
    render(<FavoritesBar />);
    const user = userEvent.setup();
    screen.getByRole("button", { name: "One" }).focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    expect(
      saved()
        .filter((item) => item.scopeId === "w1")
        .map((item) => item.title),
    ).toEqual(["Two", "One"]);
    expect(saved().find((item) => item.title === "Global")?.scopeId).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "One" })).toHaveFocus());
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("reorders with Alt+Arrow without also running global Back or Forward", async () => {
    seed([entry("one", "One"), entry("two", "Two")]);
    const back = vi.fn();
    const forward = vi.fn();
    function WithShortcuts() {
      useShortcuts({ openPalette: () => undefined, toggleSidebar: () => undefined, back, forward });
      return <FavoritesBar />;
    }
    render(<WithShortcuts />);
    const user = userEvent.setup();
    screen.getByRole("button", { name: "One" }).focus();
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await waitFor(() => expect(screen.getByRole("button", { name: "One" })).toHaveFocus());
    await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
    expect(saved().map((item) => item.title)).toEqual(["One", "Two"]);
    expect(back).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("supports drag reorder without opening or editing the target", () => {
    seed([entry("one", "One"), entry("two", "Two")]);
    render(<FavoritesBar />);
    const transfer = { setData: vi.fn(), effectAllowed: "" };
    fireEvent.dragStart(screen.getByRole("button", { name: "Two" }), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("button", { name: "One" }), { dataTransfer: transfer });
    expect(saved().map((item) => item.title)).toEqual(["Two", "One"]);
    fireEvent.dragStart(screen.getByRole("button", { name: "Two" }), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("button", { name: "One" }), { dataTransfer: transfer });
    expect(saved().map((item) => item.title)).toEqual(["One", "Two"]);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("reorders visible neighbors when a duplicate global pin hides an intervening favorite", async () => {
    seed([entry("one", "One"), entry("hidden", "Hidden"), entry("two", "Two"), entry("hidden", "Hidden", null)]);
    render(<FavoritesBar />);
    screen.getByRole("button", { name: "One" }).focus();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    const visible = visibleFavorites(saved(), "w1").filter((item) => item.scopeId === "w1");
    expect(visible.map((item) => item.title)).toEqual(["Two", "One"]);
    expect(saved().filter((item) => item.title === "Hidden")).toHaveLength(2);
  });

  it("retains unavailable entries, explains the failure and retries the exact target", async () => {
    seed([entry("gone", "Build terminal")]);
    mocks.check.mockResolvedValue("Terminal no longer exists.");
    mocks.open.mockResolvedValue({ opened: false, reason: "Terminal no longer exists." });
    render(<FavoritesBar />);
    const button = await screen.findByRole("button", { name: "Build terminal: Unavailable" });
    await userEvent.click(button);
    expect(screen.getByText(/Your favorite is still saved/)).toBeVisible();
    expect(saved()[0]?.target.id).toBe("gone");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.open.mock.calls[0]?.[0].target).toEqual(target("gone"));
    await userEvent.click(screen.getByRole("button", { name: "Find target" }));
    expect(mocks.find).toHaveBeenCalledWith("Build terminal");
  });

  it("offers an accessible hover action without triggering the object's click", async () => {
    const openObject = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test bubbling to an object's delegated handler.
      <div onClick={openObject} role="presentation">
        <FavoriteButton target={target("one")} title="One" />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add Favorite: One" }));
    expect(saved()[0]?.scopeId).toBe("w1");
    expect(openObject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove Favorite: One" }));
    expect(saved()).toEqual([]);
  });
});
