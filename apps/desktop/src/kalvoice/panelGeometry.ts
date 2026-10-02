/**
 * Geometry for the floating KalVoice panel: size classes, docking and clamping. Positions are
 * stored as anchors plus proportional coordinates (thousandths of the free space), so the
 * panel keeps its place when the window is resized and can never end up off-screen.
 */
import type { PanelAnchor, PanelPlacement, PanelView, SizeClass } from "@kalcode/protocol";

export const EDGE_MARGIN = 16;
/** Distance from an edge within which a drop docks to it. */
export const SNAP_DISTANCE = 28;

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  left: number;
  top: number;
}

export function sizeClassFor(windowWidth: number): SizeClass {
  if (windowWidth < 1100) return "narrow";
  if (windowWidth < 1500) return "regular";
  return "wide";
}

interface Bounds {
  minLeft: number;
  maxLeft: number;
  minTop: number;
  maxTop: number;
}

/**
 * Where the panel may sit (Z7-W1 shell slot): right of `left` (the sidebar), and `top` /
 * `bottom` pixels from those edges (the reserved voice slot centres it). Defaults: the whole
 * window with the usual margins.
 */
export interface PanelArea {
  left: number;
  top: number;
  bottom: number;
  /** Pixels kept clear at the right edge (the Command Deck's agents rail); default 0. */
  right?: number;
}

const WHOLE_WINDOW: PanelArea = { left: 0, top: EDGE_MARGIN, bottom: EDGE_MARGIN };

function bounds(viewport: Size, panel: Size, area: PanelArea = WHOLE_WINDOW): Bounds {
  const minLeft = area.left + EDGE_MARGIN;
  const minTop = area.top;
  return {
    minLeft,
    minTop,
    maxLeft: Math.max(minLeft, viewport.width - (area.right ?? 0) - panel.width - EDGE_MARGIN),
    maxTop: Math.max(minTop, viewport.height - panel.height - area.bottom),
  };
}

function fromFraction(fraction: number, min: number, max: number): number {
  return min + (Math.max(0, Math.min(1000, fraction)) / 1000) * (max - min);
}

function toFraction(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.round(Math.max(0, Math.min(1, (value - min) / (max - min))) * 1000);
}

/** Pixel position for a placement, always inside the viewport. */
export function positionFor(
  placement: { anchor: PanelAnchor; x: number; y: number },
  viewport: Size,
  panel: Size,
  area?: PanelArea,
): Point {
  const b = bounds(viewport, panel, area);
  const freeLeft = fromFraction(placement.x, b.minLeft, b.maxLeft);
  const freeTop = fromFraction(placement.y, b.minTop, b.maxTop);
  const centerLeft = (b.minLeft + b.maxLeft) / 2;
  const table: Record<PanelAnchor, Point> = {
    free: { left: freeLeft, top: freeTop },
    top_left: { left: b.minLeft, top: b.minTop },
    top: { left: freeLeft, top: b.minTop },
    top_right: { left: b.maxLeft, top: b.minTop },
    left: { left: b.minLeft, top: freeTop },
    right: { left: b.maxLeft, top: freeTop },
    bottom_left: { left: b.minLeft, top: b.maxTop },
    bottom: { left: freeLeft, top: b.maxTop },
    bottom_right: { left: b.maxLeft, top: b.maxTop },
  };
  const point = table[placement.anchor] ?? { left: centerLeft, top: b.maxTop };
  return {
    left: Math.round(Math.min(b.maxLeft, Math.max(b.minLeft, point.left))),
    top: Math.round(Math.min(b.maxTop, Math.max(b.minTop, point.top))),
  };
}

/** Where a drop at `point` lands: docked to an edge or corner when close to it, else free. */
export function placementAt(
  point: Point,
  viewport: Size,
  panel: Size,
  snap: number = SNAP_DISTANCE,
  area?: PanelArea,
): { anchor: PanelAnchor; x: number; y: number } {
  const b = bounds(viewport, panel, area);
  const left = Math.min(b.maxLeft, Math.max(b.minLeft, point.left));
  const top = Math.min(b.maxTop, Math.max(b.minTop, point.top));
  const nearLeft = left - b.minLeft <= snap;
  const nearRight = b.maxLeft - left <= snap;
  const nearTop = top - b.minTop <= snap;
  const nearBottom = b.maxTop - top <= snap;
  const x = toFraction(left, b.minLeft, b.maxLeft);
  const y = toFraction(top, b.minTop, b.maxTop);
  let anchor: PanelAnchor = "free";
  if (nearTop && nearLeft) anchor = "top_left";
  else if (nearTop && nearRight) anchor = "top_right";
  else if (nearBottom && nearLeft) anchor = "bottom_left";
  else if (nearBottom && nearRight) anchor = "bottom_right";
  else if (nearLeft) anchor = "left";
  else if (nearRight) anchor = "right";
  else if (nearTop) anchor = "top";
  else if (nearBottom) anchor = "bottom";
  return { anchor, x, y };
}

/** Moves the panel by a pixel offset (keyboard). Docks only when it reaches an edge, so small
 * steps away from a corner aren't pulled back into it. */
export function nudge(
  placement: { anchor: PanelAnchor; x: number; y: number },
  dx: number,
  dy: number,
  viewport: Size,
  panel: Size,
  area?: PanelArea,
): { anchor: PanelAnchor; x: number; y: number } {
  const from = positionFor(placement, viewport, panel, area);
  return placementAt({ left: from.left + dx, top: from.top + dy }, viewport, panel, 0, area);
}

/** The saved placement for a size class, or the default anchor in compact view. */
export function placementFor(
  placements: readonly PanelPlacement[],
  sizeClass: SizeClass,
  defaultAnchor: PanelAnchor,
): PanelPlacement {
  return (
    placements.find((p) => p.sizeClass === sizeClass) ?? {
      sizeClass,
      anchor: defaultAnchor,
      // Edge anchors start centred along their edge.
      x: 500,
      y: 500,
      view: "compact" satisfies PanelView,
    }
  );
}

export const ANCHOR_LABELS: Record<PanelAnchor, string> = {
  free: "Where I put it",
  top_left: "Top left",
  top: "Top",
  top_right: "Top right",
  left: "Left edge",
  right: "Right edge",
  bottom_left: "Bottom left",
  bottom: "Bottom",
  bottom_right: "Bottom right",
};
