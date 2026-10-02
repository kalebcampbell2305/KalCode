# KalCode 0.1.9 launch kit

Posting is manual; nothing here posts automatically.

## Before posting anything (gate)

1. https://kalcoded.com/releases/updater/stable.json serves `0.1.9+N`, and kalcode-e6 has reported its live verification.
2. https://kalcoded.com/download offers `KalCode_0.1.9_buildN_x64-setup.exe` and `KalCode_0.1.9_buildN_arm64.dmg`.
3. https://kalcoded.com/updates#release-0-1-9 opens the 0.1.9 entry.
4. **KalVoice agent launch: PENDING** until kalcode-e6 reports the stepping-stone production check (typed KalVoice "start a codex agent" starts a Codex session pane in the installed app). Don't publish the film or any "KalVoice starts agents" copy before then.
5. Re-run the accuracy table below against e6's packaged-app QA. Drop any line that QA didn't prove, from the copy and the posts. The film needs a re-cut only if it shows that line.

## Files

| File | Use |
| --- | --- |
| [`whats-new.md`](whats-new.md) | What's New summary (blog sidebar, email body, docs) |
| [`announcement.md`](announcement.md) | One-liner, short launch post, long announcement |
| [`social.md`](social.md) | X thread, single post, LinkedIn, Reddit/Discord |
| [`website-copy.md`](website-copy.md) | Updates entry and roadmap flips |
| [`updater-notes.template.md`](updater-notes.template.md) | In-app update notes (filled by the release lead) |
| [`INVENTORY.md`](INVENTORY.md) | Change audit: AVAILABLE vs COMING SOON |

Videos (local, not committed), from the film in `C:/kc-019-film/film-0.1.9/out/`:

| File | Use |
| --- | --- |
| `KalCode_0.1.9_launch_1080p60.mp4` | Master. YouTube, website, LinkedIn, blog header |
| `KalCode_0.1.9_launch_vertical_1080x1920.mp4` | Shorts, TikTok, Reels |
| `KalCode_0.1.9_30s_1080p60.mp4` | X post 1/6 |
| `KalCode_0.1.9_15s_vertical.mp4` | Stories |
| `KalCode_0.1.9_cover_1920x1080.png`, `_1280x720.png` | YouTube thumbnail, link cards |

## Post order

| # | When | Where | Copy | Asset |
| --- | --- | --- | --- | --- |
| 1 | T+0 | Blog / email | announcement.md > Long | master video |
| 2 | T+0 | X @KalCodeDev, pin 1/6 | social.md > X thread | 30 s cut + stills |
| 3 | T+30 min | LinkedIn | social.md > LinkedIn | master video |
| 4 | T+1 h | YouTube + Shorts | title "KalCode 0.1.9: one place to actually run AI engineering" | master + vertical, cover |
| 5 | T+1 h | Reddit / Discord | social.md > Reddit | link only |

## Accuracy table (every claim in the copy and film)

| Claim | Class | Evidence |
| --- | --- | --- |
| Command Deck | AVAILABLE IN 0.1.9 | #68 |
| Agent Fleet: worktree per agent, Ready to merge, Commit changes | AVAILABLE IN 0.1.9 | #76 |
| Provider Dock: chips, health, menu move, drag + confirm | AVAILABLE IN 0.1.9 | #75 |
| KalVoice: open/focus scene targets, "open it"/"that one", launch agents with account/model/effort, prompt an agent, chooser, spoken callbacks | AVAILABLE IN 0.1.9. Agent launch is **PENDING**: e6's stepping-stone production check (typed "start a codex agent" in the installed app on macOS) must pass before the film ("SAY IT. KALCODE STARTS IT.") or any launch claim is published | #67, #79 |
| KalTidy, Account Hub, Accounts list | AVAILABLE IN 0.1.9 (first shipped in 0.1.8+944) | #63, #64, #61 |
| Effort saved per thread | AVAILABLE IN 0.1.9 | #67 |
| Close ends terminal/agent; F8 refocus | AVAILABLE IN 0.1.9 (first shipped in 0.1.8+923) | #55, #57 |
| Monthly/yearly in app; plan limits; KalVoice meter | AVAILABLE IN 0.1.9 | #70, #77, #78 |
| Claude Code + Codex | AVAILABLE | Gemini CLI unavailable (known issue) |
| Squads, Handoffs, Brainstorm, Live Browser Studio, Deploy, Remote, more autonomy | COMING SOON | plans.ts `coming_soon` |
| More providers | COMING SOON | no Gemini support in production |
