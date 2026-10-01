# KalCode Brand

## The artwork is the brand

KalCode's brand comes from the owner's final artwork, used as-is:

| Master | Original file | Used for |
| --- | --- | --- |
| `packages/ui/src/brand/masters/kalcode-mascot.png` | `KalCode New Logo For Everything.png` | **The KalCode logo.** The mascot: app icon, favicon, in-product marks, website hero, social images |
| `packages/ui/src/brand/masters/kalcode-board.png` | `KALCODE LOGO.png` | KalCode wordmark and tagline lettering only (its terminal globe is retired) |
| `packages/ui/src/brand/masters/kalvoice-board.png` | `KALVOICE LOGO.png` | KalVoice orb, KalVoice wordmark, website KalVoice page orb |

Rules:

1. Masters are byte-identical copies of the originals (SHA-256 verified by the pipeline). They
   are never edited, recompressed or overwritten.
2. Every other brand asset is **derived from the masters' pixels** by
   `tooling/generate-brand-assets.py`: the mascot's white ground removed (alpha recovered along
   its edges and glow), crops, resizes, format conversion (AVIF/WebP/PNG/ICO/ICNS), and
   luminance-to-alpha extraction for the lettering and the KalVoice orb. The mascot is never
   redrawn; the only additions are its navy app-icon tile and, for dark surfaces, a soft blue rim
   light so the navy figure stays visible.
3. **One KalCode identity.** The mascot is the only KalCode logo. The terminal-globe symbol from
   the KalCode board is retired and must not be reintroduced. The KALCODE wordmark and tagline
   lettering stay.
4. Replace the masters only when the owner supplies new ones; then rerun the pipeline, then
   `python tooling/generate-hero-layers.py`.

## Production logos (`assets/branding/`)

| Asset | What it is |
| --- | --- |
| `kalcode-icon-{1024,512,256,128,64,32}.png` | **Primary KalCode logo / app icon.** The rim-lit mascot (head, laptop and chest) rising from a deep-navy rounded tile on Apple's 1024 grid (824 px tile, transparent margin). Below 64 px the head alone fills the tile. |
| `kalcode-mascot-light-{1024,512,256,source}.png` | The full mascot on transparent, exactly as drawn (with its soft ground shadow): **light backgrounds**. |
| `kalcode-mascot-dark-{1024,512,256,source}.png` | The full mascot on transparent with a soft blue rim light and glow, no ground shadow: **dark backgrounds** (KalCode's theme). |
| `social/kalcode-x-avatar-400.png` | X (Twitter) profile image: full-bleed square (X crops it to a circle). |
| `social/kalcode-x-header-1500x500.png` | X (Twitter) header: hero world, wordmark, tagline, mascot on the right (clear of the avatar). |
| `social/kalcode-og-1200x630.png` | Social / link-preview card (same as the website's `og.png`). |
| `kalvoice-icon-{...}.png` | **Primary KalVoice logo / icon.** The orb isolated from the board, sphere body opaque. |
| `kalvoice-orb-{...}.png` | The same orb as pure glow, for dark surfaces. |
| `kalvoice-*-source.png` | Native-resolution KalVoice isolations for re-export. |
| `kalcode-wordmark.png`, `kalcode-tagline.png`, `kalvoice-wordmark.png`, `kalvoice-tagline.png` | Board lettering, white on transparent. |

The mascot is raster art; it is delivered as high-resolution transparent PNGs rather than SVG,
because a vector tracing would not reproduce it faithfully. See `assets/branding/README.md`.

## Derived assets

| Asset | Where |
| --- | --- |
| `kalcode-mark-{64,128,256}.png` | The app-icon tile filling its box: desktop sidebar, startup screen, onboarding; website header, footer, product stage. Reads the same in light and dark themes. |
| `kalvoice-mark-{64,128,256}.png` | KalVoice placements in the desktop app |
| `kalcode-mascot-{362,724}.{avif,webp}` | The rim-lit mascot: desktop About and gated screens; website static hero fallback |
| `kalvoice-globe-{300,600}.{avif,webp}` | KalVoice glow orb: desktop KalVoice surface, website `/kalvoice` header |
| `kalvoice-board-{627,1254}.{avif,webp}` | The full KalVoice board: kept for press and marketing use |
| `apps/website/public/assets/hero/orb-*` | The website hero: the rim-lit mascot riding the energy stream, and its WebGL light layers (`tooling/generate-hero-layers.py`) |
| `kalcode-wordmark.png` | Lettering, used as a CSS mask in `currentColor` (header and footer only). The tagline is set as live text on the website: the raster lettering smudges at footer size. |
| `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `og.png` | Website head and social previews |
| `apps/desktop/src-tauri/icons/*` | Desktop application icons for Windows (ICO) and macOS (ICNS), from `kalcode-icon-1024` |

Regenerate everything:

```bash
python tooling/generate-brand-assets.py            # reads ~/Downloads by default
python tooling/generate-brand-assets.py --source-dir /path/to/originals
python tooling/generate-hero-layers.py             # the website hero, from the mascot
```

## Presentation

- Dark, cinematic blue and white. The mascot is navy with electric-blue and cyan pixels: on dark
  grounds use the rim-lit variant (or the tile), on light grounds the plain cutout. Glow art on the
  website (the hero mascot, the KalVoice orb) always sits on a dark ground, in both themes: the
  home hero is a night band, and the KalVoice orb sits in its own night disc.
- Taglines: KalCode "One intelligence. A brighter tomorrow." · KalVoice board "Human voice.
  Brighter possibilities." · KalVoice product line "Speak your prompts. Control your workspace.
  Coordinate your coding agents."
- Product headline: "One intelligence that operates your entire AI workspace."
- Naming: **KalCode** is the product. **KalVoice** is the coding assistant and voice layer
  inside KalCode. No other assistant brand appears anywhere in KalCode.
