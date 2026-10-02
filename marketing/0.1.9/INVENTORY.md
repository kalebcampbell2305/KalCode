# KalCode 0.1.9: change inventory (0.1.8 → 0.1.9)

**Baseline:** the first public 0.1.8 is build 901, at commit `6867475` (published 2026-10-01 15:11Z).
**Release candidate:** `main` at or after `fced50d5`, plus #79 (KalVoice finish), kalcode-a9's responsiveness pass and this version bump. The release lead (kalcode-e6) cuts, QAs, publishes and verifies it.
**Live on Stable at audit time (2026-10-02 17:40Z):** 0.1.8+923. B14 (0.1.8+944) is mid-publish.

Status key:
- **AVAILABLE**: merged and in the 0.1.9 candidate, and enabled on Stable (`crates/native-core/src/flags.rs`: Dashboard, Operations, KalVoice, Code, Threads, Providers and Settings are Available; everything else is Gated). A line is final only after e6's 0.1.9 QA and live verification.
- **COMING SOON**: a `coming_soon` entry in `packages/protocol/src/plans.ts`, or gated on Stable.

## Available in 0.1.9

| # | Feature | PR / commit | What users can do | Surface | Shipped first in | In video |
|---|---|---|---|---|---|---|
| 1 | **Command Deck** | #68 `81db65cb` | See what's working, what needs you and what's shipping. The top bar shows workspace, branch ±changes, environment, mode, Ctrl/⌘K and working/needs-you counts. The left rail has Projects, the right rail Agents, and the bottom strip builds, tests, provider health and shipping. | main shell | 0.1.9 | HERO |
| 2 | **Agent Fleet** | #76 `ea9c8cdd` | Live cards with call signs (Claude A, Codex B), account, branch ↑ahead, current action, files and needs-you. Each agent runs in its own worktree and branch. READY TO MERGE is computed from Git facts. Commit changes. Card → thread morph. | Dashboard | 0.1.9 | HERO |
| 3 | **Provider Dock** | #75 `fced50d5` | Every connected account is a chip in the status strip, with health and running threads. Move a thread to another account from the menu, or drag it and confirm. Never auto-switches. | status strip | 0.1.9 | YES |
| 4 | **KalVoice controls your workspace and agents** | #67 `ecc25915` | Open or focus threads, terminals, agents, Operations runs and services by voice. Follow-ups ("open it", "that one"). Start Claude Code / Codex agents on signed-in accounts with model and effort. Send a prompt to an agent. Asks when ambiguous. Speaks when an agent finishes, fails or needs you. | KalVoice | 0.1.9 | HERO |
| 5 | **Reasoning effort saved per thread** | #67 (migration 0021) | A thread keeps its Claude Code / Codex reasoning effort across restarts. | Threads | 0.1.9 | quick |
| 6 | **KalVoice sign-in reminders + cancellable push-to-talk start** | #79 (open) | Reminders follow provider health immediately. Releasing the key or pressing Esc during a slow start cancels it. | KalVoice | 0.1.9 | no (fix) |
| 7 | **KalTidy** | #63 (944) | One click stops idle terminals safely. Use the broom in the Code toolbar, the palette, or KalVoice ("close all idle terminals"). Review dialog. Agents, services, Operations work and the focused terminal are never stopped. | Code | 0.1.8+944 | YES |
| 8 | **Account Hub** | #64 (944) | Name and plan at the foot of the sidebar, with a menu: Account & plan, Usage (KalVoice meter), Billing, providers, KalVoice, Settings, Sign out. | sidebar | 0.1.8+944 | YES |
| 9 | **Providers › Accounts redesign + consistent account identity** | #61 (944) | Dense list grouped by provider, with health, sign-in, quick actions and details. The same account names appear everywhere. Shows "Not reported" instead of guessing. | Providers | 0.1.8+944 | YES (multi-account) |
| 10 | **Plan limits across KalCode** | #70 `82a1b06f` | Plan limits on open terminals, workspaces, provider accounts and parallel agents. Hitting one never closes anything. | everywhere | 0.1.9 | no (pricing) |
| 11 | **KalVoice Requests allowance shown first** | #70 | Remaining first, then used, a bar and the real reset date. | Account Hub / Settings | 0.1.9 | quick (meter) |
| 12 | **Monthly or yearly plans in the app** | #78 `a1bf68c2` | Onboarding offers Monthly or Yearly for Pro, MAX and MAX 2X. | onboarding | 0.1.9 | no |
| 13 | **Free run history** | #77 `0ea063eb` | Free shows the 10 most recent finished runs. | Operations | 0.1.9 | no |
| 14 | **Closing a terminal or agent pane ends it** | #55 (923) | Nothing keeps running in the background after you close it. | Code | 0.1.8+923 | quick |
| 15 | **F8 push to talk after refocus (Windows)** | #57 (923) | F8 works again within about 0.5 s of KalCode regaining focus. | KalVoice | 0.1.8+923 | quick |
| 16 | **Mascot icon on the Windows installer** | #60 (923) | | installer | 0.1.8+923 | no |
| 17 | **Responsiveness pass** | kalcode-a9 perf/instant-ui (PR TBD) | TBD: wording comes from a9's measured results only. | app-wide | 0.1.9 | "faster" only if measured |

Internal only (not user-facing): #62, #69 and #73 (tests), #72 and #74 (policy docs), #59 (marketing), #56 and #65 (website release PRs).

## Not available in 0.1.9 (never shown as live)

- Gated on Stable: Agents surface, Missions, Automations, Skills, Plugins, Memory, Command Center, GitCore UI, Session Locator, Remote Workspaces, Time Machine.
- Gemini CLI is still unavailable (a known issue since 0.1.6). Production providers are **Claude Code and Codex**, so the film and copy say "More providers coming".
- Brainstorm, Launch Recipes, Live Browser Studio, Advanced Code, Favorites, quick switcher and smart terminal naming: `coming_soon`.

## Coming soon (plans.ts `coming_soon`; chosen for the film)

| Film word | plans.ts id | Plan from |
|---|---|---|
| SQUADS | `squads`: Squads, reusable agent teams | MAX |
| HANDOFFS | `handoff-chains`: Agent Handoff Chains | MAX |
| BRAINSTORM | `brainstorm`: AI Brainstorm to implementation brief | Free |
| LIVE BROWSER STUDIO | `browser-studio` | Pro |
| DEPLOY | `deploy`: KalCode Deploy | MAX |
| REMOTE | `remote`: KalCode Remote | MAX |
| MORE AUTONOMY | `keep-working` / `auto-routing` | MAX 2X |
| MORE PROVIDERS | Gemini unavailable; no plan row | n/a |

## Roadmap flips after 0.1.9 is verified live (status only; plans and values unchanged)

- `agent-fleet` → available, verifiedIn `0.1.9+N` (#76).
- `kaltidy` → available, verifiedIn `0.1.8+944` or `0.1.9+N` (#63), unless e6 flips it after 944.
- `kalvoice-followups` ("Contextual follow-ups and completion callbacks") → available, only if e6's 0.1.9 QA proves follow-ups and spoken callbacks in the packaged app.
- Leave `kalvoice-agents` (it includes Browser voice control, and Browser is not proven), `account-hub` (the "Usage Center" part doesn't exist) and `identity` as coming soon.

## Data and rollback

#67 adds migration 0021 (`threads.effort`). It first ships in the stepping-stone 0.1.8+N build. After it updates the data, Restore previous version only goes back to builds that can open it.

## Delivery (owner decision 2026-10-02)

- A stepping-stone **0.1.8+N** build ships first. It carries every feature above (#79, #82, #83 included) plus the silent-for-all updater, and is cut from release/0.1.8-stepping.
- **0.1.9** is then cut from main. Clients already on 0.1.8+N get it when they close KalCode. Clients on an earlier 0.1.8 build or 0.1.7 get one prompted update straight to 0.1.9. After that, every update installs on close.
