/**
 * Geometry of the KalCode symbol inside its square (normalised 0..1, y down), as measured by the
 * brand pipeline and used by `tooling/generate-hero-layers.py`. Keep the three in sync.
 */
export const SPHERE_X = 0.493;
export const SPHERE_Y = 0.5211;
export const SPHERE_R = 0.2807;
/** Where the energy stream meets the sphere: its lowest point, just inside the rim. */
export const ENTRY_Y = SPHERE_Y + SPHERE_R * 0.985;

/** Generated layers (public/assets/hero). */
export const FX_URL = "/assets/hero/orb-fx-512.webp";
export const BLOOM_URL = "/assets/hero/orb-bloom-256.webp";
