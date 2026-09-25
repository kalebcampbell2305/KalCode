import { describe, expect, it } from "vitest";
import {
  applyLayout,
  defaultLayout,
  MAX_VISIBLE_WIDGETS,
  MAX_WIDGET_HEIGHT,
  MIN_WIDGET_HEIGHT,
  normalizeLayout,
  type WidgetSpec,
} from "./layout.ts";
import { WIDGETS } from "./registry.tsx";

const specs: WidgetSpec[] = [
  { id: "a", defaultHeight: 200, defaultVisible: true },
  { id: "b", defaultHeight: 300, defaultVisible: true },
  { id: "c", defaultHeight: 100, defaultVisible: false },
];

describe("widget layout", () => {
  it("defaults show the default widgets in order with clamped heights", () => {
    const layout = defaultLayout(specs);
    expect(layout.order).toEqual(["a", "b"]);
    expect(layout.hidden).toEqual(["c"]);
    expect(layout.heights.c).toBe(MIN_WIDGET_HEIGHT);
  });

  it("the shipped defaults fit under the cap", () => {
    const layout = defaultLayout(WIDGETS);
    expect(layout.order).toEqual([
      "approvals",
      "active-agents",
      "provider-health",
      "activity",
      "terminals",
      "runtime-health",
    ]);
    expect(layout.order.length).toBeLessThanOrEqual(MAX_VISIBLE_WIDGETS);
  });

  it("moves, hides, shows, resizes and resets", () => {
    let layout = defaultLayout(specs);
    layout = applyLayout(layout, { kind: "move", id: "b", to: 0 }, specs);
    expect(layout.order).toEqual(["b", "a"]);
    layout = applyLayout(layout, { kind: "hide", id: "b" }, specs);
    expect(layout.order).toEqual(["a"]);
    expect(layout.hidden).toContain("b");
    layout = applyLayout(layout, { kind: "show", id: "c" }, specs);
    expect(layout.order).toEqual(["a", "c"]);
    layout = applyLayout(layout, { kind: "resize", id: "a", height: 99_999 }, specs);
    expect(layout.heights.a).toBe(MAX_WIDGET_HEIGHT);
    expect(applyLayout(layout, { kind: "reset" }, specs)).toEqual(defaultLayout(specs));
  });

  it("never shows more than the cap", () => {
    const many: WidgetSpec[] = Array.from({ length: MAX_VISIBLE_WIDGETS + 2 }, (_, i) => ({
      id: `w${i}`,
      defaultHeight: 200,
      defaultVisible: true,
    }));
    const layout = defaultLayout(many);
    expect(layout.order).toHaveLength(MAX_VISIBLE_WIDGETS);
    const last = many[many.length - 1]?.id ?? "";
    expect(applyLayout(layout, { kind: "show", id: last }, many)).toBe(layout);
  });

  it("repairs stored layouts: unknown ids dropped, new widgets added, junk ignored", () => {
    const repaired = normalizeLayout({ order: ["b", "zzz", "b"], hidden: ["a"], heights: { b: "tall" } }, specs);
    expect(repaired.order).toEqual(["b"]);
    expect(repaired.hidden).toEqual(["a", "c"]);
    expect(repaired.heights.b).toBe(300);
    expect(normalizeLayout("nonsense", specs)).toEqual(defaultLayout(specs));
  });
});
