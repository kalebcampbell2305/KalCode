/** DemoCenter: tabs switch the shared window between scenes and play each scene once. */
import { BASE_SCENE, DEMO_TABS } from "../../data/story";
import { getApp, initAutoApps } from "./app";
import { qsa, roving, whenNear } from "./util";

function wire(block: HTMLElement): void {
  block.dataset.kcWired = "true";
  const tabs = qsa(block, "[data-kc-demo-tab]");
  const panel = block.querySelector<HTMLElement>("[data-kc-demo-panel]");
  const root = block.querySelector<HTMLElement>("[data-kc-app]");
  if (!root || !panel) return;
  let current = tabs[0]?.dataset.kcDemoTab ?? "";
  let played = false;

  const show = (key: string, play: boolean) => {
    const tab = DEMO_TABS.find((t) => t.id === key);
    if (!tab) return;
    current = key;
    for (const t of tabs) {
      const on = t.dataset.kcDemoTab === key;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      if (on) panel.setAttribute("aria-labelledby", t.id);
    }
    for (const copy of qsa(block, "[data-kc-demo-copy]")) copy.hidden = copy.dataset.kcDemoCopy !== key;
    const app = getApp(root);
    app.apply({ ...BASE_SCENE, ...tab.scene }, { animate: play, play: play ? tab.play : undefined });
    app.say(`${tab.label}: ${tab.title}`);
  };

  block.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLElement>("[data-kc-demo-tab]");
    if (tab?.dataset.kcDemoTab) show(tab.dataset.kcDemoTab, true);
    else if (target.closest("[data-kc-demo-replay]")) show(current, true);
  });
  const tablist = block.querySelector<HTMLElement>("[role='tablist']");
  if (tablist) roving(tablist, "[data-kc-demo-tab]", { select: (el) => show(el.dataset.kcDemoTab ?? "", true) });

  // Play the first tab's sequence the first time the window is well in view.
  const io = new IntersectionObserver(
    (entries) => {
      if (played || !entries.some((e) => e.isIntersecting)) return;
      played = true;
      io.disconnect();
      show(current, true);
    },
    { threshold: 0.5 },
  );
  io.observe(root);
}

initAutoApps();
for (const block of qsa(document, "[data-kc-demo]")) whenNear(block, () => wire(block));
