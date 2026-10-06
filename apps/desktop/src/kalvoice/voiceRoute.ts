/**
 * KalVoice routing light (AGENTS.md "Permanent futuristic space design system"): after a voice
 * command moves focus, a short electric comet travels from the KalVoice orb to where the result
 * landed, and that element lights briefly. It shows causality ("this is what you asked for");
 * it never changes what the command did, and it is purely visual (aria-hidden, no focus change).
 *
 * Cost: nothing runs until a command routes. Then a few timer reads find the destination, one
 * Web Animation (transform and opacity only) plays for ~260 ms, and one attribute is set for
 * ~1.1 s. Reduced motion skips the comet; the destination still lights (without a transition).
 */

/** Where the result of a command lands. */
export type VoiceRouteKind =
  /** A page or surface: its sidebar entry when visible, otherwise the page. */
  | "surface"
  /** A Code pane: the focused pane. */
  | "pane"
  /** Whatever the command focused (a run row, a dialog): the focused element. */
  | "focus";

export const VOICE_TARGET_ATTR = "data-voice-target";
export const VOICE_ROUTE_EVENT = "kalvoice:route";
const LIGHT_MS = 1_100;
/** The destination may render a moment after the command (Code opening, a pane appearing). */
const FIND_DELAYS = [0, 90, 220, 420, 800];

export interface VoiceRouteDetail {
  /** The destination's box in viewport coordinates. */
  to: { x: number; y: number; width: number; height: number };
}

function visible(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

/** The element a route of `kind` lands on, or null when nothing on screen represents it. */
export function routeDestination(kind: VoiceRouteKind, doc: Document = document): HTMLElement | null {
  const main = doc.getElementById("main");
  if (kind === "pane") {
    const pane = doc.querySelector("[data-pane-id][data-focused]:not([hidden])");
    return visible(pane) ? pane : visible(main) ? main : null;
  }
  if (kind === "focus") {
    const active = doc.activeElement;
    // Only a real destination: never the page body or the KalVoice widget itself.
    if (visible(active) && active !== doc.body && !active.closest("[data-kalvoice-widget]")) {
      return active.closest<HTMLElement>("[role='row'], tr, li, article, [role='dialog'], section") ?? active;
    }
    return visible(main) ? main : null;
  }
  const nav = doc.querySelector("nav[aria-label='Primary'] [aria-current='page']");
  if (visible(nav)) return nav;
  return visible(main) ? main : null;
}

const lit = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Lights `el` briefly (the attribute is styled with --glow-active in Visuals.module.css). */
export function lightTarget(el: HTMLElement): void {
  const previous = lit.get(el);
  if (previous) clearTimeout(previous);
  el.setAttribute(VOICE_TARGET_ATTR, "");
  lit.set(
    el,
    setTimeout(() => {
      el.removeAttribute(VOICE_TARGET_ATTR);
      lit.delete(el);
    }, LIGHT_MS),
  );
}

/**
 * Routes the latest voice result to its destination: finds it (allowing it a moment to render),
 * lights it, and asks the KalVoice widget to draw the comet toward it. Safe to call when the
 * destination never appears (nothing happens) or KalVoice's widget isn't shown (no comet).
 */
export function routeVoice(kind: VoiceRouteKind, signal?: AbortSignal): void {
  if (typeof document === "undefined") return;
  let index = 0;
  const attempt = () => {
    // Retries run later: the document can be gone by then (a torn-down window or test env).
    if (signal?.aborted || typeof document === "undefined") return;
    const el = routeDestination(kind);
    // A pane or focus route that can only find the page waits for its real destination first.
    const settled = el && (kind === "surface" || el.id !== "main" || index === FIND_DELAYS.length - 1);
    if (!el || !settled) {
      index += 1;
      const delay = FIND_DELAYS[index];
      if (delay !== undefined) setTimeout(attempt, delay - (FIND_DELAYS[index - 1] ?? 0));
      return;
    }
    lightTarget(el);
    const box = el.getBoundingClientRect();
    window.dispatchEvent(
      new CustomEvent<VoiceRouteDetail>(VOICE_ROUTE_EVENT, {
        detail: { to: { x: box.left, y: box.top, width: box.width, height: box.height } },
      }),
    );
  };
  setTimeout(attempt, FIND_DELAYS[0]);
}

/** Whether decorative motion is off (the app setting, or the OS preference unless forced on). */
export function motionReduced(doc: Document = document): boolean {
  const mode = doc.documentElement.dataset.motion;
  if (mode === "reduced") return true;
  if (mode === "full") return false;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
