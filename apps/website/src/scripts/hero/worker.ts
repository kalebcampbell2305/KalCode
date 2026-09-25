/**
 * Hero orb worker: renders on an OffscreenCanvas transferred from the page, with its own frame
 * loop, so the animation adds no work to the main thread (no per-frame style, layout, pre-paint
 * or intersection passes on the page).
 *
 * Messages in:  init {canvas, base, lite, layout, ink} · layout · run {on, still} · pointer ·
 *               scroll · ink
 * Messages out: live (first frame drawn) · fallback {reason: "init" | "slow"}
 */
import { createLoop, createOrb, type Layout, type Loop, type OrbRenderer } from "./renderer";

export type ToWorker =
  | { t: "init"; canvas: OffscreenCanvas; base: string; lite: boolean; layout: Layout; ink: number }
  | { t: "layout"; layout: Layout }
  | { t: "run"; on: boolean; still: boolean }
  | { t: "pointer"; x: number; y: number }
  | { t: "scroll"; v: number }
  | { t: "ink"; v: number };

export type FromWorker = { t: "live" } | { t: "fallback"; reason: "init" | "slow" };

const post = (message: FromWorker) => (self as unknown as Worker).postMessage(message);

let orb: OrbRenderer | null = null;
let loop: Loop | null = null;
let run: { on: boolean; still: boolean } = { on: false, still: false };

function applyRun() {
  if (!loop) return;
  if (!run.on) loop.stop();
  else if (run.still) loop.still();
  else loop.start();
}

self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  switch (msg.t) {
    case "init":
      createOrb(msg.canvas, msg.base, { lite: msg.lite })
        .then((created) => {
          orb = created;
          created.layout(msg.layout);
          created.setInk(msg.ink);
          loop = createLoop(created, {
            live: () => post({ t: "live" }),
            fallback: () => {
              created.destroy();
              post({ t: "fallback", reason: "slow" });
            },
          });
          applyRun();
        })
        .catch(() => post({ t: "fallback", reason: "init" }));
      break;
    case "layout":
      orb?.layout(msg.layout);
      if (run.on && run.still) loop?.still();
      break;
    case "run":
      run = { on: msg.on, still: msg.still };
      applyRun();
      break;
    case "pointer":
      orb?.setPointer(msg.x, msg.y);
      break;
    case "scroll":
      orb?.setScroll(msg.v);
      break;
    case "ink":
      orb?.setInk(msg.v);
      if (run.on && run.still) loop?.still();
      break;
  }
});
