# KalCode Brand

## Artwork is the brand

KalCode's brand imagery is the owner's supplied artwork, used as-is:

| Master | Original file | Used for |
| --- | --- | --- |
| `packages/ui/src/brand/masters/kalcode-brand.png` | `KALCODE UI FOR WEBSITE LOGO AND FOR THEME.png` | KalCode logo, globe, wordmark, tagline, app icon, favicon, social card |
| `packages/ui/src/brand/masters/kalvoice-globe.png` | Lossless crop of the globe region of the owner-supplied voice artwork (no lettering) | KalVoice globe inside KalCode and on the website |

Rules:

1. Masters are byte-identical copies of the originals (SHA-256 verified by the pipeline). They
   are never edited, recompressed or overwritten. Unmodified copies are also published at
   `https://kalcoded.com/assets/brand/kalcode-brand.png`. The voice artwork's original is not
   published: only its lettering-free globe is used, as KalVoice's visual identity.
2. Every other brand asset is **derived from the masters' pixels** by
   `tooling/generate-brand-assets.py`: crops, resizes, format conversion (AVIF/WebP/PNG/ICO/ICNS),
   and luminance-to-alpha extraction of the lettering so it can be tinted for light and dark
   surfaces. Nothing is redrawn, and no lookalike vector recreations are used.
3. Replace the artwork only when the owner supplies new masters; then rerun the pipeline.

## Derived assets

| Asset | Where |
| --- | --- |
| `kalcode-globe-{362,724}.{avif,webp}` | Website hero, desktop About |
| `kalcode-mark-{64,128,256}.png` | Header/sidebar logo (globe cut to a circle) |
| `kalcode-wordmark.png`, `kalcode-tagline.png` | Lettering, used as CSS masks in `currentColor` |
| `kalcode-artwork-{560,1122}.{avif,webp}` | Full artwork for brand presentation |
| `kalvoice-globe-{300,600}.{avif,webp}` | KalVoice surfaces (desktop and website); the name "KalVoice" is set in KalCode typography |
| `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `og.png` | Website head and social previews |
| `apps/desktop/src-tauri/icons/*` | Desktop application icons |

Regenerate everything:

```bash
python tooling/generate-brand-assets.py            # reads ~/Downloads by default
python tooling/generate-brand-assets.py --source-dir /path/to/originals
```

## Presentation

- The artwork's own background is `#000104`. Surfaces that show the artwork use exactly this
  ground (in both themes) so no seam is visible; square crops are blended with a radial mask.
- Taglines: KalCode "Code a brighter tomorrow." · KalVoice "Speak your prompts. Control your
  workspace. Coordinate your coding agents."
- Product headline: "One intelligence that operates your entire AI workspace."
- Naming: **KalCode** is the product. **KalVoice** is the coding assistant and voice layer
  inside KalCode. No other assistant brand appears anywhere in KalCode.
