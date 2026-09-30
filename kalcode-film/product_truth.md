# Product truth — KalCode launch film

Verified 2026-09-30 against the repository (main `f1da08b5`; the Stable 0.1.6 installers were
built from `b3b10093`, and the commits since then touch only the API, Stripe and the website) and against the live site
**kalcoded.com**. The full research, with every citation, is in `research/product_research.md`.
**Every on-screen statement in the film is listed here with its source. Anything not listed
here is not in the film.**

Legend: **S** = shipped and available on Stable 0.1.6 · **D** = depicted story content
(fictional, sanitized sample data, not a product claim).

## Claims the film makes

| # | On-screen claim / depiction | Status | Source |
|---|---|---|---|
| 1 | Product name **KalCode**; terminal-globe mark; KALCODE wordmark | S | `assets/branding/README.md`, `assets/branding/kalcode-*.png` |
| 2 | Brand tagline "One intelligence. A brighter tomorrow." | S | `assets/branding/kalcode-tagline.png`; live site footer |
| 3 | Colours Space `#05080f`, Constellation `#4c8dff`, status tones | S | `packages/ui/src/styles/tokens.css` (dark theme) |
| 4 | Fonts Lexend Deca, Lexend Exa, JetBrains Mono | S | `apps/desktop/dist/assets/*.woff2` (bundled by the app) |
| 5 | Sidebar: Dashboard, KalVoice, Code, Threads, Providers; Approvals, Notifications, Settings; "Version 0.1.6" | S | `apps/desktop/src/shell/navigation.tsx`, `Sidebar.tsx`; `crates/native-core/src/flags.rs` (Stable table) |
| 6 | A workspace is a project folder; sidebar "Workspace" switcher | S | `surfaces/code/CodeEmpty.tsx`, `shell/WorkspaceSwitcher.tsx` |
| 7 | Code surface: split panes, real terminals (PowerShell 7), Browser pane (Back / Forward / Reload, address, "Fit pane"), Dashboard as a pane | S | `shell/panes/model.ts`; `crates/native-core/src/workspaces.rs`; research §7–8 |
| 8 | Claude Code and Codex threads, run from the **Threads** surface ("One provider, one workspace, the permissions you choose.") | S | `crates/providers/src/catalog.rs`; `surfaces/threads/*`; research §6–7 |
| 9 | Several accounts per provider (e.g. "Personal", "Work"), each isolated and signed in separately | S | `surfaces/providers/ProviderAccountsView.tsx` ("Accounts stay isolated", "Signed in", "Default") |
| 10 | A Claude thread hits a usage limit: "Claude's usage limit was reached. Try again later." | S | `crates/providers/src/claude/normalize.rs:348` |
| 11 | You switch that thread to another account by hand: "Switch account" → "Rebind thread?" → "Switch to Work" → "Switched to Work" | S | `AccountSwitcher.tsx`, `RebindThreadDialog.tsx` |
| 12 | Several threads run in parallel in one workspace; **four** working at once (the depicted count) | S | `crates/resources/src/mode.rs:277` (`max_agents: 4`), `thread_commands.rs:284` |
| 13 | Threads share the workspace's working tree; their commits land on `main` | S | `crates/threads/src/runtime.rs:1533` (workdir = workspace root) |
| 14 | Thread status words: Starting, Thinking, Editing, Running a command, Ready, Needs approval | S | `surfaces/threads/model.ts:29-48`; emitted per adapter (research §7) |
| 15 | Dashboard summary "4 agents · 4 working · 0 waiting for you · 0 done · 0 idle" and chips All / Waiting for you / Working / Done / Idle | S | `surfaces/dashboard` (research §8) |
| 16 | KalVoice: hold **F8** (or hold the orb), speak, release; widget states Ready → Listening → Processing → Done; "Listening…"; live waveform | S | `crates/kalvoice/src/shortcuts.rs:17`; `kalvoice/FloatingAssistant.tsx`, `assistantState.ts` |
| 17 | KalVoice dictation types into the focused thread composer ("Message Claude Code"); "send that" sends it | S | research §9 (dictation targets; grammar "send that") |
| 18 | KalVoice speech runs on the device | S | `navigation.tsx` ("Speech and command interpretation stay on your computer."); whisper.cpp / llama.cpp |
| 19 | Approval card with "Deny", "Allow for workspace", "Allow for thread", "Approve once"; pushing to a remote always asks | S | `surfaces/permissions/labels.ts:91-104`; site mode table |
| 22 | The agents run the sample project's own release commands in its workspace (`pnpm test`, `git merge`, `pnpm build`, `wrangler deploy`, `pnpm test:e2e`); pushing waits on a KalCode approval | S (approval) · D (commands) | Approvals: `surfaces/permissions/labels.ts`; commands are sample-project data |
| 24 | CTA "Download KalCode"; "Start on Free. Upgrade any time."; **kalcoded.com**; Windows and macOS (Apple silicon) | S | live site buttons and pricing heading; `/download` |
| 25 | The workspace in the story is **atlas**, a fictional sample product (a pricing page, checkout, webhooks, search). The film does not depict KalCode building itself (the owner's direction, 2026-09-30) | D | Sample project data, labelled on screen |
| 26 | Thread titles, file names, terminal output, test counts, commit messages | D | Fictional and sanitized; "Sample project data" appears on screen |

## Deliberately NOT in the film (not shipped on Stable 0.1.6)

- **Provider threads inside Code panes.** This is gated (`ProviderPanes`). The agents appear in Threads.
- **Gemini CLI working.** Google withdrew personal sign-in, so its threads fail. It is never shown.
- **Automatic account failover.** `ProviderHandoff` is gated and `docs/PROVIDER_HANDOFF.md` says "planned — not built". The film shows the manual switch only.
- **Missions, Agents, Automations, or an autonomous planner or "ship it" button.** These are gated. The film shows supervised threads running the repo's own commands, gated by KalCode approvals.
- **More than 4 simultaneously working agents; six-agent swarm.** The brief's six lanes are reduced to the verified 4.
- **Worktrees, branches per agent, diff review, file tree, or code editor.** These are not built. The lanes converge as commits on `main`.
- **The status words "Testing", "Reviewing" and "Needs your reply".** No adapter emits them.
- **Voice thread creation ("open four Codex threads") and Fn push-to-talk.** These are gated or refused.
- **The in-app updater, and the phrase "Update available".** The film shows no KalCode update at all: 0.1.7 is unreleased, and in-app update on Windows 0.1.6 is broken.
- **KalCode building itself.** It was removed at the owner's direction.
- **Prices, plan limits, usage metrics, testimonials, performance numbers and "10x".**
- **Linux or Intel Mac.**
- **Third-party logos.** Claude Code, Codex, Cloudflare, Stripe and the others appear by name, in text only.
- **"Start free".** It isn't live wording; the film uses "Start on Free. Upgrade any time."

## Positioning lines (not factual claims)

"One cockpit for AI software development." — a metaphor from the approved brief. It is
consistent with the live hero "One intelligence that operates your entire AI workspace."
