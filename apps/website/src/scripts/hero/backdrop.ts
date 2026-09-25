/**
 * SpaceBackdrop: one shared observer marks each backdrop `is-in` the first time it nears the
 * viewport, so its light settles in once (a CSS transition). Nothing runs after that.
 */
const backdrops = document.querySelectorAll<HTMLElement>("[data-space-backdrop]:not(.is-in)");

if (backdrops.length > 0) {
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -15% 0px" },
    );
    for (const el of backdrops) observer.observe(el);
  } else {
    for (const el of backdrops) el.classList.add("is-in");
  }
}
