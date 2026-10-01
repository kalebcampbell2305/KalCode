# KalCode launch film

The 60-second KalCode launch film was made from scratch in **Blender 5.1** (EEVEE). It has a real 3D camera, depth of field, motion blur, and compositor bloom and vignette. Every UI surface is a capture of real KalCode 0.1.7 Stable UI. The original score and sound design are synthesized offline. The film uses no stock music, samples, templates, or earlier KalCode film material.

For the source of truth and what the film may claim, see `PRODUCTION.md`.

## Deliverables (`out/`, not committed)

| File | Format |
| --- | --- |
| `KalCode_Launch_60s_1080p60.mp4` | Master. 1920×1080, 60 fps, H.264 High, AAC 320k, −14 LUFS / −1 dBTP |
| `KalCode_Launch_60s_vertical_1080x1920.mp4` | Vertical social version |
| `KalCode_Launch_30s_1080p60.mp4` | 30 s cut |
| `KalCode_Launch_30s_vertical_1080x1920.mp4` | Vertical 30 s cut |
| `KalCode_Launch_15s_1080p60.mp4` | 15 s cut |
| `qa_report.json` | Frame and deliverable QA |

## Structure (60 fps)

| Time | Act |
| --- | --- |
| 0:00–0:05 | Chaos: 34 real KalCode windows in a depth tunnel. They collapse into a flash, then a black beat. |
| 0:05–0:08 | "Now introducing" → KalCode mascot tile and wordmark (light-sweep reveal) → "An all-in-one AI software engineering workspace." |
| 0:08–0:11 | The wordmark flies into the sidebar logo while the window assembles from its pieces. |
| 0:11–0:15 | One workspace: a real terminal (`pnpm test`) → the Browser pane joins beside it. |
| 0:15–0:20 | Providers, zoomed out to the whole page: Setup (each provider's own CLI, installed and signed in on this machine) → Accounts (Personal and Work for Claude Code and for Codex). |
| 0:20–0:35 | Multi-session coding: the real Layout menu → 4 panes (2 × 2), with Claude Code and Codex working in every pane. The four sessions lift out of the window and keep streaming. Then Ctrl Alt 6 → 6 panes (3 × 2): a low dolly across six agents, each pane lighting green as its agent finishes. "Six agents. One screen." → "Build. Test. Ship." |
| 0:35–0:43 | Multi-agent: four agent cards lift out of the Dashboard, then the live Dashboard shows status changes. |
| 0:43–0:50 | KalVoice: "Focus the Browser redesign thread." (locate → focus → illuminate), then "Tell it to finish the redesign." |
| 0:50–0:56 | Cockpit: `git push`, workspaces, Dashboard. "Not another terminal wrapper." |
| 0:56–1:00 | End card: KalCode · Refactor the workflow. · Code the future. · Start building — kalcoded.com · Claude Code + Codex available now. More providers coming. |

## Rebuild

```sh
# 1. UI captures (only needed to refresh plates)
git apply launch/capture/film-fixture.patch            # capture-only fixture staging, never commit
(cd apps/desktop && pnpm dev:ui --port 1431 --strictPort)
(cd apps/desktop && cp ../../launch/capture/capture.mjs cap.tmp.mjs && node cap.tmp.mjs ../../launch/capture/plates)
#    ... likewise capture_voice / capture_browser / capture_acts / capture_dashlive / capture_more,
#    and capture_panes (-> plates/panes: Layout presets, agent CLIs, Providers)
git checkout -- apps/desktop                            # drop the staging patch
python launch/tools/rebrand_plates.py && python launch/tools/crops.py && python launch/tools/prep_proof.py && python launch/tools/prep_film.py && python launch/tools/prep_panes.py

# 2. Scene, audio, render, deliver
blender -b --factory-startup -P launch/blender/film.py   # writes launch/blender/film.blend + audio/film_cues.json
python launch/audio/film_score.py                         # writes audio/film_mix.wav
sh launch/tools/render_film.sh                            # resumable chunked render -> render/film/
python launch/tools/deliver.py && python launch/tools/qa.py
```

`blender/film.blend` opens in Blender for hand edits. Every move is an ordinary keyframe, eased with EXPO / BACK / BEZIER, in the Graph Editor. UI states are materials with keyable `Opacity` / `Bright` nodes.

## Honest notes

- The mascot is the only KalCode logo; the retired terminal globe never appears. The UI captures predate the in-app switch, so `tools/rebrand_plates.py` puts the mascot mark into the captured sidebars and website headers (originals kept in `capture/plates_orig/`), and replaces the kalcoded.com home hero globe with the mascot for the chaos-act fragment.
- The Browser pane's web content is composited. The `ui-test` build has no native web view, so the live kalcoded.com Download page, captured at the pane's own size, is placed into the real Browser pane.
- The multi-pane act uses the real Stable Layout presets (4 panes 2 × 2, 6 panes 3 × 2) and plain KalCode terminals. Each terminal runs the provider's own CLI (`claude "…"`, `codex "…"`). The CLI output is a staged rendering in the `ui-test` fake shell (capture-only, in `film-fixture.patch`). KalCode's dedicated provider panes are gated off Stable, so the film doesn't show them.
- The Providers act hides the unavailable Gemini CLI card and trims the clause naming it from the sign-in sentence. Nothing else on the page is changed.
- Terminal output, thread names and repo content are staged fixtures: the kalcode workspace, real KalCode commit subjects, and sanitized paths (`C:\Users\you`). No emails, tokens or secrets appear.
- KalVoice is shown with transcripts only, not a synthesized voice. Both phrases are real native grammar (`crates/kalvoice/src/grammar_sessions.rs`).
- Features that aren't shipped on Stable (Agent Fleet, Runs, Queue, provider panes, workspace rail, effort control) are not shown. Gemini CLI is not shown.
