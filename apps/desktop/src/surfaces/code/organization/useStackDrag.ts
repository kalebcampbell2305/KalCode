/**
 * Pointer drag for the Terminal Stack: items reorder and move between groups, groups reorder.
 * The gesture state lives here, not in the Code workspace: a pointer move only updates the drop
 * target when it changes, the floating preview follows the pointer through its style (no render),
 * and auto-scroll runs one animation frame loop only while a drag is near an edge.
 *
 * Drop targets come from data attributes the stack renders:
 *   [data-drop-row] data-key data-group     an item row
 *   [data-drop-header] data-group           a group header (drop into, peeks a collapsed group)
 *   [data-drop-group] data-group            a whole group section (drop into, or before/after for a group)
 *   [data-drop-new-group]                   + New group
 */
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export type DragSubject = { kind: "item"; key: string; label: string } | { kind: "group"; id: string; label: string };

export type DropTarget =
  /** Before `before` in `group` (its end when null); the line shows on `line`'s edge. */
  | { kind: "item"; group: string; before: string | null; line: { key: string; edge: "before" | "after" } }
  /** Into a group, at its end. */
  | { kind: "into"; group: string }
  /** A group before `before` (the end when null). */
  | { kind: "group"; before: string | null; line: { group: string; edge: "before" | "after" } }
  | { kind: "new-group" }
  /** Over the dragged thing itself: dropping changes nothing. */
  | { kind: "none" };

export interface StackDragState {
  subject: DragSubject;
  target: DropTarget | null;
  /** A collapsed group shown open while an item hovers over it. */
  peek: string | null;
}

/** Movement before a press becomes a drag: a click or a trackpad wobble never drags. */
export const DRAG_THRESHOLD_PX = 5;
const TOUCH_THRESHOLD_PX = 10;
/** Hovering a collapsed group this long during a drag shows it open. */
export const PEEK_MS = 550;
/** Auto-scroll starts this close to the list's top or bottom edge. */
const EDGE_PX = 44;
const MAX_SCROLL_PX = 18;

const sameTarget = (a: DropTarget | null, b: DropTarget | null) => JSON.stringify(a) === JSON.stringify(b);

/** The drop target under a point, from the stack's rendered drop attributes; undefined off the list. */
export function hitTest(x: number, y: number, subject: DragSubject, body: HTMLElement): DropTarget | null | undefined {
  const element = document.elementFromPoint(x, y);
  if (!(element instanceof Element) || !body.contains(element)) return undefined;
  if (subject.kind === "group") {
    const section = element.closest<HTMLElement>("[data-drop-group]");
    if (!section) return null;
    const group = section.dataset.group ?? "";
    if (group === subject.id) return { kind: "none" };
    const rect = section.getBoundingClientRect();
    // Only the header half decides "before" for a tall open group, so long groups stay easy targets.
    const upper = y < rect.top + Math.min(rect.height / 2, 40);
    if (upper) return { kind: "group", before: group, line: { group, edge: "before" } };
    const next = nextSibling(section, "[data-drop-group]")?.dataset.group ?? null;
    return {
      kind: "group",
      before: next === subject.id ? (nextAfter(section, subject.id) ?? null) : next,
      line: { group, edge: "after" },
    };
  }
  if (element.closest("[data-drop-new-group]")) return { kind: "new-group" };
  const row = element.closest<HTMLElement>("[data-drop-row]");
  if (row) {
    const key = row.dataset.key ?? "";
    const group = row.dataset.group ?? "";
    if (key === subject.key) return { kind: "none" };
    const rect = row.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) return { kind: "item", group, before: key, line: { key, edge: "before" } };
    let next = nextSibling(row, "[data-drop-row]")?.dataset.key ?? null;
    if (next === subject.key)
      next = nextSibling(nextSibling(row, "[data-drop-row]") ?? row, "[data-drop-row]")?.dataset.key ?? null;
    return { kind: "item", group, before: next, line: { key, edge: "after" } };
  }
  const header = element.closest<HTMLElement>("[data-drop-header], [data-drop-group]");
  if (header) return { kind: "into", group: header.dataset.group ?? "" };
  return null;
}

function nextSibling(element: HTMLElement, selector: string): HTMLElement | null {
  let next = element.nextElementSibling;
  while (next && !next.matches(selector)) next = next.nextElementSibling;
  return next instanceof HTMLElement ? next : null;
}

function nextAfter(section: HTMLElement, skip: string): string | null {
  const next = nextSibling(section, "[data-drop-group]");
  if (!next) return null;
  if (next.dataset.group !== skip) return next.dataset.group ?? null;
  return nextSibling(next, "[data-drop-group]")?.dataset.group ?? null;
}

/** Moves the floating preview to just beside the pointer, through its style only. */
function placeGhost(ghost: HTMLDivElement | null, x: number, y: number) {
  if (ghost) ghost.style.transform = `translate3d(${Math.round(x + 14)}px, ${Math.round(y + 14)}px, 0)`;
}

interface Gesture {
  subject: DragSubject;
  pointer: number;
  x: number;
  y: number;
  threshold: number;
  active: boolean;
  lastX: number;
  lastY: number;
  peekTimer: ReturnType<typeof setTimeout> | null;
  peekGroup: string | null;
  frame: number | null;
}

export interface StackDrag {
  state: StackDragState | null;
  /** Pointer handlers for one draggable row or header. */
  bind: (subject: DragSubject) => {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: () => void;
    onLostPointerCapture: () => void;
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
  };
  /** The floating preview (positioned by the hook). */
  ghostRef: RefObject<HTMLDivElement | null>;
}

export function useStackDrag(
  body: RefObject<HTMLElement | null>,
  onDrop: (subject: DragSubject, target: DropTarget) => void,
): StackDrag {
  const [state, setState] = useState<StackDragState | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<DropTarget | null>(null);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  const end = useCallback(() => {
    const g = gesture.current;
    if (g?.peekTimer) clearTimeout(g.peekTimer);
    if (g?.frame) cancelAnimationFrame(g.frame);
    gesture.current = null;
    targetRef.current = null;
    setState(null);
  }, []);

  // Escape or leaving the window cancels a drag; the item stays where it was.
  useEffect(() => {
    if (!state) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        end();
      }
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", end);
    };
  }, [state, end]);

  const retarget = useCallback(() => {
    const g = gesture.current;
    const list = body.current;
    if (!g?.active || !list) return;
    const hit = hitTest(g.lastX, g.lastY, g.subject, list);
    // Between rows (a gap, the list's padding) the last target holds, so drops are forgiving.
    const target = hit === undefined ? null : hit === null ? targetRef.current : hit;
    const peekGroup = target?.kind === "into" ? target.group : null;
    if (peekGroup !== g.peekGroup) {
      g.peekGroup = peekGroup;
      if (g.peekTimer) clearTimeout(g.peekTimer);
      g.peekTimer = peekGroup ? setTimeout(() => setState((s) => (s ? { ...s, peek: peekGroup } : s)), PEEK_MS) : null;
    }
    if (sameTarget(target, targetRef.current)) return;
    targetRef.current = target;
    setState((s) => (s ? { ...s, target } : s));
  }, [body]);

  const scrollLoop = useCallback(() => {
    const g = gesture.current;
    const list = body.current;
    if (!g?.active || !list) return;
    g.frame = null;
    const rect = list.getBoundingClientRect();
    const top = g.lastY - rect.top;
    const bottom = rect.bottom - g.lastY;
    let speed = 0;
    if (top < EDGE_PX) speed = -Math.ceil(((EDGE_PX - Math.max(top, 0)) / EDGE_PX) * MAX_SCROLL_PX);
    else if (bottom < EDGE_PX) speed = Math.ceil(((EDGE_PX - Math.max(bottom, 0)) / EDGE_PX) * MAX_SCROLL_PX);
    if (speed === 0) return;
    const before = list.scrollTop;
    list.scrollTop += speed;
    if (list.scrollTop !== before) retarget();
    g.frame = requestAnimationFrame(scrollLoop);
  }, [body, retarget]);

  const bind = useCallback(
    (subject: DragSubject) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        suppressClick.current = false;
        if (event.button !== 0 || !event.isPrimary || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if ((event.target as HTMLElement).closest("input, [data-no-drag]")) return;
        gesture.current = {
          subject,
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          threshold: event.pointerType === "touch" ? TOUCH_THRESHOLD_PX : DRAG_THRESHOLD_PX,
          active: false,
          lastX: event.clientX,
          lastY: event.clientY,
          peekTimer: null,
          peekGroup: null,
          frame: null,
        };
        // Captured from the press, so a quick flick off the row still becomes a drag.
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic or already-released pointers can't be captured; moves over the row still work.
        }
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const g = gesture.current;
        if (!g || g.pointer !== event.pointerId) return;
        if (event.buttons === 0) {
          end();
          return;
        }
        g.lastX = event.clientX;
        g.lastY = event.clientY;
        if (!g.active) {
          if (Math.hypot(event.clientX - g.x, event.clientY - g.y) < g.threshold) return;
          g.active = true;
          targetRef.current = null;
          setState({ subject: g.subject, target: null, peek: null });
        }
        event.preventDefault();
        placeGhost(ghostRef.current, event.clientX, event.clientY);
        retarget();
        if (g.frame === null) g.frame = requestAnimationFrame(scrollLoop);
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
        const g = gesture.current;
        if (!g || g.pointer !== event.pointerId) return;
        suppressClick.current = g.active;
        const target = targetRef.current;
        const subjectNow = g.subject;
        const wasActive = g.active;
        end();
        if (wasActive && target && target.kind !== "none") dropRef.current(subjectNow, target);
      },
      onPointerCancel: end,
      onLostPointerCapture: () => {
        // Capture is released after pointerup too; only a drag still in progress ends here.
        if (gesture.current?.active) end();
      },
      onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [end, retarget, scrollLoop],
  );

  // Position the preview where the drag began before its first paint.
  useEffect(() => {
    const g = gesture.current;
    if (state && g) placeGhost(ghostRef.current, g.lastX, g.lastY);
  }, [state]);

  return { state, bind, ghostRef };
}
