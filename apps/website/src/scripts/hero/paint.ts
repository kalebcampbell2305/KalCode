/**
 * Resolves once the page's first contentful paint has happened (plus one frame), so decorative
 * images and heavy work start only after the hero's LCP image is on screen.
 */
let pending: Promise<void> | null = null;

export function afterFirstPaint(): Promise<void> {
  pending ??= new Promise<void>((resolve) => {
    const done = () => requestAnimationFrame(() => resolve());
    if (performance.getEntriesByName("first-contentful-paint").length > 0) return done();
    let settled = false;
    const once = () => {
      if (settled) return;
      settled = true;
      done();
    };
    try {
      const observer = new PerformanceObserver(() => {
        observer.disconnect();
        once();
      });
      observer.observe({ type: "paint", buffered: true });
    } catch {
      window.addEventListener("load", once, { once: true });
    }
    setTimeout(once, 3000);
  });
  return pending;
}
