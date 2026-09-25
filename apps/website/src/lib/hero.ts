/**
 * Hero image hints shared by the hero slot and the page head.
 *
 * The orb poster is the home page's LCP image (hero/world-assets.ts): HERO_POSTER_PRELOADS gives one
 * preload per media query, matching the poster's <source> elements exactly, so the browser fetches
 * the file the layout uses as early as possible. The world plate is a full-viewport background and
 * never the LCP, so it is not preloaded. HERO_POSTER_SIZES sizes the poster when only the orb (no
 * world) is rendered.
 */
import { POSTER_PRELOADS, POSTER_SIZES_CENTERED } from "../components/hero/world-assets";

export const HERO_POSTER_SIZES = POSTER_SIZES_CENTERED;

export const HERO_POSTER_PRELOADS = POSTER_PRELOADS;
