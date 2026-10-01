# KalCode 0.1.8 screenshot shot list

Capture from the 0.1.8 release commit (it must contain Operations, #46 via `integrate/operations-b13`), not from 0.1.7 `main`. Use the `ui-test` fixture build as the launch film does (`apps/desktop`, `pnpm dev:ui --port 1431 --strictPort`, Playwright at DPR 2, window 1600x1000 CSS px), with a capture-only fixture patch like `launch/capture/film-fixture.patch` updated for 0.1.8: Stable flags with Operations available, the `kalcode` workspace, Claude Code and Codex accounts named Personal and Work. Never commit the patch.

Rules for every shot:

- Dark theme unless the shot says otherwise; S7 also needs a light-theme copy (the darker amber is part of the claim).
- Sanitized paths only (`C:\Users\you`, `/Users/you`). No emails, tokens, real account names or customer data.
- Version text reads "0.1.8" (with "build N" only where the app shows it). Never show 0.1.7, 0.1.2 or any burned version.
- The sidebar shows the mascot logo. Never the retired terminal globe.
- Don't show surfaces that aren't in Stable 0.1.8: Agents, Missions, Automations, Command Center, provider panes, workspace rail, Home, or an effort control. Don't show Gemini CLI.
- Output: PNG at DPR 2, plus a 1200x675 crop for X/LinkedIn and a 1080x1350 crop for portrait feeds where noted.

| ID | Surface and state | How to stage it | Claim it supports | Used in |
| --- | --- | --- | --- | --- |
| S1 | Operations > Queue, four waiting items in order: "Fix flaky updater test" (agent, Claude Code, Personal), "pnpm build" (build), "pnpm test" (test, depends on build), "Deploy preview" (deploy, depends on test). Header badge "Scheduler active"; summary bar "1 running · 3 queued". | Fixture queue items in the memory Operations transport; one item in Now. | Queue with priority and dependencies | Blog hero, X 2/5, LinkedIn |
| S2 | Operations > Runs, a finished "pnpm test" run open: status, exit code, output log tail, Artifacts list with `dist/app.zip`. | Fixture run with a command artifact report. | Each run keeps its log and reported outputs | Blog, X 2/5 |
| S3 | The native confirmation for "Deploy preview", showing the workspace, branch and the command. | Click Run now on a queued item. If the native dialog can't render in `ui-test`, capture it from a signed 0.1.8 build on Windows and on macOS. | Nothing runs until you confirm | Video beat 2 |
| S4 | Operations > Services: a local dev server process with its port, with Stop and Restart enabled; a second, externally started process shown view-only. | Fixture services. | Services view; controls only for services Operations started | Blog |
| S5 | Operations > Environments: Local, Preview, Staging, Production cards for `kalcode`. Preview shows a branch, "Deployed unverified" and "URLs unverified"; Staging shows "Not observed". | Fixture deploy record. | Environments, labeled honestly | Blog, Reddit |
| S6 | Code: two terminal panes side by side; the right pane just focused, mid-trace (blue trace about a third of the way around). Also a 3 s GIF/MP4 of the trace running once and settling into the thin outline. | Click into the pane; record at 60 fps with reduced motion off. | Blue focus trace, plays once | X 3/5, video beat 3 |
| S7 | Threads list with one row waiting for a permission answer: amber "needs you" badge, plus the Dashboard "Waiting for you" filter. Dark and light theme. | Fixture thread waiting on approval. | Amber means waiting for you | X 3/5, video beat 3 |
| S8 | Code: the terminal-limit message on a Free or Pro fixture account after the 12th terminal ("names your plan and its limit"); and a MAX fixture account with more than 12 terminals open. | Fixture plan on the account runtime. | Terminal limits follow your plan | Blog |
| S9 | KalVoice widget showing the low-memory message: "Your computer is low on memory, so KalCode couldn't keep this recording. Close some apps, then try again." KalCode still open behind it. | Fixture KalVoice status with error code `microphone_low_memory`. | Low memory no longer closes KalCode | X 4/5, video beat 4 |
| S10 | KalVoice widget docked at the bottom with "Speech unavailable" (or push to talk off), sitting in its band; the pane's "Actions for pane" button visible just above it. | Turn push to talk off from Ready. | Widget no longer covers pane controls | Video beat 4 |
| S11 | New app icon: Windows taskbar and Start menu entry, and macOS Dock and Finder `~/Applications/KalCode.app`. | Real signed 0.1.8 installs on the owner's Windows PC and Mac (no fixture). | New KalCode logo | X 5/5, video beat 6 |
| S12 | Settings > Updates showing "KalCode 0.1.8 build N" with the update status line. | Real signed 0.1.8 install, so N is the published build number. | Version shown with its build number | Blog, video beat 5 |
| S13 | [IF SILENT UPDATES SHIP] Settings > Updates before and after reopening: "0.1.8 build N", then "0.1.8 build N+1", with no update prompt in between. | Two published 0.1.8 builds on a real install; close and reopen KalCode. | Later builds install when you reopen KalCode | Video beat 5 |
| S14 | Operations > Activity: the heatmap and recent events for `kalcode` (run started, run finished, commits). | Fixture events and Git samples. | Activity view | Blog (optional) |
