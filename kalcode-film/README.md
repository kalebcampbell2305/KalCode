# KalCode launch film

A 60.000-second product launch film: "Introducing KalCode." It is rendered deterministically
from React (Remotion) and an original, fully synthesized score. Both are driven by a single cue
sheet.

**Status:** it is not published. The owner asked to review the film before anything is shipped.

## Deliverables (`out/`)

| File | Format |
|---|---|
| `kalcode_launch_60s.mp4` | Master: 1920×1080, 60 fps, H.264 High, yuv420p, CRF 16 (x264 `slow`), BT.709, +faststart. Audio: AAC-LC 320 kbps, 48 kHz, stereo, −14 LUFS, true peak ≤ −1 dBTP |
| `kalcode_launch_60s_vertical.mp4` | 1080×1920, recomposed rather than cropped: scenes read `useStage().portrait` and re-lay copy, camera targets, lanes (top-to-bottom) and the pipeline (vertical) |
| `kalcode_launch_30s.mp4`, `kalcode_launch_15s.mp4` | Social cuts from the master, cut on the beat grid and loudness-normalized separately |
| `contact_sheet.png`, `contact_sheet_vertical.png` | One frame every 0.5 s |
| `keyframes/` | Full-resolution frames at 00, 06, 10, 16, 23, 31, 37, 43, 50, 55 and 59 s |
| `audio_waveform.png`, `audio_spectrum.png` | Master audio, with the bar grid and scene and hit markers |
| `qa_report.json` (+ `../QA.md`), `determinism.json` | Measured from the delivered files |

Planning documents: `product_truth.md` (every claim and its source), `storyboard.md`, `copy_sheet.md`,
`cue_sheet.json` (the timing source of truth), and `research/product_research.md` (full cited research).

## Build

Requires Node 22+, Python 3.12+ (`numpy scipy soundfile matplotlib Pillow`) and FFmpeg on PATH.

```bash
npm install
node scripts/cues.mjs                  # validate + stamp cue_sheet.json (bar/beat/frame/sample)
python src/audio/build_audio.py        # score + sound design → audio/master.wav, plots
node scripts/render.mjs --comp KalCodeLaunch --out out/kalcode_launch_60s.mp4
node scripts/render.mjs --comp KalCodeLaunchVertical --out out/kalcode_launch_60s_vertical.mp4
python scripts/social.py               # 30 s + 15 s cuts
python scripts/qa.py out/*.mp4         # technical QA → out/qa_report.json, QA.md
python scripts/contact.py out/kalcode_launch_60s.mp4 out/contact_sheet.png out/keyframes
node scripts/determinism.mjs           # standalone frames == film frames
```

Useful while iterating:

- `node scripts/render.mjs --preview --out build/preview.mp4` renders at half resolution in about 1 minute.
- `node scripts/stills.mjs KalCodeLaunch build/sheet.png 6 22.5 48` renders review stills.
- `npm run studio` opens Remotion Studio.

## How it works

- **Timing:** `cue_sheet.json` is the single source of timing.
  - It uses 120 BPM, 4/4, 30 bars (one bar = 2 s = 120 frames = 96 000 samples).
  - Authors write seconds on the 16th-note grid. `scripts/cues.mjs` validates the grid, checks that scene boundaries fall on bar lines, and stamps each cue with its frame and sample.
  - The visuals read cues through `cf("id")`, which throws on a missing cue. The audio reads the same file. Nothing is synced by eye.
- **Determinism:** every scene is a pure function of the absolute frame.
  - There are no CSS transitions or animations, no `Date.now()` and no `Math.random()`.
  - Randomness comes from Mulberry32 with a seed. The audio RNG is seeded 20260930.
  - `scripts/determinism.mjs` renders standalone frames twice (pixel-identical) and compares them against the film.
- **Motion grammar:** `src/motion` provides `reveal`, `conceal`, `stagger`, `springIn`, `magneticSnap`, `streamText`, `terminalType`, `cameraPush`, `focusRack`, `branchGrow`, `pipelinePulse`, `agentLaunch`, `shipHit`, `drift` and `motionBlur`.
  - It includes the product's own easing tokens (`--ease-standard`, `--ease-emphasized`, `--ease-expo`).
  - The camera (`src/components/camera.tsx`) interpolates keyframes: a window point is placed at a stage point at a given scale.
- **Product UI:** `src/ui` is a motion-ready abstraction of the Stable 0.1.6 desktop app.
  - It uses the real information architecture, lucide icons (the same package and version the app uses), and tokens copied verbatim from `packages/ui/src/styles/tokens.css`.
  - Fonts are the app's bundled Lexend Deca, Lexend Exa and JetBrains Mono. Rendering blocks until they load, so no fallback-font frame can render.
  - The brand marks are the production PNGs from `assets/branding`.
- **Scenes** (`src/scenes`), in order: Chaos, Introduce, Workspace, Providers, AgentSwarm, KalVoice, BuildLoop, ReleasePipeline, SelfHosting, EndCard.
- **Audio** (`src/audio`): synthesized from oscillators, filtered noise and FM, then processed.
  - `score.py` is the music; `instruments.py` holds the voices and the UI sound design.
  - `build_audio.py` runs a BS.1770-4 meter and a 4×-oversampled true-peak limiter.
  - No samples, loops or recordings are used anywhere.

## Sonic identity

- **Mnemonic:** B4 – E5 – F♯5 – B5 on the 16th-note grid 0 · 3 · 6 · 8. That is a rising fourth, a step, then another rising fourth, played on a two-operator FM bell.
  - It lands on the product hit at 6.000.
  - Each agent launch answers with one note of it.
  - It climbs one note per release gate.
  - It plays fully over an E major add9 resolution on the end card.
- **Harmony:** the score moves from E minor (i–VI–III–VII: Em9, Cmaj7♯11, G6/9, D6/F♯) to E major. The film's arc runs from friction to resolution.
- **Sound cues:**

  | Cue | Sound |
  |---|---|
  | Pane snap | Tactile click plus a small tonal thump |
  | Agent launch | Upward chirp into a pitched ping |
  | KalVoice | A rising fifth for mic-on and a falling one for mic-off |
  | Browser reload | Air sweep |
  | Pipeline | A rising tonal pulse |
  | Tests passing | A glassy major-third dyad |
  | Ship | A large but controlled sub impact |

## Publication notes

- The film shows only Stable 0.1.6 behaviour. `product_truth.md` lists what is deliberately left out.
- The in-story release is "KalCode 0.1.7". Its update card is shown in a macOS window because in-app update on Windows 0.1.6 is broken; the fix is planned for 0.1.7.
- Re-check `crates/native-core/src/flags.rs` and the live site before publishing.
