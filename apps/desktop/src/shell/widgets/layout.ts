/**
 * The widget dock's layout (Z7-W3): which widgets show, in what order, at what height. A pure
 * model: every change goes through `applyLayout`, which also repairs stored layouts (unknown ids
 * dropped, new defaults appended, the visible cap and height bounds enforced).
 */

export const MIN_WIDGET_HEIGHT = 140;
export const MAX_WIDGET_HEIGHT = 720;
/** At most this many widgets show at once: a dock, not a wall of panels. */
export const MAX_VISIBLE_WIDGETS = 6;
export const HEIGHT_STEP = 24;

export interface WidgetSpec {
  id: string;
  defaultHeight: number;
  /** Shown in a fresh layout. */
  defaultVisible: boolean;
}

export interface WidgetLayout {
  /** Visible widgets, top to bottom. */
  order: string[];
  /** Widgets the person hid (restorable). */
  hidden: string[];
  /** Body heights in pixels, per widget. */
  heights: Record<string, number>;
}

export type LayoutChange =
  | { kind: "move"; id: string; to: number }
  | { kind: "hide"; id: string }
  | { kind: "show"; id: string }
  | { kind: "resize"; id: string; height: number }
  | { kind: "reset" };

export function clampHeight(height: number): number {
  if (!Number.isFinite(height)) return MIN_WIDGET_HEIGHT;
  return Math.round(Math.min(MAX_WIDGET_HEIGHT, Math.max(MIN_WIDGET_HEIGHT, height)));
}

export function defaultLayout(specs: readonly WidgetSpec[]): WidgetLayout {
  const visible = specs.filter((s) => s.defaultVisible).slice(0, MAX_VISIBLE_WIDGETS);
  return {
    order: visible.map((s) => s.id),
    hidden: specs.filter((s) => !visible.includes(s)).map((s) => s.id),
    heights: Object.fromEntries(specs.map((s) => [s.id, clampHeight(s.defaultHeight)])),
  };
}

/** Repairs a stored (possibly stale or hand-edited) layout against the registered widgets. */
export function normalizeLayout(value: unknown, specs: readonly WidgetSpec[]): WidgetLayout {
  const fallback = defaultLayout(specs);
  if (!value || typeof value !== "object") return fallback;
  const raw = value as Partial<Record<keyof WidgetLayout, unknown>>;
  const known = new Set(specs.map((s) => s.id));
  const ids = (list: unknown) =>
    Array.isArray(list) ? list.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
  const order = [...new Set(ids(raw.order))].slice(0, MAX_VISIBLE_WIDGETS);
  const hidden = [...new Set(ids(raw.hidden))].filter((id) => !order.includes(id));
  // Widgets registered after the layout was saved take their default place.
  for (const spec of specs) {
    if (order.includes(spec.id) || hidden.includes(spec.id)) continue;
    if (spec.defaultVisible && order.length < MAX_VISIBLE_WIDGETS) order.push(spec.id);
    else hidden.push(spec.id);
  }
  const storedHeights = raw.heights && typeof raw.heights === "object" ? (raw.heights as Record<string, unknown>) : {};
  const heights = Object.fromEntries(
    specs.map((s) => {
      const stored = storedHeights[s.id];
      return [s.id, clampHeight(typeof stored === "number" ? stored : s.defaultHeight)];
    }),
  );
  return { order, hidden, heights };
}

export function applyLayout(layout: WidgetLayout, change: LayoutChange, specs: readonly WidgetSpec[]): WidgetLayout {
  switch (change.kind) {
    case "reset":
      return defaultLayout(specs);
    case "move": {
      const from = layout.order.indexOf(change.id);
      if (from < 0) return layout;
      const to = Math.max(0, Math.min(layout.order.length - 1, change.to));
      if (to === from) return layout;
      const order = [...layout.order];
      order.splice(from, 1);
      order.splice(to, 0, change.id);
      return { ...layout, order };
    }
    case "hide":
      if (!layout.order.includes(change.id)) return layout;
      return {
        ...layout,
        order: layout.order.filter((id) => id !== change.id),
        hidden: [...layout.hidden.filter((id) => id !== change.id), change.id],
      };
    case "show":
      if (layout.order.includes(change.id) || layout.order.length >= MAX_VISIBLE_WIDGETS) return layout;
      if (!specs.some((s) => s.id === change.id)) return layout;
      return {
        ...layout,
        order: [...layout.order, change.id],
        hidden: layout.hidden.filter((id) => id !== change.id),
      };
    case "resize":
      if (!specs.some((s) => s.id === change.id)) return layout;
      return { ...layout, heights: { ...layout.heights, [change.id]: clampHeight(change.height) } };
  }
}
