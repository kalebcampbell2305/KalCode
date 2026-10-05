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

/**
 * Scrolls the demo into place and resolves once the page has stopped there. A smooth scroll takes
 * as long as the machine needs (a busy one drops frames), so this waits for `scrollend` rather
 * than a fixed delay; a page already at the demo resolves at once. Browsers without `scrollend`
 * fall back to the typical smooth-scroll time; a capped wait covers a scroll that never reports.
 */
function scrollToDemo(demo: HTMLElement): Promise<void> {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const margin = Number.parseFloat(getComputedStyle(demo).scrollMarginTop) || 0;
  const limit = document.documentElement.scrollHeight - window.innerHeight;
  const destination = Math.min(Math.max(0, window.scrollY + demo.getBoundingClientRect().top - margin), limit);
  const moves = Math.abs(destination - window.scrollY) >= 1;
  return new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      window.clearTimeout(timer);
      document.removeEventListener("scrollend", done);
      resolve();
    };
    if (moves) {
      document.addEventListener("scrollend", done);
      timer = window.setTimeout(done, "onscrollend" in window ? 3000 : 450);
    }
    demo.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    if (!moves) done();
  });
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
    // An in-demo control acts once its own click has finished; a page control once the scroll arrives.
    const arrived = inside ? new Promise<void>((resolve) => window.setTimeout(resolve, 0)) : scrollToDemo(root);
    void Promise.all([load(), arrived]).then(([d]) => {
      // The scroll has settled, so the tour's spotlight measures the final position.
      if (action === "reset") d.reset();
      else if (action) d.run(action);
      // Keyboard and screen-reader users land in the demo, unless the action focused something in it.
      if (!inside && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
    });
  });
}
