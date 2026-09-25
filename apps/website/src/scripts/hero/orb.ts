/**
 * Hero orb controller. The markup already paints a finished still (poster + CSS stream); this
 * module upgrades it to WebGL only after the page has loaded and first paint (the LCP poster)
 * has happened, so it never competes with loading or adds long tasks.
 *
 * Tier is decided up front from device hints (no probing):
 *   css   Save-Data, <= 2 cores or <= 2 GB: the CSS still with its slow surge
 *   lite  phones / touch / <= 4 cores / <= 4 GB: lower resolution, no motes, no parallax
 *   full  everything else
 * Rendering runs in a worker on an OffscreenCanvas where supported (zero per-frame main-thread
 * work). Without OffscreenCanvas WebGL, the full tier renders on the main thread and the lite
 * tier keeps the CSS version. Runs only while intersecting and the tab is visible; reduced
 * motion gets one WebGL still (full tier) or the CSS still. Nothing is exposed globally.
 */
import { SPHERE_X } from "./meta";
import type { Layout } from "./renderer";
import type { FromWorker, ToWorker } from "./worker";

type Tier = "full" | "lite" | "css";

interface DeviceHints {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
}

/** A renderer running somewhere (worker or main thread), driven by messages. */
interface Driver {
  send(message: Exclude<ToWorker, { t: "init" }>): void;
  destroy(): void;
}

function pickTier(): Tier {
  const nav = navigator as Navigator & DeviceHints;
  const cores = nav.hardwareConcurrency || 4;
  const memory = nav.deviceMemory ?? 8;
  if (nav.connection?.saveData || cores <= 2 || memory <= 2) return "css";
  const small = window.matchMedia("(max-width: 760px), (pointer: coarse)").matches;
  return small || cores <= 4 || memory <= 4 ? "lite" : "full";
}

const offscreenSupported = () =>
  typeof OffscreenCanvas !== "undefined" && "transferControlToOffscreen" in HTMLCanvasElement.prototype;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** After `load`, after first contentful paint (the poster), and when the main thread is idle. */
async function whenQuiet(): Promise<void> {
  if (document.readyState !== "complete") {
    await new Promise<void>((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
  }
  await new Promise<void>((resolve) => {
    if (performance.getEntriesByName("first-contentful-paint").length > 0) return resolve();
    try {
      const observer = new PerformanceObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe({ type: "paint", buffered: true });
    } catch {
      resolve();
    }
    setTimeout(resolve, 3000);
  });
  await nextFrame();
  await nextFrame();
  await new Promise<void>((resolve) => {
    if ("requestIdleCallback" in window) window.requestIdleCallback(() => resolve(), { timeout: 2500 });
    else setTimeout(resolve, 600);
  });
}

function setup(root: HTMLElement): void {
  const stage = root.querySelector<HTMLElement>("[data-hero-orb-stage]");
  const frame = stage?.parentElement;
  const poster = root.querySelector<HTMLImageElement>(".hero-orb__poster");
  if (!stage || !frame || !poster) return;

  const html = document.documentElement;
  const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reduced = () => reduceQuery.matches || html.dataset.motion === "reduced";
  const tier = pickTier();
  const lite = tier === "lite";
  const worker = offscreenSupported();
  // Lite devices only animate off the main thread; without a worker they keep the CSS version.
  const enabled = tier === "full" || (tier === "lite" && worker);
  const finePointer = !lite && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  if (!enabled) root.classList.add("is-css");

  let driver: Driver | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let layout: Layout | null = null;
  let visible = false;
  let ready = false;
  let gaveUp = !enabled;
  let started = false;
  let top = 0;
  let height = 1;

  const ink = () => ((root.closest<HTMLElement>("[data-theme]")?.dataset.theme ?? "dark") === "light" ? 1 : 0);

  const originEl = root.querySelector<HTMLElement>("[data-hero-orb-origin]");
  const worldEl = root.querySelector<HTMLElement>("[data-hero-orb-world]");

  function measure(): Layout | null {
    if (!canvas || !stage || !frame) return null;
    const cr = canvas.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    if (cr.width < 1 || cr.height < 1) return null;
    // The stream starts at the platform's ring centre (centered layout) or the frame's bottom.
    const fr = frame.getBoundingClientRect();
    const or = originEl?.getBoundingClientRect();
    const originX = or ? or.left - cr.left : sr.left + sr.width * SPHERE_X - cr.left;
    const originY = or ? or.top - cr.top : fr.bottom - cr.top;
    // Outer ring radius: 645 of the plate's 941 source rows (same scale in both crops).
    const platformRadius = worldEl ? worldEl.getBoundingClientRect().height * (645 / 941) : 0;
    const cs = getComputedStyle(frame);
    const num = (name: string, fallback: number) => {
      const v = Number.parseFloat(cs.getPropertyValue(name));
      return Number.isFinite(v) ? v : fallback;
    };
    const level = num("--hero-beam-safe-level", 1);
    const resume = num("--hero-beam-safe-resume", 1);
    let band: Layout["band"] = null;
    if (level < 1 || resume < 1) {
      band = [
        fr.top + num("--hero-beam-safe-top", 0) - cr.top,
        originY - num("--hero-beam-safe-inset", 0),
        level,
        resume,
      ];
    }
    return {
      width: cr.width,
      height: cr.height,
      dpr: window.devicePixelRatio || 1,
      stageX: sr.left - cr.left,
      stageY: sr.top - cr.top,
      stageSize: sr.width,
      band,
      originX,
      originY,
      platformRadius,
    };
  }

  function fallBack(): void {
    gaveUp = true;
    driver?.destroy();
    driver = null;
    canvas?.remove();
    canvas = null;
    root.classList.remove("is-live");
    root.classList.add("is-css");
  }

  function live(): void {
    root.classList.add("is-live");
  }

  function workerDriver(target: HTMLCanvasElement, first: Layout): Driver {
    const offscreen = target.transferControlToOffscreen();
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.addEventListener("message", (event: MessageEvent<FromWorker>) => {
      if (event.data.t === "live") live();
      else if (event.data.reason === "init" && tier === "full") {
        // No WebGL in workers here (older engines): render on the main thread instead.
        driver?.destroy();
        driver = null;
        target.remove();
        void mainDriver().then((d) => {
          driver = d;
          if (d) update();
        });
      } else fallBack();
    });
    w.addEventListener("error", () => fallBack());
    const init: ToWorker = {
      t: "init",
      canvas: offscreen,
      base: poster?.currentSrc || poster?.src || "",
      lite,
      layout: first,
      ink: ink(),
    };
    w.postMessage(init, [offscreen]);
    return { send: (message) => w.postMessage(message), destroy: () => w.terminate() };
  }

  async function mainDriver(): Promise<Driver | null> {
    const target = makeCanvas();
    const first = await firstLayout();
    if (!first) return null;
    try {
      const { createOrb, createLoop } = await import("./renderer");
      const orb = await createOrb(target, poster?.currentSrc || poster?.src || "", { lite });
      orb.layout(first);
      orb.setInk(ink());
      const loop = createLoop(orb, { live, fallback: fallBack });
      const handle = (m: Exclude<ToWorker, { t: "init" }>) => {
        if (m.t === "layout") orb.layout(m.layout);
        else if (m.t === "pointer") orb.setPointer(m.x, m.y);
        else if (m.t === "scroll") orb.setScroll(m.v);
        else if (m.t === "ink") orb.setInk(m.v);
        else if (!m.on) loop.stop();
        else if (m.still) loop.still();
        else loop.start();
        if ((m.t === "layout" || m.t === "ink") && reduced()) loop.still();
      };
      return {
        send: handle,
        destroy: () => {
          loop.stop();
          orb.destroy();
        },
      };
    } catch {
      fallBack();
      return null;
    }
  }

  function makeCanvas(): HTMLCanvasElement {
    const el = document.createElement("canvas");
    el.className = "hero-orb__canvas";
    frame?.appendChild(el);
    canvas = el;
    return el;
  }

  /** Waits for the canvas's first layout via ResizeObserver (no forced synchronous layout). */
  function firstLayout(): Promise<Layout | null> {
    return new Promise((resolve) => {
      const ro = new ResizeObserver(() => {
        ro.disconnect();
        layout = measure();
        resolve(layout);
      });
      if (canvas) ro.observe(canvas);
      else resolve(null);
    });
  }

  async function start(): Promise<void> {
    started = true;
    if (worker) {
      const target = makeCanvas();
      const first = await firstLayout();
      if (!first || gaveUp) return;
      driver = workerDriver(target, first);
    } else {
      driver = await mainDriver();
    }
    update();

    // Later size changes: layout is clean inside ResizeObserver callbacks.
    new ResizeObserver(() => {
      const rect = root.getBoundingClientRect();
      top = rect.top + window.scrollY;
      height = Math.max(1, rect.height);
      const next = measure();
      if (next) driver?.send({ t: "layout", layout: next });
    }).observe(root);
  }

  function update(): void {
    root.classList.toggle("is-paused", !visible || document.hidden);
    if (!ready || gaveUp) return;
    const on = visible && !document.hidden && (!reduced() || tier === "full");
    if (!started) {
      // Nothing is created until it would actually be shown.
      if (on) void start();
      return;
    }
    driver?.send({ t: "run", on, still: reduced() });
  }

  new IntersectionObserver(
    (entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      visible = entry.isIntersecting;
      // The observer computes this rect itself: no forced layout.
      top = entry.boundingClientRect.top + window.scrollY;
      height = Math.max(1, entry.boundingClientRect.height);
      update();
    },
    { rootMargin: "120px 0px" },
  ).observe(root);

  document.addEventListener("visibilitychange", update);
  reduceQuery.addEventListener("change", update);

  if (!enabled) return;

  void whenQuiet().then(() => {
    ready = true;
    update();

    window.addEventListener(
      "scroll",
      () => {
        if (visible) driver?.send({ t: "scroll", v: (window.scrollY - top) / height });
      },
      { passive: true },
    );

    new MutationObserver(() => driver?.send({ t: "ink", v: ink() })).observe(html, {
      attributes: true,
      attributeFilter: ["data-theme", "data-motion"],
    });

    if (finePointer) {
      window.addEventListener(
        "pointermove",
        (event) => {
          if (!visible || reduced()) return;
          driver?.send({
            t: "pointer",
            x: (event.clientX / window.innerWidth) * 2 - 1,
            y: (event.clientY / window.innerHeight) * 2 - 1,
          });
        },
        { passive: true },
      );
    }

    // Context loss (GPU reset) on the main-thread path: back to the CSS version.
    root.addEventListener(
      "webglcontextlost",
      (event) => {
        if (gaveUp) return;
        event.preventDefault();
        fallBack();
      },
      true,
    );
  });
}

for (const root of document.querySelectorAll<HTMLElement>("[data-hero-orb]")) setup(root);
