# Storyboard — KalCode launch film (60.000 s, 1920×1080, 60 fps, 120 BPM)

**Thesis:** software development has too many windows; KalCode turns them into one engineering
cockpit. **Arc:** fragmentation → one window → your surfaces → your accounts → parallel agents →
voice → the live build loop → gated release → KalCode built inside KalCode → download.

**Recurring system — LANES → CONVERGENCE → SHIP.** Each agent thread is a horizontal lane of
Constellation-blue light. Work that passes travels along its lane as a light packet and
lands as a commit on one `main` line. A failure turns the lane red and stops its packet; the
fix resumes it. In the pipeline, `main` becomes a single rail through the release gates, and
the last gate fires the ship hit. The same light carries through: the logo's orbit glow, the lanes,
the pipeline and the end card are one visual device.

**Timing rule:** every scene boundary lands on a bar line (one bar = 2 s = 120 frames). The
brief's 0:23 / 0:31 / 0:37 / 0:43 / 0:55 are mid-bar, so they are moved to the nearest bar line
(22 / 30 / 36 / 42 / 54). All events come from `cue_sheet.json`.

| # | Bars | Time | Scene | Picture | Copy | Sound |
|---|---|---|---|---|---|---|
| 1 | 1–3 | 0:00–0:06 | **Chaos** | 18 windows pop in on an accelerating 8th/16th grid: terminals running claude and codex on two accounts, a browser, docs, `git log`, test output, a dev server, deploy, chat. Focus (a lit border) jumps to each new window; the others dim and defocus by depth. The camera drifts and creeps in. At 5.25 s everything anticipates outward and then accelerates inward to one point with streak blur. From 5.75 s: black. | "Too many windows." (2.0) · "Too much context switching." (3.5) | Fragmented 3-against-4 ticks, a detuned pop per window, a tense E/F drone, a riser, a reverse swell into **half a beat of silence** |
| 2 | 4–5 | 0:06–0:10 | **Introducing KalCode** | **HIT at 6.000.** Light flashes from the point, a shock ring expands, and the terminal-globe mark blooms on a spring. The headline rises word by word on the motif; the positioning line follows. From 9.0 the camera pushes forward and the mark recedes as the product window arrives. | "Introducing KalCode." (6.5) · "One cockpit for AI software development." (8.0) | Sub impact + **sonic logo** (B4 E5 F♯5 B5, FM bell), Em9 pad, a pulse re-entering on bar 5 |
| 3 | 6–8 | 0:10–0:16 | **Your workspace** | The KalCode window, real IA: sidebar (Dashboard, KalVoice, Code, Threads, Providers), workspace **kalcode**, the KalVoice widget docked at the top. The Code surface opens a PowerShell terminal (`pnpm dev:website`). Split right → Browser pane on `localhost:4321`. Split down → a Dashboard pane. Then the nav moves to **Threads**, where a Claude Code and a Codex thread are listed. The camera leans toward each new pane; the layout snaps clean at 15.0. | Lower third, one per beat pair: "Your project." (11) "Your terminals." (12) "Your browser." (13) "Your agents." (14) | Controlled groove starts (kick, hats, 8th bass, one arp); pane-snap clicks; terminal key texture |
| 4 | 9–11 | 0:16–0:22 | **Claude Code + Codex** | Providers › Accounts: a Claude Code card and a Codex card, each with **Personal** and **Work** accounts, "Signed in". Threads route to accounts along light lines. One Claude thread hits "Claude's usage limit was reached. Try again later." (red). "Switch account" → "Rebind thread?" → **Switch to Work** → toast "Switched to Work" → the thread is Working again. | "Claude Code. Codex. Every account." (17) · "Switch accounts. Keep going." (20.5) | Second arp layer, clap backbeat; route pings; the fail blip on the limit; a confirmation on the switch |
| 5 | 12–15 | 0:22–0:30 | **Four agents, one project** (hero 1) | Dashboard with "0 agents" → four lanes launch on the beat: **Desktop UI** (Claude Code · Personal), **API** (Codex · Personal), **KalVoice** (Claude Code · Work), **Website** (Codex · Work). Each card cycles through real status words (Starting → Thinking → Editing → Running a command → Ready). Stack labels travel with each lane. The summary reads "4 agents · 4 working". The API lane's test fails (red, packet stops), then is fixed and passes. Packets land on `main` as commits. At 28.0 the UI dims under one word. | "Different tasks." (25) · "Same project." (26) · **"Parallel."** (28, huge) | One motif note and one arp layer per launch; test-pass dyads; the fail blip; a kick+sub hit on "Parallel.", then a snare lift and riser |
| 6 | 16–18 | 0:30–0:36 | **KalVoice** | **Drop at 30.000**, into a calm close-up. The KalVoice widget (orb, KALVOICE, state) with an **F8** keycap. The key goes down → "Listening" → the 28-bar waveform and orb halo breathe → the transcript streams "Redesign the download page hero." Release → "Processing" → the text flies into the Website thread's composer ("Message Claude Code"). A second hold, "send that" → "Done" → the thread turns Working. | "Say the task." (34) · "KalVoice." (35) + caption "Hold F8. Speech stays on your device." | Sub impact, half-time groove, the mic-on tone (a rising fifth), sparse bell echoes while listening, mic-off, a route ping |
| 7 | 19–21 | 0:36–0:42 | **Build it. See it.** | The Code surface splits into three panes: the terminal (Astro dev server, `update /src/pages/download.astro`), the Browser pane at `localhost:4321/download`, and a Dashboard pane with the thread card. CODE → BUILD → BROWSER as one spatial left-to-right flow. The browser reloads (spin + air sweep); the redesigned hero morphs in; the thread goes Ready. | "Build it." (40) · "See it." (41) | Groove returns with syncopated bass; key texture; the air sweep on reload; a confirmation dyad |
| 8 | 22–25 | 0:42–0:50 | **Build. Test. Ship.** (hero 2) | The four lanes converge into `main`, and `main` becomes a rail through seven gates, each labelled with the repo's real command: review (Codex) → `pnpm test` → `git merge` → `pnpm release:build` (signed) → **approval** (`git push origin main`: Deny / Allow for workspace / Allow for thread / **Approve once**) → `pnpm release:publish` → `wrangler deploy` → `pnpm release:verify`. Each gate lights only after it passes. **SHIP at 48.000.** Then kalcoded.com/updates shows the release, and a macOS KalCode window shows "KalCode 0.1.7 is ready to install." / "Restart to update". | "Build." (43) "Test." (45) "Ship." (48) | Peak groove (6 arps); motif climbs one note per gate; a rising tonal pulse; riser; **ship impact**; motif |
| 9 | 26–27 | 0:50–0:54 | **Built inside itself** | The camera pulls back: it was the **kalcode** workspace all along. A stack map attaches real labels to the monorepo: apps/desktop (Tauri · React · TypeScript), apps/website (Astro · Cloudflare Workers), apps/api (Cloudflare Workers · Stripe), crates/ (Rust), crates/kalvoice (whisper.cpp · llama.cpp). The sidebar's "Version 0.1.6" ticks to "Version 0.1.7". | "Build KalCode." (51) · "Inside KalCode." (52) | Pullback: drums out, low-passed pad, the motif an octave down, confirmation on the version tick |
| 10 | 28–30 | 0:54–1:00 | **End card** | Everything collapses toward the centre into the lane light, and the mark resolves (55.0). Tagline (56.0). The **Download KalCode** button (57.0) with "Start on Free. Upgrade any time." Then **kalcoded.com** and "Windows · macOS (Apple silicon)" (57.5). Held still, breathing, to 60.000. | "One intelligence. A brighter tomorrow." · "Download KalCode" · "Start on Free. Upgrade any time." · "kalcoded.com" · "Windows · macOS (Apple silicon)" | Inward swell → **full sonic logo** over E major add9 → a quiet confirmation on the CTA → decays to silence at 60.000 |

## Vertical (1080×1920)

The vertical cut is recomposed, not cropped. Headlines are set larger and centred in the upper
third. Cockpit shots frame the relevant region of the window: the camera targets the active
pane. Lanes stack as four rows under the Dashboard header. The pipeline runs top-to-bottom.
The end card is stacked vertically.

## Social cuts

- **30 s:** Introduce (from the hit) → Parallel → KalVoice → Ship → End card.
- **15 s:** Hit → Parallel → Ship → End card.

Both are cut on bar lines, and both use their own audio conform on the same bar grid.
