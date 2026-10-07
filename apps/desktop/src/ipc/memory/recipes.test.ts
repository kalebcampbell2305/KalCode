import type { LaunchRecipe } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { createRecipesMemory } from "./recipes.ts";

const make = (id: string, name: string, over: Partial<LaunchRecipe> = {}): LaunchRecipe => ({
  id,
  name,
  schemaVersion: 1,
  workspaceId: null,
  pinned: false,
  position: 99,
  variables: [],
  components: [],
  layout: null,
  updatedAt: "",
  ...over,
});
const setup = () => createRecipesMemory({ requireCore: () => {} }).handlers;
const save = (h: ReturnType<typeof setup>, r: LaunchRecipe) => h.launch_recipe_save?.({ recipe: r }) as LaunchRecipe;
const snap = (h: ReturnType<typeof setup>) =>
  h.launch_recipes_snapshot?.({}) as { recipes: LaunchRecipe[]; limit: number | null };

describe("recipes memory", () => {
  it("appends positions, stamps updatedAt, and has no limit", () => {
    const h = setup();
    const a = save(h, make("a", "Alpha"));
    const b = save(h, make("b", "Beta"));
    expect([a.position, b.position]).toEqual([0, 1]);
    expect(a.updatedAt).not.toBe("");
    expect(snap(h).limit).toBeNull();
    expect(save(h, { ...a, pinned: true }).position).toBe(0);
  });
  it("rejects duplicate names case-insensitively", () => {
    const h = setup();
    save(h, make("a", "Alpha"));
    expect(() => save(h, make("b", "ALPHA"))).toThrow();
    try {
      save(h, make("b", "ALPHA"));
    } catch (error) {
      expect((error as { message: string }).message).toMatch(/distinct name/);
    }
  });
  it("validates name, schema, counts, keys and urls", () => {
    const h = setup();
    expect(() => save(h, make("a", " "))).toThrow();
    expect(() => save(h, make("a", "x".repeat(121)))).toThrow();
    expect(() => save(h, make("a", "A", { schemaVersion: 2 }))).toThrow();
    const parts = Array.from({ length: 33 }, (_, i) => ({ kind: "widget" as const, key: `k${i}`, widget: "w" }));
    expect(() => save(h, make("a", "A", { components: parts }))).toThrow();
    expect(() => save(h, make("a", "A", { components: [parts[0], parts[0]] as LaunchRecipe["components"] }))).toThrow();
    expect(() => save(h, make("a", "A", { components: [{ kind: "browser", key: "b", url: "ftp://x" }] }))).toThrow();
  });
  it("rejects secret-shaped values", () => {
    const h = setup();
    const bad = make("a", "A", {
      components: [{ kind: "terminal", key: "t", name: null, command: "export K=sk-abcdefgh12345" }],
    });
    try {
      save(h, bad);
      expect.unreachable();
    } catch (error) {
      expect((error as { message: string }).message).toMatch(/secret-shaped/);
    }
  });
  it("reorders only with the exact id set and deletes", () => {
    const h = setup();
    save(h, make("a", "Alpha"));
    save(h, make("b", "Beta"));
    expect(() => h.launch_recipe_reorder?.({ ids: ["a"] })).toThrow();
    const out = h.launch_recipe_reorder?.({ ids: ["b", "a"] }) as { recipes: LaunchRecipe[] };
    expect(out.recipes.map((r) => r.id)).toEqual(["b", "a"]);
    h.launch_recipe_delete?.({ id: "b" });
    expect(snap(h).recipes.map((r) => [r.id, r.position])).toEqual([["a", 0]]);
  });
});
