import type { MemoryRecord } from "@kalcode/protocol";
import { describe, expect, it } from "vitest";
import { memoryCountLine, projectMemoryView, sharingLine, VISIBLE_LIMIT } from "./projectMemory.ts";

let n = 0;
function note(over: Partial<MemoryRecord> = {}): MemoryRecord {
  n += 1;
  return {
    id: `m${n}`,
    workspaceId: "ws",
    category: "decisions",
    title: `Note ${n}`,
    content: "Some knowledge",
    pinned: false,
    permanent: false,
    sourceKind: "user",
    sourceId: null,
    filePath: null,
    fileHash: null,
    commitId: null,
    stale: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: `2026-10-0${(n % 9) + 1}T00:00:00Z`,
    ...over,
  };
}

describe("projectMemoryView", () => {
  it("counts notes, pins and stale notes", () => {
    const view = projectMemoryView([note({ pinned: true }), note({ stale: true }), note()], "");
    expect(view).toMatchObject({ total: 3, pinned: 1, stale: 1 });
  });

  it("lists pinned notes first, then the newest, up to the limit", () => {
    const records = [
      note({ title: "old", updatedAt: "2026-09-01T00:00:00Z" }),
      note({ title: "pin", pinned: true, updatedAt: "2026-08-01T00:00:00Z" }),
      note({ title: "new", updatedAt: "2026-10-04T00:00:00Z" }),
    ];
    const view = projectMemoryView(records, "");
    expect(view.shown.map((r) => r.title)).toEqual(["pin", "new", "old"]);
    expect(view.heading).toBe("Pinned and recent");
    const many = Array.from({ length: VISIBLE_LIMIT + 3 }, () => note());
    const big = projectMemoryView(many, "");
    expect(big.shown).toHaveLength(VISIBLE_LIMIT);
    expect(big.more).toBe(3);
    expect(big.heading).toBe("Recent");
  });

  it("filters by every word across title, content, category and linked file", () => {
    const records = [
      note({ title: "Billing webhooks", content: "Stripe events go through the queue" }),
      note({ title: "Pricing", content: "Plans live in plans.ts", filePath: "src/plans.ts" }),
      note({ title: "Convention", category: "conventions", content: "Use pnpm" }),
    ];
    expect(projectMemoryView(records, "stripe queue").shown.map((r) => r.title)).toEqual(["Billing webhooks"]);
    expect(projectMemoryView(records, "plans.ts").shown.map((r) => r.title)).toEqual(["Pricing"]);
    expect(projectMemoryView(records, "convention pnpm").heading).toBe("Matches");
    expect(projectMemoryView(records, "nothing like this").shown).toEqual([]);
  });
});

describe("copy", () => {
  it("states counts without zero pins", () => {
    expect(memoryCountLine({ total: 0, pinned: 0 })).toBe("No notes yet");
    expect(memoryCountLine({ total: 1, pinned: 0 })).toBe("1 note");
    expect(memoryCountLine({ total: 12, pinned: 3 })).toBe("12 notes · 3 pinned");
  });

  it("never claims agents receive memory when they don't", () => {
    expect(sharingLine(false, true)).toMatch(/included with Pro/);
    expect(sharingLine(true, false)).toMatch(/paused/);
    expect(sharingLine(true, true)).toMatch(/receive pinned notes/);
  });
});
