/**
 * Hero image hints shared by the hero slot and the page head.
 *
 * The world plate (hero/world-assets.ts, from the hero work) is the LCP image of the home page:
 * HERO_WORLD_PRELOADS gives one preload per media query, so the browser fetches exactly the file
 * the layout uses as early as possible. HERO_POSTER_SIZES sizes the orb poster when only the orb
 * (no world) is rendered.
 */
import {
  WORLD_LANDSCAPE,
  WORLD_LANDSCAPE_MEDIA,
  WORLD_PORTRAIT,
  WORLD_PORTRAIT_MEDIA,
  WORLD_SIZES,
  worldSrcset,
} from "../components/hero/world-assets";

export const HERO_POSTER_SIZES = "(max-width: 767px) min(94vw, 46vh), min(48vh, 42vw, 672px)";

export const HERO_WORLD_PRELOADS = [
  { media: WORLD_LANDSCAPE_MEDIA, srcset: worldSrcset(WORLD_LANDSCAPE, "avif"), sizes: WORLD_SIZES },
  { media: WORLD_PORTRAIT_MEDIA, srcset: worldSrcset(WORLD_PORTRAIT, "avif"), sizes: "220vw" },
] as const;
