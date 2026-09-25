/**
 * SpaceBackdrop loader. After the page's first paint (so nothing competes with the hero's LCP
 * image), one observer marks a backdrop `is-near` when it comes within about a viewport, which
 * applies its CSS background images; a second marks it `is-in` when it enters, so its light
 * settles in once. Nothing runs after that.
 */
import { afterFirstPaint } from "./paint";

const backdrops = Array.from(document.querySelectorAll<HTMLElement>("[data-space-backdrop]:not(.is-in)"));

function reveal(el: Element): void {
  el.classList.add("is-near", "is-in");
}

if (backdrops.length > 0) {
  void afterFirstPaint().then(() => {
    if (!("IntersectionObserver" in window)) {
      for (const el of backdrops) reveal(el);
      return;
    }
    const near = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-near");
          near.unobserve(entry.target);
        }
      },
      { rootMargin: "100% 0px 100% 0px" },
    );
    const inView = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          reveal(entry.target);
          inView.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -15% 0px" },
    );
    for (const el of backdrops) {
      near.observe(el);
      inView.observe(el);
    }
  });
}
