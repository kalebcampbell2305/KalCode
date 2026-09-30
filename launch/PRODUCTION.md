# KalCode launch film: production brief

A new film, built from zero in Blender 5.1. It reuses nothing from `kalcode-film/`, `marketing/*`, or the abandoned `KalCode-film-blender` worktree.

## Workflow
- **UI plates:** real KalCode UI from the `ui-test` fixture build (`apps/desktop`, `pnpm dev:ui --port 1431`), captured with Playwright at DPR 2. `capture/film-fixture.patch` is a capture-only local patch and is never committed. It does three things:
  - sets the Stable 0.1.7 flags, so the dev-only surfaces are hidden;
  - stages film threads in the `kalcode` workspace;
  - gives Claude Code and Codex two accounts each, Personal and Work, and stages kalcode terminal output (`git log`, `pnpm test`, `cargo test`).
- **Blender:** the UI plates become emissive image planes in 3D space, with a real camera, depth of field, motion blur and compositor glow. Typography uses Blender text objects in the brand fonts. The `.blend` scenes are built by `blender/*.py` and saved so they can be edited by hand.
- **Audio:** an original score and sound effects, synthesized and mixed offline, then mastered with ffmpeg.
- **Encode:** ffmpeg, H.264 high profile, 1920×1080 at 60 fps. Also a 1080×1920 vertical, plus 30 s and 15 s cuts.

## Product truth
Checked 2026-09-30 against `origin/main` 210715ec and live kalcoded.com.
- **Version:** Stable 0.1.7 is live. Windows 10+ x64 and macOS 14+ Apple silicon.
- **Site:** kalcoded.com. Tagline "Code the Future".
- **Providers:** Claude Code and Codex are production. Gemini CLI is unavailable, so it is never shown and never claimed. Film copy says "More providers coming."
- **Accounts:** multiple accounts per provider are real, with local names like "Personal" and "Work". Model picker: Opus, Sonnet, Haiku, Fable. There is no effort control, so don't show one.
- **Stable nav:** Dashboard · KalVoice · Code · Threads · Providers · Approvals · Notifications · Settings.
- **Dashboard:** filters "Waiting for you / Working / Done / Idle", a "Needs you" group, and widgets Needs your approval, Active agents, Activity, Terminals.
- **Code surface:** real terminals (PowerShell 7, Git Bash, Command Prompt), up to 12 per workspace, plus a Browser pane.
- **Concurrency:** Claude Code and Codex threads running at the same time is real.
- **NOT shipped on Stable, never show:**
  - Agent Fleet, Runs, Queue, Services, Environments, Operations
  - provider panes, workspace rail, Home
  - Agents, Missions, Automations, Command Center
  - effort control, account-bound terminals, terminal renaming
- **KalVoice:**
  - Push-to-talk: hold F8 (Windows and macOS), or Fn on macOS.
  - On-device Whisper speech recognition. Dictation into text boxes and terminals.
  - Real grammar used in the film: "Focus the Browser redesign thread." then "Tell it to finish the redesign." Pronoun targets resolve.
  - Also real: "Open the browser.", "What needs my approval?", "Open Dashboard".
  - "Open the terminal working on X" is NOT real, so it's never used.
- **Self-hosting:** the workspace is `kalcode`, and its threads edit KalCode's own files (BrowserPane.tsx, the updater, KalVoice).

## Brand
- **Colors:**

  | Role | Hex |
  | --- | --- |
  | Background | #05080f |
  | Surface | #0b1322 / #101a2d |
  | Text | #e6edf8 |
  | Accent | #4c8dff (primary #2a64e6) |
  | Success | #35c48d |
  | Amber | #f2b544 |
  | Red | #ef5f6b |

- **Fonts:** Lexend Deca (UI), Lexend Exa / Giga (display, wordmark feel), JetBrains Mono (code). All are @fontsource packages in `packages/ui`.
- **Logos:** `assets/branding/kalcode-*.png`, `kalvoice-*.png`.
