# KalCode Brand

## The boards are the brand

KalCode's brand comes from the owner's two final brand boards, used as-is:

| Master | Original file | Used for |
| --- | --- | --- |
| `packages/ui/src/brand/masters/kalcode-board.png` | `KALCODE LOGO.png` | KalCode symbol, app icon, favicon, wordmark, tagline, social card, website hero orb (animated symbol) |
| `packages/ui/src/brand/masters/kalvoice-board.png` | `KALVOICE LOGO.png` | KalVoice orb, KalVoice wordmark, website KalVoice page orb |

Rules:

1. Masters are byte-identical copies of the originals (SHA-256 verified by the pipeline). They
   are never edited, recompressed or overwritten.
2. Every other brand asset is **derived from the boards' pixels** by
   `tooling/generate-brand-assets.py`: crops, removal of the board's annotation labels, resizes,
   format conversion (AVIF/WebP/PNG/ICO/ICNS), and luminance-to-alpha extraction so the glowing
   symbols and lettering sit on any surface. Nothing is redrawn, and no lookalike vector
   recreations are used.
3. **In the product, use the isolated symbols, never a full board as a logo.** On the website
   the home hero is headed by the isolated KalCode symbol, animated (`HeroOrb`), never by a full
   board; the KalVoice page uses the isolated orb. A full board, with its annotation rows, reads
   as a presentation sheet and is not placed above the fold on any page.
4. Replace the boards only when the owner supplies new ones; then rerun the pipeline.

## Production logos (`assets/branding/`)

| Asset | What it is |
| --- | --- |
| `kalcode-icon-{1024,512,256,128,64,32}.png` | **Primary KalCode logo / app icon.** The terminal globe isolated from the board, transparent background, sphere body opaque so it reads on light and dark surfaces. |
| `kalcode-symbol-{…}.png` | The same symbol as pure glow, for dark surfaces and hero art. |
| `kalvoice-icon-{…}.png` | **Primary KalVoice logo / icon.** The orb isolated from the board, sphere body opaque. |
| `kalvoice-orb-{…}.png` | The same orb as pure glow, for dark surfaces. |
| `*-source.png` | Native-resolution isolations for re-export. |
| `kalcode-wordmark.png`, `kalcode-tagline.png`, `kalvoice-wordmark.png`, `kalvoice-tagline.png` | Board lettering, white on transparent. |

Sizes below 96 px use a tighter crop around the sphere so the symbol stays legible. The symbols
are raster particle-glow art; they are delivered as high-resolution transparent PNGs rather than
SVG, because a vector tracing would not reproduce them faithfully. See `assets/branding/README.md`.

## Derived assets

| Asset | Where |
| --- | --- |
| `kalcode-mark-{64,128,256}.png` | Desktop sidebar, startup screens, loading splash; website header |
| `kalvoice-mark-{64,128,256}.png` | KalVoice placements in the desktop app |
| `kalcode-globe-{362,724}.{avif,webp}` | KalCode glow symbol: desktop About |
| `kalvoice-globe-{300,600}.{avif,webp}` | KalVoice glow orb: desktop KalVoice surface, website `/kalvoice` header |
| `kalcode-board-{627,1254}`, `kalvoice-board-{627,1254}` `.{avif,webp}` | Full boards: kept for press and marketing use; not placed in the website hero |
| `kalcode-wordmark.png` | Lettering, used as a CSS mask in `currentColor` (header and footer only). The tagline is set as live text on the website: the raster lettering smudges at footer size. |
| `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `og.png` | Website head and social previews (`og.png` is the KalCode board's hero) |
| `apps/desktop/src-tauri/icons/*` | Desktop application icons (from `kalcode-icon-1024`) |

Regenerate everything:

```bash
python tooling/generate-brand-assets.py            # reads ~/Downloads by default
python tooling/generate-brand-assets.py --source-dir /path/to/originals
```

## Presentation

- Dark, cinematic blue and white. The boards' own ground is near-black (`#000001`); surfaces that
  show a full board frame it on that ground in both themes. Glow art on the website (the hero orb,
  the KalVoice orb) always sits on a dark ground, in both themes: the home hero is a night band,
  and the KalVoice orb sits in its own night disc.
- Taglines: KalCode "One intelligence. A brighter tomorrow." · KalVoice board "Human voice.
  Brighter possibilities." · KalVoice product line "Speak your prompts. Control your workspace.
  Coordinate your coding agents."
- Product headline: "One intelligence that operates your entire AI workspace."
- Naming: **KalCode** is the product. **KalVoice** is the coding assistant and voice layer
  inside KalCode. No other assistant brand appears anywhere in KalCode.
