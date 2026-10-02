import type { ThreadSummary } from "@kalcode/protocol";
import { type PointerEvent, useSyncExternalStore } from "react";

/**
 * Dragging a thread onto a Provider Dock account. Pointer events rather than HTML5 drag and drop:
 * the desktop webview's native file-drop handling swallows HTML5 drag events on Windows, and a
 * pointer gesture behaves the same in both webviews. Any thread row can start a drag with
 * `onPointerDown={(e) => beginThreadDrag(e, thread)}`; the dock reads the live gesture and
 * receives the drop. A drag never rebinds by itself: the dock asks for confirmation.
 */

export interface ThreadDrag {
  thread: ThreadSummary;
  x: number;
  y: number;
  /** The dock account under the pointer (its `data-dock-account` id), if any. */
  overAccountId: string | null;
}

/** Movement (px) before a press on a row becomes a drag; below it the row's click still opens it. */
export const THREAD_DRAG_THRESHOLD = 6;

let current: ThreadDrag | null = null;
let dropHandler: ((thread: ThreadSummary, accountId: string) => void) | null = null;
const listeners = new Set<() => void>();

function publish(next: ThreadDrag | null) {
  current = next;
  if (typeof document !== "undefined") {
    if (next) document.documentElement.dataset.threadDrag = "";
    else delete document.documentElement.dataset.threadDrag;
  }
  for (const listener of listeners) listener();
}

function accountAt(x: number, y: number): string | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") return null;
  const hit = document.elementFromPoint(x, y);
  const chip = hit instanceof Element ? hit.closest<HTMLElement>("[data-dock-account]") : null;
  return chip?.dataset.dockAccount ?? null;
}

/** The click that ends a drag must not also open the row it started on. */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/** Starts watching a press on a thread row; it becomes a drag once it moves past the threshold. */
export function beginThreadDrag(event: PointerEvent<HTMLElement>, thread: ThreadSummary): void {
  if (event.button !== 0 || thread.archivedAt) return;
  const start = { x: event.clientX, y: event.clientY };
  let active = false;

  const onMove = (e: globalThis.PointerEvent) => {
    if (!active && Math.hypot(e.clientX - start.x, e.clientY - start.y) < THREAD_DRAG_THRESHOLD) return;
    if (!active) window.getSelection?.()?.removeAllRanges();
    active = true;
    publish({ thread, x: e.clientX, y: e.clientY, overAccountId: accountAt(e.clientX, e.clientY) });
  };
  const stop = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("dragstart", noNativeDrag, true);
  };
  const onUp = (e: globalThis.PointerEvent) => {
    stop();
    if (!active) return;
    swallowNextClick();
    const accountId = accountAt(e.clientX, e.clientY);
    publish(null);
    if (accountId) dropHandler?.(thread, accountId);
  };
  const onCancel = () => {
    stop();
    publish(null);
  };
  // A row's provider mark is an <img>: the browser's own image drag would cancel this gesture.
  const noNativeDrag = (e: DragEvent) => e.preventDefault();
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !active) return;
    e.preventDefault();
    active = false;
    onCancel();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("dragstart", noNativeDrag, true);
}

/** The dock registers where drops go; returns the unregister function. */
export function onThreadDrop(handler: (thread: ThreadSummary, accountId: string) => void): () => void {
  dropHandler = handler;
  return () => {
    if (dropHandler === handler) dropHandler = null;
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The thread being dragged right now, with the pointer and the account under it. */
export function useThreadDrag(): ThreadDrag | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}
