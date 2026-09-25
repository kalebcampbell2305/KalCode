/**
 * The hero orb poster as the home page lays it out (site.css): stacked below 1024 px, the split
 * hero's orb column above. Shared by HeroOrbSlot (the <img> sizes) and the head preload, so the
 * browser fetches the one file the layout will use as early as possible (it is the LCP image).
 */
export const HERO_POSTER_SIZES = "(max-width: 1023px) min(88vw, 25rem, 40vh), min(32rem, 58vh)";

/** Widths published by the hero work in public/assets/hero (orb-<width>.avif). */
export const HERO_POSTER_WIDTHS = [384, 512, 640, 768, 1024] as const;

export const HERO_POSTER_SRCSET = HERO_POSTER_WIDTHS.map((width) => `/assets/hero/orb-${width}.avif ${width}w`).join(
  ", ",
);
