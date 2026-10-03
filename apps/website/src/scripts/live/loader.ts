/**
 * Loads the live demo on demand. The page ships only this file up front; the demo itself
 * (scripts/live/app.ts) loads when the demo comes near the viewport, or immediately when any
 * `[data-live-do]` control on the page is used ("Try KalCode", "Take the tour", "Try it in the
 * demo"). Those controls scroll to the demo and run their action there.
 */
import type { LiveDemo } from "./app";

const root = document.querySelector<HTMLElement>("[data-live]");
let demo: Promise<LiveDemo> | null = null;

function load(): Promise<LiveDemo> {
  if (!root) return Promise.reject(new Error("no demo"));
  demo ??= import("./app").then((m) => m.mountLiveDemo(root));
  return demo;
}

if (root) {
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          void load();
        }
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(root);
  } else {
    void load();
  }

  document.addEventListener("click", (event) => {
    const trigger = (event.target as HTMLElement).closest<HTMLElement>("[data-live-do]");
    if (!trigger) return;
    event.preventDefault();
    // A Try link keeps its shareable address (#try) without the browser's jump.
    const href = trigger.getAttribute("href");
    if (href?.startsWith("#")) history.replaceState(null, "", href);
    const action = trigger.dataset.liveDo ?? "";
    const inside = root.contains(trigger);
    if (!inside) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      root.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }
    void load().then((d) => {
      // Let the scroll settle so the tour's spotlight measures the final position.
      window.setTimeout(
        () => {
          if (action === "reset") d.reset();
          else if (action) d.run(action);
          // Keyboard and screen-reader users land in the demo, unless the action focused something in it.
          if (!inside && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
        },
        inside ? 0 : 450,
      );
    });
  });
}
