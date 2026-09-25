/** BeforeAfter: radio switch, plus a one-time automatic change when the section is well in view. */
import { announce, qsa, reducedMotion, roving, whenNear } from "./util";

function wire(block: HTMLElement): void {
  block.dataset.kcWired = "true";
  const radios = qsa(block, "[data-kc-ba-set]");
  const stage = block.querySelector<HTMLElement>("[data-kc-ba-stage]");
  const live = block.querySelector("[data-kc-ba-live]");
  let touched = false;

  const set = (state: "before" | "after", fromUser: boolean) => {
    if (fromUser) touched = true;
    block.dataset.state = state;
    for (const r of radios) {
      const on = r.dataset.kcBaSet === state;
      r.setAttribute("aria-checked", on ? "true" : "false");
      r.tabIndex = on ? 0 : -1;
    }
    const text = state === "before" ? stage?.dataset.before : stage?.dataset.after;
    if (stage && text) stage.setAttribute("aria-label", text);
    if (fromUser && text) announce(live, text);
  };

  block.addEventListener("click", (event) => {
    const r = (event.target as HTMLElement).closest<HTMLElement>("[data-kc-ba-set]");
    if (r) set(r.dataset.kcBaSet === "after" ? "after" : "before", true);
  });
  const group = block.querySelector<HTMLElement>("[role='radiogroup']");
  if (group)
    roving(group, "[data-kc-ba-set]", {
      select: (el) => set(el.dataset.kcBaSet === "after" ? "after" : "before", true),
    });

  // Scroll: once the stage is mostly on screen, fold the windows into the workspace.
  if (stage && block.dataset.state === "before" && !reducedMotion()) {
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        window.setTimeout(() => {
          if (!touched) set("after", false);
        }, 1400);
      },
      { threshold: 0.7 },
    );
    io.observe(stage);
  }
}

for (const block of qsa(document, "[data-kc-ba]")) whenNear(block, () => wire(block));
