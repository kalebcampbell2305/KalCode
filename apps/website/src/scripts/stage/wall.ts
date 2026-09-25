/**
 * MultiAgentWall: assemble on entry (window mask, panes from depth in a diagonal stagger, streams,
 * light along the stripes), then link provider chips and panes on hover and focus.
 */
import { PROVIDERS, type ProviderId } from "../../data/story";
import { getApp, initAutoApps } from "./app";
import { announce, qsa, reducedMotion, whenNear } from "./util";

function wire(block: HTMLElement): void {
  block.dataset.kcWired = "true";
  const root = block.querySelector<HTMLElement>("[data-kc-app]");
  const live = block.querySelector("[data-kc-maw-live]");
  if (!root) return;
  const chips = qsa(block, "[data-kc-lit]");
  let pinned: string | null = null;

  const light = (provider: string | null) => {
    const p = provider ?? pinned;
    if (p) block.dataset.lit = p;
    else block.removeAttribute("data-lit");
    for (const c of chips) {
      if (c.dataset.kcLit === p) c.setAttribute("data-on", "");
      else c.removeAttribute("data-on");
    }
  };

  block.addEventListener("pointerover", (e) => {
    const t = e.target as HTMLElement;
    const chip = t.closest<HTMLElement>("[data-kc-lit]");
    const pane = t.closest<HTMLElement>(".kc-pane[data-provider]");
    light(chip?.dataset.kcLit ?? pane?.dataset.provider ?? null);
  });
  block.addEventListener("pointerleave", () => light(null));
  block.addEventListener("focusin", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-kc-lit]");
    if (chip) light(chip.dataset.kcLit ?? null);
  });
  block.addEventListener("focusout", (e) => {
    if (!block.contains(e.relatedTarget as Node | null)) light(null);
  });
  block.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-kc-lit]");
    if (!chip) return;
    const p = chip.dataset.kcLit ?? null;
    pinned = pinned === p ? null : p;
    for (const c of chips) c.setAttribute("aria-pressed", c.dataset.kcLit === pinned ? "true" : "false");
    light(null);
    const count = qsa(root, `.kc-grid > .kc-pane[data-open='true'][data-provider='${p}']`).length;
    announce(
      live,
      pinned
        ? `${PROVIDERS[p as ProviderId].name}: ${count} ${count === 1 ? "pane" : "panes"} highlighted.`
        : "Highlight cleared.",
    );
  });

  if (reducedMotion()) return;

  // Assemble once, when most of the window is in view.
  block.dataset.phase = "ready";
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      const app = getApp(root);
      block.dataset.phase = "assembling";
      const panes = qsa(root, ".kc-grid > .kc-pane[data-open='true']");
      // Diagonal order across the 3 × 2 grid.
      const order = [0, 1, 3, 2, 4, 5];
      order.forEach((index, n) => {
        const pane = panes[index];
        if (!pane) return;
        pane.style.animationDelay = `${220 + n * 110}ms`;
        pane.setAttribute("data-assemble", "");
        window.setTimeout(() => app.reveal(pane), 320 + n * 110);
      });
      window.setTimeout(() => {
        block.dataset.phase = "live";
        for (const p of panes) {
          p.removeAttribute("data-assemble");
          p.style.removeProperty("animation-delay");
        }
      }, 2600);
    },
    { threshold: 0.35 },
  );
  io.observe(root);
}

initAutoApps();
for (const block of qsa(document, "[data-kc-maw]")) whenNear(block, () => wire(block));
