import { useEffect, useState } from "react";

type Listener = () => void;
const listeners = new Set<Listener>();
let observer: MutationObserver | null = null;

export function blockingBrowserOverlayOpen(): boolean {
  if (typeof document === "undefined") return false;
  const selectors = [
    '[role="dialog"]:not([hidden])',
    '[role="alertdialog"]:not([hidden])',
    '[role="menu"][data-state="open"]',
    '[role="listbox"][data-state="open"]',
    '[data-radix-dialog-content][data-state="open"]',
    '[data-radix-alert-dialog-content][data-state="open"]',
  ];
  return [...document.querySelectorAll(selectors.join(","))].some(
    (overlay) => !overlay.closest('[hidden], [aria-hidden="true"], [inert]'),
  );
}

function changed() {
  for (const listener of listeners) listener();
}

/** Position-only pane moves do not trigger ResizeObserver; share the existing DOM observer. */
export function subscribeBrowserLayout(listener: Listener): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    stop();
  };
}

function start() {
  if (observer || typeof document === "undefined") return;
  observer = new MutationObserver(changed);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["hidden", "aria-hidden", "data-state", "role", "style", "class"],
  });
  document.addEventListener("visibilitychange", changed);
  document.addEventListener("scroll", changed, true);
}

function stop() {
  if (!observer || listeners.size > 0 || typeof document === "undefined") return;
  observer.disconnect();
  observer = null;
  document.removeEventListener("visibilitychange", changed);
  document.removeEventListener("scroll", changed, true);
}

/** Shared modal/document visibility signal so native WebView2 never paints over trusted chrome. */
export function useBrowserVisibility(host: HTMLElement | null, routeVisible: boolean): boolean {
  const [visible, setVisible] = useState(() => browserSurfaceVisible(host, routeVisible));
  useEffect(() => {
    const update = () => setVisible(browserSurfaceVisible(host, routeVisible));
    listeners.add(update);
    start();
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      listeners.delete(update);
      stop();
    };
  }, [host, routeVisible]);
  return visible;
}

export function browserSurfaceVisible(host: HTMLElement | null, routeVisible: boolean): boolean {
  if (!routeVisible || !host?.isConnected || document.visibilityState !== "visible" || blockingBrowserOverlayOpen()) {
    return false;
  }
  const rect = host.getBoundingClientRect();
  // Native child windows are not clipped by CSS overflow. Hide a partly scrolled child
  // until its viewport fits again, so it cannot cover the workspace toolbar or side rail.
  const canvas = host.closest("[data-pane-canvas]")?.getBoundingClientRect();
  if (
    canvas &&
    (rect.left < canvas.left || rect.top < canvas.top || rect.right > canvas.right || rect.bottom > canvas.bottom)
  )
    return false;
  return (
    rect.width > 1 &&
    rect.height > 1 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < innerHeight &&
    rect.left < innerWidth
  );
}
