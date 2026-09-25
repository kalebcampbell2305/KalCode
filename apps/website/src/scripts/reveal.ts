/**
 * One-shot reveals: elements marked [data-reveal] get [data-revealed] the first time they come
 * near the viewport, and CSS (styles/world.css) eases them in. Nothing loops; with reduced motion
 * the CSS shows everything at once, and without JS nothing is hidden in the first place.
 */
const targets = document.querySelectorAll<HTMLElement>("[data-reveal]");

if (targets.length > 0) {
  if (!("IntersectionObserver" in window)) {
    for (const target of targets) target.setAttribute("data-revealed", "");
  } else {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-revealed", "");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.01 },
    );
    for (const target of targets) observer.observe(target);
  }
}
