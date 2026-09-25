/**
 * WorkspaceStage: assemble on entry (window opens, panes rise in turn and stream), then link the
 * Threads panel, the chips under the window and the terminals on hover and focus.
 */
import { getApp } from "./app";
import { announce, qsa, reducedMotion, whenNear } from "./util";

function wire(block: HTMLElement): void {
  block.dataset.kcWired = "true";
  const frame = block.querySelector<HTMLElement>("[data-kc-app]");
  if (!frame) return;
  const app = getApp(frame);
  const chips = qsa(block, "[data-kc-ws-thread]");
  let pinned: string | null = null;

  const light = (id: string | null) => {
    const t = id ?? pinned;
    if (t) block.dataset.lit = t;
    else block.removeAttribute("data-lit");
    for (const el of qsa(block, ".kc-pane[data-thread], .kc-ws__thread, [data-kc-ws-thread]")) {
      const key = el.dataset.thread ?? el.dataset.kcWsThread;
      if (key === t) el.setAttribute("data-lit", "");
      else el.removeAttribute("data-lit");
    }
  };

  block.addEventListener("pointerover", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(
      ".kc-ws__thread, [data-kc-ws-thread], .kc-pane[data-thread]",
    );
    light(el?.dataset.thread ?? el?.dataset.kcWsThread ?? null);
  });
  block.addEventListener("pointerleave", () => light(null));
  block.addEventListener("focusin", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-kc-ws-thread]");
    if (chip) light(chip.dataset.kcWsThread ?? null);
  });
  block.addEventListener("focusout", (e) => {
    if (!block.contains(e.relatedTarget as Node | null)) light(null);
  });
  block.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-kc-ws-thread]");
    if (!chip) return;
    const id = chip.dataset.kcWsThread ?? null;
    pinned = pinned === id ? null : id;
    for (const c of chips) c.setAttribute("aria-pressed", c.dataset.kcWsThread === pinned ? "true" : "false");
    light(null);
    announce(
      block.querySelector("[data-kc-ws-live]"),
      pinned ? `${chip.textContent?.trim()}: terminal highlighted.` : "Highlight cleared.",
    );
  });

  if (reducedMotion()) return;
  block.dataset.phase = "ready";
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      block.dataset.phase = "assembling";
      qsa(frame, ".kc-pane").forEach((pane, n) => {
        pane.style.animationDelay = `${260 + n * 140}ms`;
        pane.setAttribute("data-assemble", "");
        window.setTimeout(() => app.reveal(pane), 360 + n * 140);
      });
      window.setTimeout(() => {
        block.dataset.phase = "live";
        for (const p of qsa(frame, ".kc-pane")) {
          p.removeAttribute("data-assemble");
          p.style.removeProperty("animation-delay");
        }
      }, 2400);
    },
    { threshold: 0.35 },
  );
  io.observe(frame);
}

for (const block of qsa(document, "[data-kc-ws]")) whenNear(block, () => wire(block));
