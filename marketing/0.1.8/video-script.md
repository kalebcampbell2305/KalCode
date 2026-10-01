# "What's new in KalCode 0.1.8" video script

Length: 75 s master (4,500 frames at 60 fps). Cuts: 30 s and 15 s (see the end of this file), plus a 1080x1920 vertical of the master.

Built like the launch film in `launch/` (see `launch/README.md` and `launch/PRODUCTION.md`): Blender 5.1 EEVEE, real UI plates as emissive image planes, a real 3D camera with depth of field and motion blur, compositor bloom and vignette, an original synthesized score, and ffmpeg delivery (H.264 High, AAC 320k, -14 LUFS / -1 dBTP). Reuse the launch film's look, brand colors and fonts. Make new plates for 0.1.8; don't reuse launch-film shots, because those show 0.1.7.

**No voice-over and no synthesized voice.** On-screen supers carry the story, and KalVoice appears as transcripts only (owner decision for KalCode films).

## Product truth for this film

Every super and every visible UI state must match one of these claims. Each claim names its proof.

| # | Claim | Proof |
| --- | --- | --- |
| C1 | Operations: a sidebar page with Runs, Queue, Services, Environments and Activity | PR #46 (`fix/operations-cohesion`), merged into `integrate/operations-b13` at 2c37c724; base work 84a7c4e0; `crates/native-core/src/flags.rs` marks Operations Available on Stable |
| C2 | Queue agent tasks, builds, tests, scripts, deploys, releases, background commands and services with priority and dependencies | `OperationsPage.tsx` KINDS; `docs/OPERATIONS.md` (Queue) |
| C3 | Nothing runs until you confirm it; a restart never reruns work | `docs/OPERATIONS.md` (Admission and execution) |
| C4 | Each run keeps its log and the files a command reports as outputs | 959bb4b5 (verified command artifacts); `docs/OPERATIONS.md` |
| C5 | Services: processes and ports; stop and restart only for services Operations started | `docs/OPERATIONS.md` (Services) |
| C6 | Environments: Local, Preview, Staging, Production; deploys marked unverified | `docs/OPERATIONS.md` (Environments); `OperationsPage.tsx` "URLs unverified" |
| C7 | Blue focus trace on terminal panes, plays once | PR #32: 6f43a0f2, a8ab8d7a |
| C8 | Amber means waiting for you | PR #32: 6f43a0f2, a8ab8d7a |
| C9 | Terminal limits follow your plan (Free and Pro 12 per workspace; MAX and MAX 2X no KalCode limit) | PR #36: c821b181; Operations terminals count too: f7f34310 |
| C10 | KalVoice prepares its speech model once per take, before the mic opens | PR #38: bb62bdc1 |
| C11 | Low memory during a take stops the recording; KalCode keeps running | PR #43: 0c296773, d3d57124 |
| C12 | KalVoice widget no longer covers pane controls | de7bc694 |
| C13 | Windows no longer freezes on focus changes | PR #31: f9ff0160 |
| C14 | The mascot is the KalCode logo and app icon | PR #37: 48b1881f |
| C15 | Version shown as "0.1.8 build N" where detailed | PR #34: b387fc19 (`apps/desktop/src/platform/version.ts`) |
| C16 | Later 0.1.8 builds install when you close KalCode; the update prompt is for new versions | `feat/silent-build-updates` (in the 0.1.8 release) |

Never show: Agents, Missions, Automations, Command Center, provider panes, workspace rail, Home, effort control, Gemini CLI, prices, or any speed number for KalVoice. Never show a deploy as "healthy" or "live".

## Plates to capture

From the 0.1.8 release commit with an updated capture-only fixture patch (see `screenshots.md`): S1, S2, S4, S5, S6 (as a 60 fps image sequence), S7, S9, S10, S12, S14, plus an Operations sidebar entry close-up and the Code surface with four terminals. Real-install plates: S3 (native confirmation) if `ui-test` can't render it, S11 (app icon on Windows taskbar and macOS Dock), S13 if beat 5b is kept. Run `launch/tools/rebrand_plates.py` only if a plate still shows the old globe; 0.1.8 plates should already show the mascot.

## Shot list (75 s master)

Frame numbers at 60 fps. "Super" is on-screen text in Lexend Exa (display) or Lexend Deca (body) on the brand background `#05080f`, accent `#4c8dff`, amber `#f2b544`.

### Beat 0. Cold open (0:00-0:04, f0-240)

| Time | Picture | Camera | Super | Sound |
| --- | --- | --- | --- | --- |
| 0:00-0:02 | Black. The rim-lit mascot (`launch/assets/brand/kalcode-mascot-dark-1024.png`) fades up out of depth, a soft blue rim light sweeping across it. | Slow push-in, 50 mm, shallow DOF. | none | Low pad swell. |
| 0:02-0:04 | Mascot settles; "KalCode 0.1.8" resolves beside it with a light sweep. | Hold, slight drift. | **KalCode 0.1.8** / small: "What's new" | Soft hit on the version number. |

### Beat 1. Operations reveal (0:04-0:13, f240-780) - C1

| Time | Picture | Camera | Super | Sound |
| --- | --- | --- | --- | --- |
| 0:04-0:07 | The full KalCode window (dark) assembles; the sidebar entry "Operations" lights up blue as the cursor clicks it. | Dolly from the sidebar entry out to the full window. | **New: Operations** | Click, rising arpeggio. |
| 0:07-0:13 | The five tab labels (Runs, Queue, Services, Environments, Activity) lift off the plate one by one as separate planes, stacked in depth, then return into the tab bar. | Orbit 15 degrees around the stack, rack focus tab to tab. | "One place for your project's work." | Five soft ticks, one per tab. |

### Beat 2. Queue to run (0:13-0:31, f780-1860) - C2, C3, C4

| Time | Picture | Camera | Super | Sound |
| --- | --- | --- | --- | --- |
| 0:13-0:18 | S1 Queue: four items in order. The dependency links between "pnpm build", "pnpm test" and "Deploy preview" draw as thin blue lines in front of the plate. | Low-angle push along the list. | "Queue agent tasks, builds, tests and deploys." | Steady pulse starts (score bed). |
| 0:18-0:22 | Cursor on "Run now" for "Deploy preview"; S3 confirmation comes forward as its own plane. Cursor clicks Confirm. | Pull focus from queue to dialog. | "Nothing runs until you confirm it." | Click, short pause in the pulse. |
| 0:22-0:27 | Queue item slides into "Now", turns into a running row, then S2 Run detail opens: status, output log scrolling, the Artifacts tab showing `dist/app.zip`. | Track right into the run detail; the log lines are a separate scrolling plane for parallax. | "Every run keeps its log and its outputs." | Typing ticks under the log. |
| 0:27-0:31 | Hard cut to a restart: window closes and reopens; the queue header shows "Queue paused", nothing re-ran. | Static, centered. | "A restart never reruns work on its own." | Whoosh out, soft thud in. |

### Beat 3. Services, Environments, Activity (0:31-0:41, f1860-2460) - C5, C6

| Time | Picture | Camera | Super | Sound |
| --- | --- | --- | --- | --- |
| 0:31-0:35 | S4 Services: a dev server with its port; cursor hovers Restart (enabled); the externally started process shows no controls. | Slow lateral track. | "See the services in your workspaces." | Low synth stab. |
| 0:35-0:39 | S5 Environments: the four cards (Local, Preview, Staging, Production) fan out in depth like cards, Production last and slightly brighter. The "URLs unverified" label stays readable. | Push through the fanned cards. | "Local to Production. Unverified means unverified." | Four rising notes. |
| 0:39-0:41 | S14 Activity heatmap flashes in. | Quick push. | none | Shimmer. |

### Beat 4. Terminals (0:41-0:51, f2460-3060) - C7, C8, C9

| Time | Picture | Camera | Super | Sound |
| --- | --- | --- | --- | --- |
| 0:41-0:45 | S6 Code with two terminals; the right pane is focused and the blue trace runs once around its edge (use the captured 60 fps sequence, not a re-animation), then settles into the thin outline. | Macro push along the pane edge, following the trace. | "Blue is focus." | Electric sweep matching the trace, once. |
| 0:45-0:48 | S7 Threads row turns amber with the "needs you" badge. | Rack focus to the badge. | "Amber is waiting for you." | Two-note chime. |
| 0:48-0:51 | Code surface: terminals tile in until there are more than 12 (MAX fixture account). | Pull back to reveal the grid. | "Terminal limits follow your plan." | Ticks accelerate, resolve. |

### Beat 5. KalVoice and updates (0:51-1:03, f3060-3780) - C10, C11, C12, C15, C16

| Time | Picture | Camera | Super | Sound |
| --- | --- | --- | --- | --- |
| 0:51-0:55 | KalVoice widget: F8 key cap on screen pressed; transcript appears "Open the browser." and the Browser pane opens. | Close on the widget, then pan to the Browser pane. | "KalVoice gets ready once per take." | Key-down click, soft listening tone. No voice. |
| 0:55-0:59 | S9 low-memory message in the widget; KalCode still running behind it. | Hold on the widget; background stays sharp enough to read. | "Low on memory? KalCode keeps running." | Muted error blip, score continues (no crash sound). |
| 0:59-1:01 | 5a. S12 Settings > Updates: "KalCode 0.1.8 build N". | Push to the version line. | "Every build, numbered." | Tick. |
| 1:01-1:03 | 5b. S13: KalCode closes, reopens; the version line now reads build N+1 with no prompt. | Same framing as 5a so the number change reads. | "New builds install when you close KalCode." | Close whoosh, open shimmer. |

### Beat 6. Fixes and the new face (1:03-1:09, f3780-4140) - C13, C14

| Time | Picture | Camera | Super | Sound |
| --- | --- | --- | --- | --- |
| 1:03-1:06 | Windows desktop plate: focus jumps between KalCode and two other windows several times; KalCode keeps responding (cursor in its terminal keeps typing). | Static, slight handheld drift. | "Fixed: Windows freezes on focus changes." | Quick alt-tab whooshes. |
| 1:06-1:09 | S11: the mascot app icon in the Windows taskbar, then in the macOS Dock (split screen or quick cross-dissolve). | Push into each icon. | "A new KalCode logo. On Windows and macOS." | Warm brand sting. |

### Beat 7. End card (1:09-1:15, f4140-4500)

| Time | Picture | Camera | Super | Sound |
| --- | --- | --- | --- | --- |
| 1:09-1:15 | Rim-lit mascot left, text right on `#05080f`. | Slow push, then hold for the last 2 s. | **KalCode 0.1.8** / "Windows and macOS" / "Claude Code + Codex available now." / **kalcoded.com/download** | Score resolves; final hit at 1:13, tail to silence by 1:15. |

## Vertical 1080x1920

Reframe each beat for portrait: put the UI plate in the upper two thirds and the super in the lower third. Crop the S1 Queue to its list column, S5 to two cards at a time (Local and Production), and S6 to the single focused pane. Keep every super at least 64 px from the safe edges.

## 30 s cut

Beats 0 (0:00-0:02 only), 1 (0:04-0:07), 2 (0:13-0:27 trimmed to 10 s: queue, confirm, run log), 4 (0:41-0:48), 5 (0:55-0:59), 6 (1:06-1:09), 7 (3 s end card).

## 15 s cut

Super "KalCode 0.1.8" (1 s) -> Operations Queue to run (6 s: queue, confirm, log) -> focus trace (2 s) -> low-memory KalVoice (2 s) -> app icon (1 s) -> end card (3 s).

## QA before delivery

- Every visible version string reads 0.1.8 (with "build N" only in Settings > Updates).
- No emails, tokens, real account names or private paths in any plate.
- Every super maps to a claim C1-C16 above.
- Run `launch/tools/qa.py` (frame and loudness checks) on the master and each cut.
