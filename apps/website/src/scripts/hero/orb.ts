/**
 * Hero orb controller. The markup already shows a finished still (poster + CSS stream); this
 * module upgrades it to the WebGL renderer when the orb is near the viewport and the browser is
 * idle, and owns the lifecycle:
 *   - runs only while intersecting and the tab is visible (IntersectionObserver, visibilitychange)
 *   - prefers-reduced-motion (or html[data-motion="reduced"]): one composed still, no loop
 *   - WebGL unavailable or failing: `.is-css` (the stylesheet's slow CSS surge) instead
 *   - lite variant on small or touch screens: lower resolution, no motes, no pointer parallax
 *   - frame-time watchdog steps quality down if a device cannot hold ~45 fps
 * Nothing is exposed globally.
 */
import type { OrbRenderer } from "./renderer";

const SLOW_FRAME = 1 / 45;

function idle(callback: () => void): void {
  if ("requestIdleCallback" in window) window.requestIdleCallback(callback, { timeout: 1200 });
  else setTimeout(callback, 200);
}

function setup(root: HTMLElement): void {
  const stage = root.querySelector<HTMLElement>("[data-hero-orb-stage]");
  const poster = root.querySelector<HTMLImageElement>("img");
  if (!stage || !poster) return;

  const html = document.documentElement;
  const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const lite = window.matchMedia("(max-width: 760px), (pointer: coarse)").matches;
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches && !lite;
  const reduced = () => reduceQuery.matches || html.dataset.motion === "reduced";

  let renderer: OrbRenderer | null = null;
  let pending: Promise<OrbRenderer | null> | null = null;
  let visible = false;
  let raf = 0;
  let last = 0;
  let top = 0;
  let height = 1;
  // Watchdog state: time-based windows so very slow devices are caught quickly.
  let windowStart = 0;
  let windowFrames = 0;
  let calmWindows = 0;
  let gaveUp = false;

  const ink = () => (html.dataset.theme === "light" ? 1 : 0);

  function measure(): void {
    const rect = root.getBoundingClientRect();
    top = rect.top + window.scrollY;
    height = Math.max(1, rect.height);
    renderer?.resize();
  }

  function load(): Promise<OrbRenderer | null> {
    pending ??= import("./renderer")
      .then(({ createOrb }) => createOrb(root, stage as HTMLElement, poster as HTMLImageElement, { lite }))
      .then((created) => {
        renderer = created;
        created.setInk(ink());
        measure();
        return created;
      })
      .catch(() => {
        root.classList.add("is-css");
        return null;
      });
    return pending;
  }

  function stop(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function tick(now: number): void {
    raf = requestAnimationFrame(tick);
    const current = renderer;
    if (!current) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    current.setScroll((window.scrollY - top) / height);
    current.frame(dt);
    if (!root.classList.contains("is-live")) root.classList.add("is-live");

    // Watchdog: 1.5 s windows; step down while the average frame is slower than ~45 fps. At
    // the floor and still slow (software rendering), give up and keep the CSS version instead.
    if (calmWindows < 3) {
      if (!windowStart) windowStart = now;
      windowFrames += 1;
      if (now - windowStart > 1500) {
        const slow = (now - windowStart) / 1000 / windowFrames > SLOW_FRAME;
        windowStart = now;
        windowFrames = 0;
        if (!slow) calmWindows += 1;
        else if (!current.degrade()) fallBack();
        else calmWindows = 0;
      }
    }
  }

  function fallBack(): void {
    gaveUp = true;
    stop();
    renderer?.destroy();
    renderer = null;
    pending = Promise.resolve(null);
    root.classList.remove("is-live");
    root.classList.add("is-css");
  }

  function still(): void {
    renderer?.still();
    root.classList.add("is-live");
  }

  function update(): void {
    root.classList.toggle("is-paused", !visible || document.hidden);
    if (!visible || document.hidden) {
      stop();
      return;
    }
    void load().then((current) => {
      if (!current || !visible || document.hidden) return;
      if (reduced()) {
        stop();
        still();
      } else if (!raf) {
        last = 0;
        windowStart = 0;
        windowFrames = 0;
        raf = requestAnimationFrame(tick);
      }
    });
  }

  new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      update();
    },
    { rootMargin: "120px 0px" },
  ).observe(root);

  new ResizeObserver(() => {
    measure();
    if (reduced() && renderer) still();
  }).observe(root);

  new MutationObserver(() => {
    renderer?.setInk(ink());
    if (reduced() && renderer) still();
  }).observe(html, { attributes: true, attributeFilter: ["data-theme", "data-motion"] });

  document.addEventListener("visibilitychange", update);
  reduceQuery.addEventListener("change", update);

  if (finePointer) {
    window.addEventListener(
      "pointermove",
      (event) => {
        if (!renderer || reduced()) return;
        renderer.setPointer((event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1);
      },
      { passive: true },
    );
  }

  // Context loss (GPU reset, too many contexts): fall back to the still, rebuild when restored.
  root.addEventListener(
    "webglcontextlost",
    (event) => {
      if (gaveUp) return;
      event.preventDefault();
      stop();
      root.classList.remove("is-live");
      renderer?.destroy();
      renderer = null;
      pending = null;
      setTimeout(update, 1000);
    },
    true,
  );
}

idle(() => {
  for (const root of document.querySelectorAll<HTMLElement>("[data-hero-orb]")) setup(root);
});
