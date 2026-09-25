/** ProviderSwitch: tabs ↔ scroll-snap strip, kept in sync both ways. */
import { announce, qsa, reducedMotion, roving, watchLogs, whenNear } from "./util";

function wire(block: HTMLElement): void {
  block.dataset.kcWired = "true";
  const tabs = qsa(block, "[data-kc-ps-tab]");
  const panels = qsa(block, "[data-kc-ps-panel]");
  const strip = block.querySelector<HTMLElement>("[data-kc-ps-strip]");
  const live = block.querySelector("[data-kc-ps-live]");
  if (!strip || !tabs.length) return;
  watchLogs(block);
  let current = tabs[0]?.dataset.kcPsTab ?? "claude";
  let fromTab = false;

  const select = (key: string, scroll: boolean) => {
    current = key;
    for (const tab of tabs) {
      const on = tab.dataset.kcPsTab === key;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
    }
    for (const panel of panels) {
      panel.inert = panel.dataset.kcPsPanel !== key;
      panel.tabIndex = panel.inert ? -1 : 0;
    }
    if (scroll) {
      const panel = panels.find((p) => p.dataset.kcPsPanel === key);
      if (panel) {
        fromTab = true;
        strip.scrollTo({ left: panel.offsetLeft - strip.offsetLeft, behavior: reducedMotion() ? "auto" : "smooth" });
        window.setTimeout(() => {
          fromTab = false;
        }, 600);
      }
    }
    const name = tabs.find((t) => t.dataset.kcPsTab === key)?.textContent?.trim() ?? key;
    announce(live, `${name} pane shown.`);
  };

  block.addEventListener("click", (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>("[data-kc-ps-tab]");
    if (tab?.dataset.kcPsTab) select(tab.dataset.kcPsTab, true);
  });
  const tablist = block.querySelector<HTMLElement>("[role='tablist']");
  if (tablist) roving(tablist, "[data-kc-ps-tab]", { select: (el) => select(el.dataset.kcPsTab ?? "claude", true) });

  const io = new IntersectionObserver(
    (entries) => {
      if (fromTab) return;
      for (const e of entries) {
        const key = (e.target as HTMLElement).dataset.kcPsPanel;
        if (e.isIntersecting && key && key !== current) select(key, false);
      }
    },
    { root: strip, threshold: 0.6 },
  );
  for (const panel of panels) io.observe(panel);
}

for (const block of qsa(document, "[data-kc-ps]")) whenNear(block, () => wire(block));
