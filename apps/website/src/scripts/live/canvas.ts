/** Scoped pointer/keyboard controls for the temporary Adaptive Canvas sample. */
import { canvasAction, canvasState, visibleCanvasFrames } from "../../lib/live/canvas";
import type { State } from "../../lib/live/model";

type Zone = "before" | "after" | "tabs";
export function snapZone(position: number, previous: Zone | null): Zone {
  if (previous === "before" && position < 0.36) return previous;
  if (previous === "after" && position > 0.64) return previous;
  return position < 0.28 ? "before" : position > 0.72 ? "after" : "tabs";
}
interface Hooks {
  getState(): State;
  render(): void;
  focusSoon?(selector: string): void;
}
export function mountAdaptiveCanvas(host: HTMLElement, hooks: Hooks) {
  const drafts = new Map<string, string>();
  let currentState = hooks.getState();
  let lastFocus = currentState.focus;
  let gesture: {
    source: string;
    x: number;
    y: number;
    active: boolean;
    target: string | null;
    zone: Zone | null;
  } | null = null;
  let suppressClick = false;
  const signal = new AbortController();
  const options = { signal: signal.signal };
  const selector = (id: string) => `[data-canvas-frame="${CSS.escape(id)}"]`;
  function focusFrame() {
    const state = hooks.getState();
    const frame = host.querySelector<HTMLElement>(selector(state.focus));
    frame?.focus({ preventScroll: true });
    frame?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }
  function act(action: string): boolean {
    if (!canvasAction(hooks.getState(), action)) return false;
    hooks.render();
    return true;
  }
  function clearPreview() {
    for (const frame of host.querySelectorAll<HTMLElement>("[data-canvas-snap]"))
      frame.removeAttribute("data-canvas-snap");
    host.removeAttribute("data-canvas-dragging");
  }
  function cancel() {
    gesture = null;
    clearPreview();
  }
  host.addEventListener(
    "input",
    (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      if (input.hasAttribute("data-canvas-resize")) {
        act(`canvas:resize:${input.value}`);
        return;
      }
      if (input.dataset.key && !input.hasAttribute("data-palette")) drafts.set(input.dataset.key, input.value);
    },
    options,
  );
  host.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      for (const input of form.querySelectorAll<HTMLInputElement>("input[data-key]"))
        drafts.delete(input.dataset.key ?? "");
    },
    { ...options, capture: true },
  );
  host.addEventListener(
    "click",
    (event) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { ...options, capture: true },
  );
  host.addEventListener(
    "keydown",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.defaultPrevented || target?.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      if (event.key === "Escape" && gesture) {
        event.preventDefault();
        cancel();
        return;
      }
      if (!event.ctrlKey || !event.altKey || event.metaKey) return;
      const state = hooks.getState();
      if (state.surface !== "code") return;
      const visible = visibleCanvasFrames(state);
      const directions: Record<string, "left" | "right" | "up" | "down"> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
      };
      const arrow = directions[event.key];
      // Option changes the produced letter on macOS; Windows AltGr characters must remain typing.
      const key =
        /Mac/.test(navigator.platform) && /^Key[A-Z]$/.test(event.code)
          ? event.code.slice(3).toLowerCase()
          : event.key.toLowerCase();
      const movement = event.shiftKey
        ? ({ h: "left", l: "right", k: "up", j: "down" } as const)[key as "h" | "l" | "k" | "j"]
        : undefined;
      let action: string | null = null;
      if (arrow !== undefined && event.shiftKey) {
        const sign = arrow === "right" || arrow === "down" ? 1 : -1;
        action = `canvas:resize:${canvasState(state).share + sign * 10}`;
      } else if (arrow !== undefined || movement !== undefined) {
        const direction = arrow ?? movement;
        const forward = direction === "right" || direction === "down";
        const source = host.querySelector<HTMLElement>(selector(state.focus))?.getBoundingClientRect();
        const next = state.mobile
          ? visible[visible.findIndex((frame) => frame.id === state.focus) + (forward ? 1 : -1)]
          : visible
              .filter((frame) => frame.id !== state.focus)
              .map((frame) => {
                const rect = host.querySelector<HTMLElement>(selector(frame.id))?.getBoundingClientRect();
                if (!source || !rect?.width || !rect.height) return null;
                const dx = rect.x + rect.width / 2 - source.x - source.width / 2;
                const dy = rect.y + rect.height / 2 - source.y - source.height / 2;
                const distance = direction === "left" || direction === "right" ? dx : dy;
                if (forward ? distance <= 1 : distance >= -1) return null;
                return { frame, distance: Math.hypot(dx, dy) };
              })
              .filter((item): item is { frame: (typeof visible)[number]; distance: number } => item !== null)
              .sort((a, b) => a.distance - b.distance)[0]?.frame;
        if (!next) return;
        action =
          movement !== undefined
            ? `canvas:move:${state.focus}:${forward ? "after" : "before"}:${next.id}`
            : `canvas:focus:${next.id}`;
      } else if (key === "d") action = `canvas:split:${state.focus}`;
      else if (!event.shiftKey) {
        if (key === "enter") action = `canvas:maximize:${state.focus}`;
        else if (key === "h") action = `canvas:minimize:${state.focus}`;
        else if (key === "t") action = "canvas:tidy";
        else if (key === "z") action = "canvas:undo";
      }
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      act(action);
      focusFrame();
    },
    { ...options, capture: true },
  );
  host.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const grip = target?.closest<HTMLElement>("[data-canvas-grip]");
      const source = grip?.dataset.canvasGrip;
      if (!source) return;
      event.preventDefault();
      gesture = { source, x: event.clientX, y: event.clientY, active: false, target: null, zone: null };
    },
    options,
  );
  window.addEventListener(
    "pointermove",
    (event) => {
      if (!gesture) return;
      if (!gesture.active && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6) return;
      gesture.active = true;
      const frame = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-canvas-frame]");
      const id = frame?.dataset.canvasFrame;
      clearPreview();
      host.setAttribute("data-canvas-dragging", "true");
      if (!frame || !host.contains(frame) || !id || id === gesture.source || frame.hidden) {
        gesture.target = null;
        gesture.zone = null;
        return;
      }
      const rect = frame.getBoundingClientRect();
      const zone = snapZone(
        (event.clientX - rect.left) / Math.max(1, rect.width),
        gesture.target === id ? gesture.zone : null,
      );
      gesture.target = id;
      gesture.zone = zone;
      frame.dataset.canvasSnap = zone;
    },
    options,
  );
  window.addEventListener(
    "pointerup",
    () => {
      const previous = gesture;
      cancel();
      if (!previous?.active) return;
      suppressClick = true;
      window.setTimeout(() => {
        suppressClick = false;
      }, 0);
      if (previous.target && previous.zone) {
        act(`canvas:move:${previous.source}:${previous.zone}:${previous.target}`);
        focusFrame();
      }
    },
    options,
  );
  window.addEventListener("pointercancel", cancel, options);
  return {
    act,
    /** A pane is held by its grip: the workspace must not re-render it out from under the pointer. */
    dragging: () => gesture !== null,
    afterRender() {
      const state = hooks.getState();
      if (currentState !== state) {
        currentState = state;
        drafts.clear();
        cancel();
      }
      // Existing Agent Fleet and tab navigation still reveal a minimized target.
      if (lastFocus !== state.focus) {
        lastFocus = state.focus;
        if (canvasState(state).minimized.delete(state.focus)) {
          hooks.render();
          return;
        }
      }
      for (const input of host.querySelectorAll<HTMLInputElement>("input[data-key]")) {
        const draft = drafts.get(input.dataset.key ?? "");
        if (draft !== undefined && input.value !== draft) input.value = draft;
      }
      for (const range of host.querySelectorAll<HTMLInputElement>("[data-canvas-resize]"))
        range.value = String(canvasState(state).share);
      if (gesture?.active && gesture.target && gesture.zone)
        host.querySelector<HTMLElement>(selector(gesture.target))?.setAttribute("data-canvas-snap", gesture.zone);
    },
    destroy() {
      signal.abort();
      cancel();
      drafts.clear();
    },
  };
}
