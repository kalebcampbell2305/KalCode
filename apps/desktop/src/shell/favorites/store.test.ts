import { describe, expect, it, vi } from "vitest";
import { type FavoriteTarget, favoriteKey, hydrateFavorites, normalizeFavoriteTarget } from "./model.ts";
import { createFavoritesStore, FAVORITES_STORAGE_KEY } from "./store.ts";

const target = (id: string, kind: FavoriteTarget["kind"] = "thread"): FavoriteTarget => ({
  kind,
  id,
  workspaceId: "workspace-a",
});
function fixture(raw: string | null = null) {
  let value = raw;
  const storage = {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
  };
  const store = createFavoritesStore(() => storage, window);
  return {
    storage,
    store,
    persisted: () => value,
    external: (next: string) => {
      value = next;
      window.dispatchEvent(new StorageEvent("storage", { key: FAVORITES_STORAGE_KEY }));
    },
  };
}

describe("favorite storage", () => {
  it("persists independent global/workspace order across reload and deduplicates agent/thread aliases", () => {
    const { store, persisted } = fixture();
    store.toggle(target("a"), "First", null);
    store.toggle(target("b"), "Second", null);
    store.toggle(target("a"), "Project first", "workspace-a");
    store.move(favoriteKey(target("b"), null), favoriteKey(target("a"), null));
    expect(
      fixture(persisted())
        .store.getSnapshot()
        .entries.map((entry) => entry.title),
    ).toEqual(["Second", "First", "Project first"]);
    store.toggle(target("a", "agent"), "Same session", null);
    expect(store.getSnapshot().entries.map((entry) => entry.title)).toEqual(["Second", "Project first"]);
  });

  it("does not pretend a quota failure persisted a favorite", () => {
    const { store, storage } = fixture();
    store.toggle(target("a"), "First", null);
    storage.setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(store.toggle(target("b"), "Second", null)).toBe(false);
    expect(store.getSnapshot().entries.map((entry) => entry.target.id)).toEqual(["a"]);
    expect(store.getSnapshot().error).toContain("weren't saved");
  });

  it("retains corrupt storage and surfaces a truthful error instead of overwriting it", () => {
    const { store, persisted } = fixture("broken-json");
    expect(store.getSnapshot().error).toContain("couldn't be read");
    expect(store.toggle(target("a"), "First", null)).toBe(false);
    expect(persisted()).toBe("broken-json");
  });

  it("refreshes subscribed consumers from another window and merges latest entries before saving", () => {
    const { store, external } = fixture();
    const subscriber = vi.fn();
    const unsubscribe = store.subscribe(subscriber);
    external(JSON.stringify({ version: 1, entries: [{ target: target("other"), title: "Elsewhere", scopeId: null }] }));
    expect(subscriber).toHaveBeenCalled();
    store.toggle(target("local"), "Here", null);
    expect(store.getSnapshot().entries.map((entry) => entry.target.id)).toEqual(["other", "local"]);
    unsubscribe();
  });

  it("hydrates only stable fields, repairs keys and rejects unsafe paths", () => {
    const entries = hydrateFavorites(
      JSON.stringify({
        version: 1,
        entries: [
          {
            key: "untrusted",
            target: { ...target("a"), processHandle: 12, token: "secret" },
            title: "A",
            scopeId: null,
            runtime: "secret",
          },
          { target: target("a", "agent"), title: "Alias", scopeId: null },
          { target: target("../secret", "file"), title: "Outside", scopeId: null },
        ],
      }),
    );
    expect(entries).toEqual([{ key: favoriteKey(target("a"), null), target: target("a"), title: "A", scopeId: null }]);
  });

  it("preserves ordinary browser search/filter and fragment context exactly", () => {
    const url = "https://example.com/search?q=react&sort=recent#results";
    const { store, persisted } = fixture();
    expect(store.toggle(target(url, "browser"), "Search", null)).toBe(true);
    expect(hydrateFavorites(persisted())[0]?.target.id).toBe(url);
  });

  it.each([
    "https://user:password@example.com/",
    "https://example.com/?access_token=secret",
    "https://example.com/?X-Amz-Signature=secret",
    "https://example.com/#access_token=secret",
    "https://example.com/?apiKey=secret",
    "https://example.com/?code=secret",
    "javascript:alert(1)",
  ])("rejects sensitive/unsupported browser URL %s without persisting", (url) => {
    const { store, persisted } = fixture();
    expect(store.toggle(target(url, "browser"), "Page", null)).toBe(false);
    expect(store.getSnapshot().error).toContain("temporary sign-in tokens");
    expect(persisted()).toBeNull();
  });

  it.each(["../file", "/absolute", "C:\\absolute", "a/../file"])("rejects unsafe relative file target %s", (path) => {
    expect(normalizeFavoriteTarget(target(path, "file"))).toBeNull();
  });
});
