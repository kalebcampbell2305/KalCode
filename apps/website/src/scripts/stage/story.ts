/**
 * ScrollStory controller: an IntersectionObserver on the captions sets the current step, and the
 * pinned window moves to that step's scene (animated going forward, settled going back).
 * Stills (phones / reduced motion) get tap-to-play.
 */
import { BASE_SCENE, type Scene, STORY } from "../../data/story";
import { getApp } from "./app";
import { qsa, reducedMotion, watchLogs, whenNear } from "./util";

function cumulative(index: number): Scene {
  const scene: Scene = { ...BASE_SCENE };
  for (const step of STORY.slice(0, index + 1)) Object.assign(scene, step.scene);
  return scene;
}

function wire(story: HTMLElement): void {
  story.dataset.kcWired = "true";
  const steps = qsa(story, "[data-kc-step]");
  const root = story.querySelector<HTMLElement>(".kc-story__stage [data-kc-app]");
  let current = 0;
  watchLogs(story);

  const go = (index: number) => {
    if (!root || index === current) return;
    const step = STORY[index];
    if (!step) return;
    const app = getApp(root);
    const forward = index === current + 1;
    for (const el of steps) {
      if (Number(el.dataset.kcStep) === index) el.dataset.active = "true";
      else el.removeAttribute("data-active");
    }
    story.dataset.step = String(index);
    root.setAttribute("aria-label", `Preview: ${step.describe}`);
    app.apply(cumulative(index), { animate: forward, play: forward ? step.play : undefined });
    current = index;
  };

  if (root && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (hit) go(Number((hit.target as HTMLElement).dataset.kcStep ?? 0));
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    for (const el of steps) io.observe(el);
  }

  // Stills: Play replays that step's micro-animation once.
  story.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-kc-replay]");
    if (!btn || reducedMotion()) return;
    const figure = btn.parentElement?.querySelector<HTMLElement>("[data-kc-still]");
    if (!figure) return;
    const app = getApp(figure);
    const kind = btn.dataset.kcReplay;
    if (kind === "approval") app.apply({ approval: "pending" }, { animate: true, play: "approve" });
    else if (kind === "voice") app.apply({}, { animate: true, play: "dictate" });
    else if (kind === "mission") app.apply({ mission: 0 }, { animate: true, play: "mission" });
    else app.replay();
  });
}

for (const story of qsa(document, "[data-kc-story]")) whenNear(story, () => wire(story), "200px");
