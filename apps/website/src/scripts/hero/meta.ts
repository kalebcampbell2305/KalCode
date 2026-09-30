/**
 * Geometry of the KalCode mascot inside the hero square (normalised 0..1, y down), as placed by
 * `tooling/generate-hero-layers.py`. Keep the two in sync. The page layout (styles/hero.css,
 * critical.css) still anchors the square by the old symbol's centre (0.5211); the mascot's feet
 * sit just above the entry point, clear of the wordmark below.
 */
export const FIGURE_X = 0.493;
/** Where the energy stream meets the mascot: just under its feet. */
export const ENTRY_Y = 0.762;
/** The top of the mascot's head (the upward thread leaves from just inside it). */
export const HEAD_Y = 0.07;

/** Generated layers (public/assets/hero). */
export const FX_URL = "/assets/hero/orb-fx-512.webp";
export const BLOOM_URL = "/assets/hero/orb-bloom-256.webp";
