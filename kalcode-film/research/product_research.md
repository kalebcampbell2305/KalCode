# KalCode product truth for the 60-second launch film

Researched 2026-09-30. Repo: `C:\Users\Kaleb\Downloads\KalCode`, branch `main`.

**Which commit this describes.** HEAD is `f1da08b5`, not `b3b10093`. `b3b10093` ("merge: B10 updater lease fix + version 0.1.6") is an ancestor of HEAD, and it is the source commit of the shipped 0.1.6 binaries (`docs/releases/0.1.6.md`). The commits after it touch only the API, Stripe and the website.

**Live site:** https://kalcoded.com, fetched with curl on 2026-09-30.

**Status legend**
- **SHIPPED** = available on the Stable 0.1.6 channel.
- **GATED** = implemented but hidden on Stable by `crates/native-core/src/flags.rs`.
- **NOT BUILT** = does not exist.
- **WEB-PREVIEW** = shown only in the website's scripted "Product preview · sample data".

All paths are relative to the repo root.

---

## 0. Feature flags on the Stable channel (`crates/native-core/src/flags.rs`)

How flags behave (`flags.rs:53-62`): `Available` is visible on every channel. `Preview` is hidden on Stable. `Gated` is visible only in Development builds.

**Surfaces** (`flags.rs:110-124`)

| Surface | State | Visible on Stable |
|---|---|---|
| Dashboard | Available | yes |
| KalVoice | Available (hidden only if the speech engine isn't compiled in; release builds include it, see §9) | yes |
| Code | Available | yes |
| Threads | Available | yes |
| Providers | Available | yes |
| Settings | Available | yes |
| Agents | Gated | no |
| Missions | Gated | no |
| Automations | Gated | no |
| Skills | Gated | no |
| Plugins | Gated | no |
| Memory | Gated | no |
| Command Center | Gated | no |

**Features** (`flags.rs:66-101`)
- **Available on Stable:** PaneSystem (the Code pane canvas), ProviderHealth, ProviderProfiles (multiple accounts), NotificationCenter, AccountSignIn.
- **Gated on Stable:** ContextDrop, UtilityDock, ResourceGovernor (only its *settings UI*; the governor itself still enforces limits, see §11), SessionLocator (search), ProcessContinuity, GitCore, TrustKernelExplain, AgentOrganization, Missions, Verification, TimeMachine, RemoteWorkspaces, Scheduler, DiffIntelligence, Automations, Memory, EnvironmentDoctor, Blueprints, CommandCenter, ProviderHandoff, BenchmarkLab, FailureAutopsy, WorkspaceHome, WorkspaceRail, **ProviderPanes**, ContextFirewall, HostKeyVerification, SafeRestore, AutomationKillSwitch.

---

## 1. Name, taglines, hero, navigation, footer (live homepage)

**Product name.** Written "KalCode" (camel K and C) in text and in `tauri.conf.json:3` (`"productName": "KalCode"`). The wordmark artwork reads **KALCODE** in wide caps; its A is drawn as a chevron with a blue glow. The site and app render the wordmark as a PNG alpha mask with the aria-label "KalCode" (`apps/desktop/src/shell/Brand.tsx:35`).

**Page metadata**
- `<title>`: "KalCode — One intelligence that operates your entire AI workspace"
- Meta description: "KalCode is a desktop workspace for the coding agents you already use. Connect Claude Code and Codex, run their threads at the same time, approve every action, and speak your prompts with KalVoice."
- og:image alt: "The KalCode globe with a terminal prompt, orbited by connected points of light, above the KalCode name and the line One intelligence. A brighter tomorrow."

**Hero** (from the homepage HTML)
- Left side text (decorative, aria-hidden): "Code / Reason / Automate / Create / Together."
- Right side text (decorative): "Built for a / brighter / tomorrow."
- Wordmark, then the tagline line **"Code the Future"**.
- H1: **"One intelligence that operates your entire AI workspace."** (the heading carries a visually hidden "KalCode: " prefix).
- Sub-line: "Connect Claude Code, Codex and the coding tools you already use — then operate them from one workspace."
- Buttons:
  - Primary **"Download KalCode"** links to `/download/windows-x64`, which serves `KalCode_0.1.6_x64-setup.exe` directly. On other operating systems, JavaScript sends the link to `/download#<os>` (`apps/website/src/scripts/download-route.ts`).
  - Secondary **"See it in action"** links to `#workspace`.
- Status line: "Windows · Stable 0.1.6 · 8.0 MB", then the link "All platforms and checksums".

**Main taglines**
- **"One intelligence. A brighter tomorrow."** (footer, OG image, and the brand board). App component: `Brand.tsx` `KalCodeTagline`.
- "One intelligence that operates your entire AI workspace." (H1, and `tauri.conf.json:53` shortDescription).
- "Code the Future" (hero lockup).
- Other homepage section heads:
  - "A real workspace. Not a chatbot."
  - "Every thread. One dashboard."
  - "You set the rules. Agents follow them."
  - "Your code. Your machine."
  - "Power for every builder."
  - "Be first to run KalCode."
  - "Speak it. See it done." (KalVoice)
  - "Complex goals. Coordinated agents." (labelled "Parallel agents · planned")

**Header navigation** (in order): Product · KalVoice · Pricing · Docs · Updates · Account · @KalCodeDev (X icon) · **Download** (primary button).

**Footer**
- Mark and wordmark, with the tagline "One intelligence." / "A brighter tomorrow."
- Columns:
  - Product: Product, KalVoice, Pricing, Download, Updates, Account
  - Docs: Overview, Permissions, Providers, KalVoice, Local-first
  - Legal: Security, Privacy, Terms
  - Follow: @KalCodeDev, @CampbellKaleb23 (the founder)
- Base line: "© 2026 KalCode" and "Stable 0.1.6 for Windows and macOS. More in development."

**Other pages**
- `/product` H1: "The workspace, piece by piece." Includes the "What is built today." table (§8).
- `/kalvoice` H1: "KalVoice: Speak your prompts with KalVoice." Also "Hold F8. Speak. Release."
- `/pricing` H1: "Pricing".
- `/account` H1: "Your KalCode account" ("Sign in with Google, Microsoft or a one-time email link.").
- `/docs`, `/docs/{permissions,providers,kalvoice,local-first}`, `/security`, `/privacy`, `/terms`.
- `/.well-known/kalcode-build.json` returns 404 on the live site, although commit 40cab1dd adds it; that commit may not be deployed.

---

## 2. Brand assets

**No KalCode logo exists as an SVG.** All brand art is raster, cut from the owner's two brand boards by `tooling/generate-brand-assets.py`. Its docstring says "The owner's brand boards are the brand … Nothing is redrawn." There is therefore no SVG path data for the mark. The only SVGs in the repo are third-party provider glyphs: `packages/ui/src/brand/providers/claude-spark.svg` and `openai-blossom.svg`. The Gemini glyph is `gemini-cli.png`.

**Master files (source of truth)**
- `packages/ui/src/brand/masters/kalcode-board.png` (1254×1254). A glowing blue wireframe globe with a white `>_` terminal prompt inside, orbited by connected points labelled IDE / AI / CODE / BUILD / TERMINAL / DEPLOY. Below it the KALCODE wordmark and "ONE INTELLIGENCE. A BRIGHTER TOMORROW." Also shows the icon and a horizontal lockup, plus board copy such as "GLOBAL AI CODING WORKSPACE", "BUILD WITHOUT BOUNDARIES" and "ONE WORKSPACE. ENDLESS POSSIBILITIES."
- `packages/ui/src/brand/masters/kalvoice-board.png` (1254×1254). A dotted blue sphere crossed by a wave ribbon (the KalVoice orb), the KALVOICE™ wordmark and "HUMAN VOICE. BRIGHTER POSSIBILITIES."

**Canonical mark:** the "terminal globe", described in `Brand.tsx` as "The KalCode symbol (terminal globe) isolated from the KalCode board".

**Production files in `assets/branding/`**
- KalCode:
  - `kalcode-symbol-{1024,512,256,128,64,32}.png` and `kalcode-symbol-source.png` (570²)
  - `kalcode-icon-{1024…32}.png` and `-source.png`
  - `kalcode-wordmark.png` (687×69)
  - `kalcode-tagline.png` (645×21)
- KalVoice:
  - `kalvoice-orb-{1024…32}.png` and `-source` (620²)
  - `kalvoice-icon-*`
  - `kalvoice-wordmark.png` (901×72)
  - `kalvoice-tagline.png` (749×23)

**Desktop app copies** (`apps/desktop/src/assets/brand/`)
- `kalcode-mark-{64,128,256}.png`, `kalcode-wordmark.png`, `kalcode-tagline.png`
- `kalcode-globe-{362,724}.{avif,webp}`
- `kalvoice-mark-*`, `kalvoice-globe-*`, `kalvoice-wordmark.png`, `kalvoice-tagline.png`

**Website copies**
- `apps/website/public/assets/brand/kalcode-mark-{64,128,256}.png`, `kalcode-wordmark.png`, `kalcode-tagline.png`, and the KalVoice equivalents.
- `apps/website/public/{favicon.ico,favicon-32.png,apple-touch-icon.png,og.png}`
- Hero art (not brand marks): `/assets/hero/orb-*.{avif,webp}` and `/assets/hero/world/world-*.{avif,webp}`.

**App and installer icons:** `apps/desktop/src-tauri/icons/` (`icon.ico`, `icon.icns`, `icon.png` 512², plus Square*Logo.png).

---

## 3. Design tokens (`packages/ui/src/styles/tokens.css`, shared by the desktop app and the website)

**Named palette** (`tokens.css:4-9`)

| Name | Hex | Role |
|---|---|---|
| Space | `#05080F` | base background (dark) |
| Hull | `#0B1322` | surfaces |
| **Constellation** | **`#4C8DFF`** | **accent, focus, live state (signature color)** |
| Starlight | `#E6EDF8` | primary text |
| Nebula | `#8593AB` | secondary text |

**Dark theme (the default)** (`tokens.css:178-289`)
- Backgrounds:
  - bg `#05080f`, bg-sunken `#03050b`
  - surface `#0b1322`, surface-raised `#101a2d`, surface-overlay `#121d33`
  - elevation steps: surface-1 `#09101d`, surface-2 `#0d1627`, surface-3 `#111c31`
  - code-bg `#070c17`
- Text: `#e6edf8` / secondary `#a8b4c9` / muted `#8593ab` / faint `#7a879e`
- Accent:
  - accent `#4c8dff`, hover `#6aa1ff`, pressed `#3a78ea`
  - accent-text `#8db6ff`, accent-icy `#a9c8ff`
  - glow `rgb(76 141 255 / .45)`
- Borders:
  - border `rgb(142 170 220 / .12)`, strong `/ .22`, subtle `/ .08`
  - focus `#4c8dff`
  - lit hairlines `rgb(92 150 255 / .55)` and soft `/ .26`
- Primary button: bg `#2a64e6`, gradient top `#2f6bec` → bottom `#2257d6`, white label, edge `rgb(170 205 255/.5)`, glow `rgb(76 141 255/.42)`.
- Gradients:
  - App backdrop: `radial-gradient(90rem 40rem at 78% -18%, rgb(76 141 255 / .075), transparent 62%), radial-gradient(60rem 30rem at -10% 110%, rgb(76 141 255 / .035), transparent 60%)`
  - Panel sheen: `linear-gradient(180deg, rgb(140 175 240 / .045) 0%, transparent 3.5rem)`
- Status tones:

  | Tone | Color |
  |---|---|
  | working | `#3ccf8e` (green) |
  | waiting | `#c7d1e0` |
  | muted | `#8593ab` |
  | done | `#eef3fb` |
  | failed | `#ef5f6b` |
  | paused | `#f2b544` (the only amber) |
  | recovering | `#5f9bff` |

  The legacy tones are live `#4c8dff`, waiting `#f2b544`, success `#35c48d` and danger `#ef5f6b`.

**Light theme** (`tokens.css:292-393`)
- bg `#f5f7fb` ("cool paper"), text `#0b1424` ("navy ink"), accent `#1d5be0`.

**Website additions** (`apps/website/src/styles/critical.css`)
- Hero ground `--site-night: #000104` (the artwork's black).
- Buttons are a white surface (`#ffffff` → `#e8eef8`, ink `#060a13`) with a halo that shifts from blue `76 141 255` to gold `255 181 84`.
- Button radius `0.8125rem`.
- theme-color meta: `#05080F` dark, `#F5F7FB` light.

**Radii** (`tokens.css:130-138`)
- xs 3px, sm 5px, md 7px, lg 10px, xl 14px, 2xl 18px, full 999px
- panel = 10px, control = 5px

**Fonts** (`tokens.css:29-32`)
- `--font-sans`: **"Lexend Deca Variable"** (all UI and display type)
- `--font-wide`: "Lexend Exa Variable"
- `--font-wider`: "Lexend Giga Variable" (website UI labels in caps, and the desktop gated pages)
- `--font-mono`: **"JetBrains Mono Variable"**
- Brand letter-spacing `--tracking-brand: 0.32em`. Label tracking `0.08em`.

**Font bundling: yes, self-hosted.**
- `packages/ui/src/styles/fonts.css` imports `@fontsource-variable/{lexend-deca,lexend-exa,lexend-giga,jetbrains-mono}` ("no network requests at runtime; works offline").
- Both `apps/desktop/src/main.tsx:1` and `apps/website/src/layouts/Base.astro:2` import it.
- Built woff2 files:
  - Desktop: `apps/desktop/dist/assets/lexend-deca-latin-wght-normal-Cz7ZdjVl.woff2`, `jetbrains-mono-latin-wght-normal-B9CIFXIH.woff2`, `lexend-exa-latin-wght-normal-bziMxHl4.woff2`, and others.
  - Live site preloads `/_astro/lexend-deca-latin-wght-normal.Cz7ZdjVl.woff2`.
  - Package source: `packages/ui/node_modules/@fontsource-variable/lexend-deca/files/lexend-deca-latin-wght-normal.woff2`.

---

## 4. Plans and pricing

**Code source of truth:** `packages/protocol/src/plans.ts:65-160`. Prices are US dollars per month.

| Plan | Price | Summary (verbatim) | KalVoice Requests / month |
|---|---|---|---|
| **Free** | $0 | "Everything you need to run your coding agents from one workspace." | 75 |
| **Pro** | $10 ("Recommended" on the site) | "For daily work across several agents and projects." | 1,500 |
| **MAX** | $25 | Site: "For heavy daily KalVoice use across many projects."; code: "For people who hand whole objectives to KalCode." | 5,000 |
| **MAX 2X** | $50 | "For sustained KalVoice use across demanding workflows." | 10,000 |

- **There is a free tier.**
- OWNER is a private, unlimited tier and is never listed.

**What the live site says**
- "Every plan includes": "All providers", "Plan, Approve and Auto modes", "Unlimited on-device dictation", "Dashboard and workspaces", "Your own AI account".
- **On Stable, plans differ only in KalVoice Requests.**
- Pricing page banner: "Paid plans are open · subscribe from your account".
- Plan cards on the homepage all say "Download KalCode". The pricing page button is "Choose a plan in your account", and its closing heading is "Start on Free. Upgrade any time."
- Checkout: "Checkout opens on Stripe's hosted page. Plans renew monthly until you cancel them from Manage billing."
- At the limit: "Dictation and everything else in KalCode keep working. KalVoice command requests pause until your monthly allowance resets or you change plans."
- **Inconsistent site copy.** The pricing FAQ still says "Do I need an account to join early access? No. Early access only needs an email address. KalCode accounts arrive with the paid plans at launch." This is stale next to "Paid plans are open".

**Catalog lines in code that are not true on Stable (do not film them)**
- `plans.ts` Free highlight: "Every permission mode, including Bypass and Custom". Threads can't start in Bypass or Custom on 0.1.6.
- Pro/MAX highlights: "Persistent agents…", "Scheduled automations, skills and plugins", "Advanced missions with verification". All GATED.
- `concurrentThreads` 2/8/20 is not enforced (`apps/website/src/pages/pricing.astro:36-41`, confirmed in §11).

---

## 5. Platforms (live `/download`, and `apps/website/src/data/releases.json`)

- **Windows x64: SHIPPED.**
  - Stable 0.1.6, published September 30, 2026.
  - `KalCode_0.1.6_x64-setup.exe`, 8.0 MB (7,965,176 bytes).
  - SHA-256 `515b559d…e911`. Listed as "Code-signed".
  - Requires "Windows 10 (1809) or later, 64-bit".
  - Button: **"Download for Windows"**.
- **macOS Apple silicon (arm64): SHIPPED.**
  - `KalCode_0.1.6_arm64.dmg`, 14.1 MB.
  - Requires "macOS 14 or later, Apple silicon". Listed as "Code-signed" (Developer ID, notarized).
  - Button: **"Download for macOS"**.
- **Intel Mac or universal build: NOT BUILT.** `docs/releases/0.1.6.md:52` says "Intel Mac, universal Mac, Linux | No release artifact."
- **Linux: NOT BUILT.**
  - Page text: "Not yet available — Not available yet. Linux builds need a Linux build machine and have not been tested."
  - There is an early-access email form ("Join early access").
- Homepage closing section: "KalCode 0.1.6 is out for Windows and macOS."

---

## 6. Providers and accounts

**Display names** (`crates/providers/src/catalog.rs:19,43,71`): exactly **"Claude Code"**, **"Codex"**, **"Gemini CLI"**. These are the only three.

**Claude Code: SHIPPED.** Certified for 2.1.282 and later 2.1 releases.

**Codex: SHIPPED.**
- Certified for 0.155.1 through 0.158.
- Runs on personal ChatGPT plans only (Free, Go, Plus, Pro). Not Business, Enterprise or Edu (`/docs/providers`).

**Gemini CLI: code present, but unusable in practice. Do not feature it.**
- The adapter is implemented and not code-blocked (`catalog.rs:213`, `registry.rs:143-155`).
- The site and release notes say "Gemini CLI is currently unavailable in KalCode" (Google ended Sign in with Google access for personal accounts on June 18, 2026).
- Sign-in can succeed, but threads then fail with: "Google no longer lets Gemini CLI use {account}. Use Claude Code or Codex." (`crates/providers/src/gemini/mod.rs:211-227`).
- Homepage status reads "Unavailable in 0.1.6". Claude Code and Codex read "Adapter built".

**Several accounts per provider: SHIPPED** (ProviderProfiles is Available).
- Each account gets its own managed provider profile ("Accounts stay isolated", `ProviderAccountsView.tsx:68`).
- Account names are typed by the user, for example "Personal" / "Work". Names like "Codex B" appear only in examples.

**Providers › Accounts labels** (`apps/desktop/src/surfaces/providers/ProviderAccountsView.tsx`)
- "Connect a {Provider} account" / "Connect another {Provider} account" (:121)
- "Add provider account" (:255)
- "Add and sign in" (:227)
- "Set default" (:411)
- "Default" badge (:343)
- "Active threads" (:350)
- "Workspace default in" (:354)
- "Sign in" / "Sign out" / "Refresh"
- "Signed in" / "Signed out" / "Not checked"
- "Waiting for browser sign-in to finish…" (:361)

**How threads get an account** (`NewThread.tsx:614-628`)
- Order: the workspace's remembered account, then the provider default, then the first account.
- New thread checkbox: **"Remember these accounts for this workspace"** (:513).
- A thread keeps its account for life. It changes only through an explicit confirmed switch.

**Switching a thread's account** (`AccountSwitcher.tsx`, `RebindThreadDialog.tsx`)
- Account menu in the thread header, titled **"Switch account"**.
- Confirmation dialog **"Rebind thread?"**:
  - "Switch future messages to {to}?"
  - "Past conversation history remains unchanged. Only future provider requests use {to}."
  - Button "Switch to {to}".
- Success toast: "Switched to {X}" / "Future messages use {X}. Past history is unchanged."
- Also available from the command palette ("switch codex b") and from KalVoice. Both still require the confirmation.

**Usage-limit pause, then another account continues: NOT BUILT (automatic).**
- `docs/PROVIDER_HANDOFF.md:2`: "Status: **planned — not built.**"
- The `ProviderHandoff` flag is GATED.
- `docs/releases/0.1.6.md:21`: "A thread never changes account on its own."

**What exists today for usage limits**
- **Claude:** detects a usage limit. The thread gets "Claude's usage limit was reached. Try again later." (`claude/normalize.rs:348`), then the turn ends as "Last turn failed".
- **Gemini:** detects rate limit and quota errors.
- **Codex:** never detects them. From `codex/stream.rs:22-24`: "KalCode never reports a Codex rate limit".
- **Providers › Health:** row "Rate limit", with "None reported" / "{name} reported a rate limit" and the summary "Backing off · rate limit reported". Tracked per provider, not per account.
- **Recovery is manual.** The user can switch the thread to another signed-in account, and it continues in a new provider session.

---

## 7. Workspaces, Code surface and threads

**Workspace = a project folder** (`surfaces/code/CodeEmpty.tsx`)
- "Open a project folder to work in it with real terminals."
- Button **"Open folder…"**, plus a "Recent workspaces" list.

**Workspace switcher in the sidebar** (`shell/WorkspaceSwitcher.tsx`)
- Caption "Workspace" above the workspace name. Shows "No workspace" when none is open.
- Dropdown "Workspaces" with "Open folder…".
- Many workspaces are remembered, but **only one is active** at a time.
- The workspace **rail** is GATED (WorkspaceRail). So is the "Home" view (WorkspaceHome).

**Code surface (pane canvas): SHIPPED** (PaneSystem is Available)
- Hard limits (`shell/panes/model.ts:17-21`): **`MAX_PANES = 32`** per layout, depth 8, **32 tabs per pane**.
- Terminals: **12 per workspace**. At the limit: "A workspace can have up to 12 terminals. Close one to open another." (`crates/native-core/src/workspaces.rs:35,700`).
- Browser views: **at most 8** across the app.
- Toolbar:
  - "New terminal", tooltip "New {shell} terminal (Ctrl Shift `)"
  - "Layout" / "Arrange panes": "2 panes", "3 panes", "4 panes (2 × 2)", "6 panes (3 × 2)"
  - "Even out sizes", "Reopen closed pane"
- Pane header: **"Split right"**, and "Pane actions" with **"Split down"**, "Maximize", "Collapse", "Move to the dock", "Close pane".
- Close tooltip: "Close pane — it keeps running".
- Keyboard: Ctrl+Alt+D splits right, Ctrl+Alt+Shift+D splits down. Divider drag resizes.
- Empty pane: "Empty pane" / "Open something here. Closing a pane never stops what runs in it." with an "Open Browser" button.
- Things you can open in a pane on Stable: a terminal (shell of your choice), "Browser", "Dashboard", and widgets ("Needs your approval", "Active agents", "Provider health", "Activity", "Terminals", "Runtime health").
- Shells:
  - Windows: "PowerShell 7", "Windows PowerShell", "Command Prompt", "Git Bash"
  - macOS: "Zsh", "Bash", "Fish", "sh"

**Provider threads inside Code panes (Claude Code or Codex running in a terminal pane): GATED** (ProviderPanes).
- On Stable, a thread in a saved layout shows "This thread isn't a pane here" with an "Open in Threads" button.
- **On Stable, provider threads live only in the Threads surface.**
- The homepage itself says "provider panes not in Stable yet".

**Terminals after a restart**
- The layout and tabs come back. The shells do not.
- Tab message: "This terminal ended when KalCode closed", with a "Restart" button.

**Threads: SHIPPED**
- Definition: "A thread is a persistent unit of AI work: one provider session (Claude Code, Codex, …) running in one workspace under one permission mode." (`crates/threads/src/lib.rs:3-4`)
- Surface header: "Threads" / "One provider, one workspace, the permissions you choose." with a **"New thread"** button.
- New thread form: "Provider", "Account", "Model", "Workspace", "Permissions", "Task" (placeholder "Describe what you want done"), **"Start thread"**, "Ctrl Enter to start".
- Thread detail:
  - Composer placeholder "Message {Provider}", button "Send".
  - Buttons: "Interrupt", "Resume", "Stop", "Archive".

**Thread status labels as shown in the Threads surface** (`apps/desktop/src/surfaces/threads/model.ts:29-48`)

| Label | Meaning |
|---|---|
| "Starting" | |
| "Working" | |
| "Thinking" | |
| "Running a tool" | |
| "Running a command" | |
| "Editing" | |
| "Testing" | |
| "Reviewing" | |
| "Recovering" | |
| **"Ready"** | idle |
| **"Needs approval"** | |
| "Needs your input" | |
| "Waiting on another task" | |
| "Paused" | |
| "Completed" | |
| "Failed" | |
| "Stopped" | |
| "Offline" | |

Additional thread states: "Waiting for system resources", "Not started", "Last turn failed".

**Dashboard chip labels** (`packages/ui/src/components/StatusChip.tsx`): "Working", "Permission required", "Waiting for you", "Done", "Idle", "Paused", "Failed", …

**Which statuses each provider actually emits**
- **Claude Code:** Working (start), Thinking, Editing (file writes), Running a command (Bash/PowerShell/git/package installs), Running a tool, then Ready.
- **Codex:** Thinking, Running a command, Running a tool, Editing, then Ready.
- **Gemini CLI:** Thinking, Running a command, Editing, Running a tool, then Ready.
- **No adapter emits "Testing" or "Reviewing".**
- "Needs approval" comes from KalCode's permission gate, for every provider.
- "Needs your input" is emitted only by provider panes, which are GATED. **Stable threads never show it.**

**The website's preview uses different labels. Do not quote them as app UI.**
- The site's scripted preview uses "Running command", "Editing files", "Needs your reply", "Needs approval", "Reviewing", "Testing", "Idle", "Thinking".
- "Running command", "Editing files" and "Needs your reply" are defined in `surfaces/dashboard/data/status.ts:40-59` but **never rendered** in the app.

---

## 8. Desktop navigation, Dashboard, Browser, Terminal

**Sidebar on Stable, top to bottom** (`apps/desktop/src/shell/Sidebar.tsx`, `navigation.tsx`)
1. KalCode mark and wordmark.
2. Workspace switcher.
3. **Search** (`Ctrl K`). Command palette placeholder: "Search workspaces and commands".
4. Main destinations (icons are from lucide):

   | Label | Icon | Notes |
   |---|---|---|
   | **Dashboard** | LayoutDashboard | shows a "needs you" count badge |
   | **KalVoice** | AudioLines | |
   | **Code** | Code2 | |
   | **Threads** | MessagesSquare | |
   | **Providers** | PlugZap | |

5. Footer:

   | Label | Icon |
   |---|---|
   | **Approvals** | ShieldCheck, or ShieldAlert with a count |
   | **Notifications** | Bell / BellDot |
   | **Settings** | Settings gear |

6. Build text "Version 0.1.6", and a collapse toggle (Ctrl B).

- **Not on Stable (GATED):** Home, Project, Agents, Missions, Automations, Skills, Plugins, Memory, Command Center. In dev builds they appear under "In development".
- **There is no top-level "Browser" destination.** The browser is a pane inside Code.

**Dashboard** (`surfaces/dashboard`)
- Title "Dashboard". Description: "Every agent KalCode runs, live: what it is doing, and what needs you."
- Summary line: "{n} agents · {n} working · {n} waiting for you · {n} done · {n} idle"
- Filter chips: **"All", "Waiting for you", "Working", "Done", "Idle"**.
- "Group by" options: Status / Project / Provider. Status groups: "Needs you", "Working", "Done", "Idle".
- Card actions: "Open", "Pause", "Resume", "Retry", "Stop", "Archive".
- Right-hand widget dock: "Needs your approval", "Active agents", "Provider health", "Activity", "Terminals", "Runtime health".
- Empty state: "No sessions yet" / "…This build tracks sessions started from Threads; a CLI you run yourself in a Code terminal isn't tracked."
- **The website's preview KPIs ("Working now", "Waiting for you", "Completed today", "Terminals") are illustrative.** The site labels them "the KPI tiles are illustrative".

**Browser pane: SHIPPED**
- A real Tauri native webview inside Code. Default address `http://localhost:3000/`.
- Any http(s) URL is allowed. Pop-ups are denied.
- Controls: "Back", "Forward", "Reload" / "Stop loading", "Web address".
- Viewport presets: "Fit pane", "Desktop", "Laptop", "Tablet", "Mobile", "Custom".
- Menu: "Copy URL", "Open externally".

**Terminal pane: SHIPPED**
- xterm.js with a 5000-line scrollback. Real PTY via the vendored `portable-pty`.

**/product "What is built today." table (live)**
- Built:
  - App shell, search and palette, themes
  - Workspaces and real terminals
  - Claude Code, Codex and Gemini CLI adapters
  - Dashboard
  - Approvals and permission modes
  - KalVoice dictation and commands
  - Split panes and the Browser pane
- Planned:
  - File tree, Git and diff views
  - Agents, Missions, Automations

---

## 9. KalVoice

**Stable status: SHIPPED.** Release builds compile the on-device Whisper engine. `tooling/release/build-windows.mjs:67,94-110` sets `kalvoice-whisper`, and a stable build fails without it. `docs/MACOS.md:110` confirms the same for macOS.

**How you activate it**
- **Hold F8** (`crates/kalvoice/src/shortcuts.rs:17`). Push to talk: hold, speak, release.
- Can be rebound to F1–F24, Pause, Scroll Lock or Insert.
- **Fn is explicitly refused:** "Fn can't be the push-to-talk key: on this system it never reaches apps, so KalCode can't detect it." The `feat/fn-push-to-talk` branch has no commits of its own.
- The key works **only while KalCode is the active window**. In the background the widget shows "Ready when in front" / "F8 works while KalCode is the active window."
- You can also **press and hold the orb** in the widget header.
- Hint text: **"Hold F8 to talk to KalVoice."** Orb tooltip: "Hold to talk (or hold F8)".

**On-device**
- Speech to text: whisper.cpp through whisper-rs. The default model is `tiny.en`, "English (fastest)".
- Command interpretation: a local llama.cpp `llama-server` running Qwen3.5-0.8B, "about 850 MB", prepared automatically.
- There is no provider or cloud fallback. Audio is never stored or uploaded.

**Dictation: SHIPPED, unlimited**
- Types into the focused Claude Code or Codex thread composer, a terminal, the command palette or search, or any KalCode text box.
- The target is fixed when the key goes down.
- **In a terminal it never presses Enter.** Message: "KalVoice never presses Enter in a terminal. Press Enter yourself to run it."

**The widget (the orb)** (`kalvoice/FloatingAssistant.tsx`, `Visuals.tsx`, `assistantState.ts:200-208`)
- A floating widget, docked at the top by default.
- It shows the KalVoice brand orb (the wave sphere). The halo glows with live mic level, and a 28-bar waveform appears while listening.
- It shows the "KALVOICE" wordmark and a status dot.
- State labels: **"Ready", "Listening", "Processing", "Executing", "Done", "Error"**. The transcript area shows "Listening…" while you talk.
- A "Type it instead" button appears after a spoken command.
- Result card titles: "Done", "Connect a provider", "Monthly limit reached", "Needs attention".

**Grammar** (`crates/kalvoice/src/grammar.rs`, `grammar_sessions.rs`). Verbatim example forms:
- **Send / clear** (free, never counted): "send that" / "submit it" / "press send"; "clear that" / "never mind" / "don't send that".
- **Tell / ask a thread:** "tell Authentication to run the tests", "ask Research why the build failed". The prompt is passed through as spoken. Examples from the docs: "Research on Codex B", "Tell it to continue".
- **Go back:** "go back", "back to the previous thread".
- **Status:**
  - "what are my threads doing", "what is running", "give me a status report"
  - Reply: "N threads: X working, Y need you, Z approvals waiting."
- **Approvals:**
  - "what needs permission?", "show pending approvals", "does anything need my approval"
  - Replies: "Nothing is waiting for your approval." / "1 approval is waiting for you."
- **Threads by state:**
  - "open the one that failed", "which threads are stuck", "what failed", "show me the failed one"
  - Ambiguous matches get "Which one — {A, B or C}?"
- **Dashboard filters:** "show working agents", "show everything waiting for me", "show completed threads", "clear filters". Reply: "Showing working agents on the Dashboard."
- **Navigation:** "go to the dashboard", "open settings", "take me to providers". Reply: "Opened {Surface}." (for example "Opened Settings.")
- **Pause / resume / stop:** "pause every active thread", "resume all threads", "stop the {name} thread". Replies: "Paused 3 threads." or "No threads were working, so there was nothing to pause."
- **Create threads:** "open two Codex threads", "start a Claude Code thread in workspace X".
  - On Stable this depends on provider panes. The answer is **"Provider panes are unavailable in this build."**
  - Treat "Open four Codex threads" as **GATED** (the UI example chip for it appears only when panes are on).
- **Terminals:** "open a terminal", "new terminal in {workspace}". Reply: "Opened a terminal in {ws}."
- **Workspaces:** "open the {name} workspace", "switch to project X". Reply: "Opened the {name} workspace."
- **Open a thread:** "open thread X", "focus on the X thread".
- **Panes:**
  - "split this pane left and right", "split the pane vertically", "put Claude and Codex side by side", "make this bigger", "close this pane", "maximize"
  - Replies: "Split the pane side by side.", "Made the pane bigger.", "Closed the pane. What it runs keeps running."
- **Browser:**
  - "open the browser", "open localhost 3000", "reload the page", "go back in the browser"
  - Replies: "Opening the browser." / "Opening {url} in the browser."
- **Switch account:** "switch this Codex thread to Codex B", "use Codex Work for this thread". Reply: "Confirm in KalCode to switch “X” to Codex B."
- **Permission mode:** "switch thread X to plan mode". KalVoice opens the thread but doesn't change the mode itself.
  - Bypass is refused: "KalVoice can't turn on Bypass. Only you can, in the thread's permission menu."
- **Search:** "search for X", "what was I working on yesterday". GATED on Stable. Reply: "Search isn't available in this version, so KalVoice can't look that up."
- **Filler words** "hey kal", "please", "can you", "thanks" and similar are stripped.
- UI example chips: "Go to settings", "Open Dashboard", "What needs permission?", "Pause every active thread".

**Metering**
- Each top-level command counts as one KalVoice Request (Free 75 / Pro 1,500 / MAX 5,000 / MAX 2X 10,000). Dictation, "send that" and "clear that" are free.
- At the limit: "You've used this month's KalVoice Requests. They reset {day}. Dictation keeps working."

**Strings the film should not use.** These are not in the app: "Command recognised", "Typed into Claude Code", "Hold to talk" (as a hero line), "Planning Three steps across two agents". They come from the website's scripted demo. The multi-agent part of that demo is labelled "Multi-agent runs not in Stable yet".

---

## 10. Updates and releases

**In-app strings** (`apps/desktop/src/shell/UpdateReadyNotice.tsx`, `surfaces/settings/UpdaterSettings.tsx`, `updaterModel.ts`)
- Update card: **"KalCode 0.1.7 is ready to install."** (format "{name} is ready to install.") / "Your work stays open until you restart."
- Card buttons: **"Restart to update"** · "Later" · "Details".
- Confirmation: "Restart to update?" / "KalCode will close running threads, terminals and KalVoice, then restart into {target}." with "Cancel" and "Restart and install {version}".
- Settings › Updates:
  - "Update channel" (Stable / Beta)
  - "Check for updates", then "Checking for updates", "Downloading KalCode {v}" / "Downloading and verifying the signed release.", **"KalCode is up to date"**
  - "Verified previous version", "Restore previous version"
- **The app never says "Update available".**
- Background checks run every 6 hours.

**Feed:** `https://kalcoded.com/releases/updater/{stable,beta,dev}.json` (`crates/updater/src/lib.rs:55-57`). This is a custom fail-closed updater, not the Tauri updater plugin.

**Signing**
- Update packages are **minisign**-signed. The trusted comment is checked for version, platform and channel.
- Windows installer: **Authenticode** through Microsoft Azure Artifact Signing (`tooling/release/signing.mjs`), NSIS per-user `-setup.exe`.
- macOS: **Developer ID and Apple notarization** (`notarytool`, ticket stapled) (`tooling/release/macos-package.mjs`). Hardened runtime.
- Updates page: "A signed installer for Windows and a signed, notarized app for Apple silicon."

**Known issue (do not feature)**
- Windows 0.1.6 in-app Update and Restore previous version don't work. The cause is ERROR_SHARING_VIOLATION when launching the installer; the fix is planned for 0.1.7.
- The site states it on `/download` and `/updates`.
- macOS in-app update works.
- **Only show the updater flow on macOS, or show the Settings panel without acting.**
- `docs/releases/0.1.6.md:9,13` still claims in-app updates work and doesn't mention the Windows defect, so the release notes are stale.

---

## 11. Multiple agents at once

**Several Claude Code and Codex threads in one workspace at the same time: SHIPPED.**
- There is no per-workspace lock. The only guard is "This thread is already running." (`crates/threads/src/runtime.rs:1591`).
- Meta description on the site: "run their threads at the same time".

**How many at once: 4 actively working turns.**
- The Resource Governor wraps every provider unconditionally (`apps/desktop/src-tauri/src/thread_commands.rs:284`).
- The Stable default is Balanced, `max_agents: 4` (`crates/resources/src/mode.rs:277`). The governor's settings UI is GATED, so Stable users can't change the mode.
- The count is per working turn. Idle threads don't hold a slot.
- A fifth turn waits and shows "Waiting for system resources": "KalCode is waiting for system resources (4 of 4 threads are already working)…" If the wait runs out (about 90 s) it shows "Not started".
- The plan limit `concurrentThreads` (2/8/20) is **not enforced**.

**Shared working tree: yes, no worktrees.**
- Each thread's working directory is the workspace root (`runtime.rs:1533`).
- Worktree binding is not built (`crates/contracts/src/threads.rs:281-282`). Git worktree commands are GATED behind GitCore.

**Permissions and approvals: SHIPPED**
- **Start modes:** "Plan", "Approve", "Auto".
  - "Bypass" and "Custom" are shown as Planned on the site ("Plan, Approve and Auto in Stable 0.1.6 · Bypass and Custom planned").
  - Settings can save them as a default for new threads, but a thread then starts in Approve.
- **Approval buttons, in order:** **"Deny", "Allow for workspace", "Allow for thread", "Approve once"** (`surfaces/permissions/labels.ts:91-104`).
- Sidebar "Approvals" panel with a count. The Dashboard widget is "Needs your approval".
- Pushing to a git remote always asks, whatever the mode ("Push to a remote … Approval required" on the site's mode table).

**Orchestration, missions, agent teams, automations, scheduled or event-triggered runs, automatic shipping: GATED / NOT BUILT on Stable.**
- The site labels them "Parallel agents · planned" / "Planned · missions are not in the app yet".
- The film can show several parallel threads that a person supervises. It cannot show an autonomous planner running agents.

---

## 12. Tech stack (for a "real software" moment)

- **Top level:** `apps/` (api, desktop, website) · `crates/` (20 Rust crates) · `packages/` (protocol, testing, ui) · `tooling/` · `third_party/` · `docs/` · `assets/`.
- **The 20 crates:** context, contracts, doctor, entitlements, git, hook-bridge, kalvoice, locator, native-core, notifications, permissions, providers, pty, resources, secure-store, threads, timeline, updater, utilities, workspace-ui.
- **Rust:** edition 2024, rust-version 1.89, stable toolchain. SQLite through rusqlite. PTY through vendored wezterm `portable-pty`.
- **Desktop:** **Tauri 2.11** plus **React 19.3**, **TypeScript 7.0**, **Vite 8.3**, xterm.js 6, cmdk, Radix, lucide. Tests use Vitest 5 and Playwright.
- **Website:** **Astro 7.3** on **Cloudflare Workers** (worker `kalcode-website`) with **D1** (`kalcode-web`) and **R2** (`kalcode-releases`).
- **API:** Cloudflare Worker `kalcode-api` at api.kalcoded.com with D1. Payments use **Stripe** (hosted checkout, API version `2025-03-31.basil`).
- **On-device AI:** whisper.cpp (whisper-rs) and llama.cpp running Qwen3.5-0.8B.
- **Tooling:** pnpm 10, Node 22.12 or later, Biome.
- **Size** (tracked files, excluding third_party and marketing):

  | Language | Files | Lines |
  |---|---|---|
  | Rust | 436 | ≈232k |
  | TS | 816 | ≈88k |
  | TSX | 192 | ≈41k |
  | CSS | 88 | ≈28k |
  | Astro | 77 | ≈7k |

  The repo has 720 commits.
- **Bundle:** identifier `com.kalcode.desktop`, binary `kalcode`, main window title "KalCode", window background `#05080f`.

---

## 13. Public URL and call-to-action wording (verbatim)

- URL: **kalcoded.com** (note the "d"). X accounts: **@KalCodeDev**, founder **@CampbellKaleb23**.
- Buttons on the site:
  - **"Download KalCode"** (hero and closing sections)
  - **"Download"** (header)
  - **"Download for Windows"** / **"Download for macOS"** (download page)
  - "See it in action"
  - "Explore the product"
  - "All platforms and checksums" / "All platforms"
  - "Meet KalVoice"
  - "Compare plans"
  - "Choose a plan in your account"
  - "Join early access" (Linux)
  - "Release notes"
- Line under the download button: "Windows · Stable 0.1.6 · 8.0 MB".
- **"Start free" does not appear anywhere.** The nearest line is "Start on Free. Upgrade any time." (closing heading on the pricing page).

---

## 14. "Built with KalCode" or KalCode building itself

- **Nothing on the live site.** A search of every fetched page (home, product, kalvoice, pricing, download, updates, docs/*, security, account) found no "built with KalCode", "builds itself" or dogfooding claim.
- The repo has no such claim either. The only near match is a comment in `apps/website/src/components/stage/ScrollStory.astro:3`, "the window builds itself as you scroll".
- If the film shows KalCode shipping itself (an owner choice), the source can back up an honest version. The KalCode repo is a Rust, Tauri, React and Astro monorepo that could be opened as a KalCode workspace, with Claude Code and Codex threads running in it. That would be new footage, not an existing public claim.

---

## 15. Stale README claims and other contradictions

**`README.md` (46 lines)**
- **Line 6** lists "Claude Code, Codex, Gemini CLI" as connected providers. Gemini is unavailable in 0.1.6.
- **Line 11**: "Status: private development. Campaign Z0 — Foundation." In fact 0.1.6 is a public Stable release (`docs/releases/0.1.6.md:3`: "first Stable release").
- **Lines 15-24**: the repository table leaves out `apps/api`, `packages/testing`, `third_party` and 18 of the 20 crates.
- **Line 24**: describes tooling as only brand, protocol and capture scripts. It also holds the release, signing and notarization pipeline.
- **Line 28**: says "Node 24+" (real minimum: `>=22.12`) and "Rust 1.88+" (real: `rust-version = "1.89"`).
- **Line 29**: says "webkit2gtk-4.1 on Linux", which implies Linux is supported. There is no Linux build.

**Other source contradictions**
- `docs/releases/0.1.6.md:9,13` says in-app updates work, which is false on Windows.
- The `plans.ts` Free highlight says "Every permission mode, including Bypass and Custom", but on Stable a thread only starts in Plan, Approve or Auto.
- `plans.ts` Pro/MAX highlights describe gated features.
- `navigation.tsx:51`: Code is "restored after a restart", but only the layout comes back, not live shells.
- `navigation.tsx:57`: Threads "run Claude Code, Codex or Gemini CLI", but Gemini is unusable.
- Pricing FAQ: "KalCode accounts arrive with the paid plans at launch" / "early access", but paid plans are open.
- The website's scripted previews use status strings ("Running command", "Editing files", "Needs your reply"), pane-based provider threads, Gemini and missions that the Stable app doesn't show. The site labels each preview as sample data or planned.

---

## Film guardrails

**Safe to show as Stable 0.1.6**
- Windows x64 and macOS Apple silicon.
- Claude Code and Codex threads, several running in parallel in one workspace (up to 4 working at once), with per-account sign-in and an account switcher.
- The Dashboard with the chips "All / Waiting for you / Working / Done / Idle".
- Approvals: "Deny / Allow for workspace / Allow for thread / Approve once". Modes: Plan / Approve / Auto.
- The Code pane canvas with split panes, real terminals and the browser pane.
- KalVoice on F8, on-device, with the orb widget ("Ready" → "Listening" → "Processing" → "Done"), dictation, and the commands listed in §9 (not the thread-creation ones).
- The 0.1.7 update card on macOS.

**Do not show as Stable**
- Provider threads inside Code panes.
- Gemini CLI working.
- Missions, agents or automations; an autonomous planner or "ship it" flow.
- Bypass or Custom mode.
- Automatic account failover when an account hits a usage limit.
- An Intel Mac or Linux build.
- A Windows in-app update.
- Fn push to talk.
- "Update available".
- "Start free".
