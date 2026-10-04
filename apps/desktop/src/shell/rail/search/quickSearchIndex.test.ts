import { describe, expect, it } from "vitest";
import { QuickSearchIndex } from "./quickSearchIndex.ts";

const item = (id: string, label: string, workspaceId = "other", metadata = "") => ({
  id,
  label,
  workspaceId,
  metadata,
  kind: "File",
  target: id,
});

describe("quick switcher local index", () => {
  it("ranks exact names before contextual prefixes, then workspace and recent use", () => {
    const index = new QuickSearchIndex<string>();
    index.add(item("outside", "parser", "other"));
    index.add(item("current", "parser", "current"));
    index.add(item("recent", "parser", "current"));
    index.add(item("prefix", "parser tests", "current"));
    const recent = new Map([
      ["recent", Date.now()],
      ["prefix", Date.now()],
    ]);
    expect(index.search("parser", "current", recent).map((entry) => entry.id)).toEqual([
      "recent",
      "current",
      "outside",
      "prefix",
    ]);
  });

  it("matches path fragments, diacritics and metadata while keeping duplicate names distinct", () => {
    const index = new QuickSearchIndex<string>();
    index.add(item("one", "Resume.ts", "one", "src/accounts/Cafe"));
    index.add(item("two", "Resume.ts", "two", "src/providers/production"));
    expect(index.search("resume production", null, new Map()).map((entry) => entry.id)).toEqual(["two"]);
    expect(index.search("src/acc", null, new Map()).map((entry) => entry.id)).toEqual(["one"]);
    expect(index.search("missing", null, new Map())).toEqual([]);
  });

  it("bounds result count and queries a large project without scanning the result DOM", () => {
    const index = new QuickSearchIndex<string>();
    for (let n = 0; n < 20000; n++)
      index.add(item(`file:${n}`, `component-${n}.tsx`, "project", `src/feature-${n}/components`));
    expect(index.search("component", "project", new Map())).toHaveLength(24);
    expect(index.search("component-19999", "project", new Map()).map((entry) => entry.id)).toEqual(["file:19999"]);
    const start = performance.now();
    for (let n = 0; n < 100; n++) index.search(`component-${19000 + n}`, "project", new Map());
    // Generous CI budget: 100 interactions should still take less than one second.
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
