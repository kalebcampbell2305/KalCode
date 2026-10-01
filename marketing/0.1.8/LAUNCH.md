# KalCode 0.1.8 launch checklist

KalCode 0.1.8 (build 901) is live: https://kalcoded.com/download serves `KalCode_0.1.8_build901_x64-setup.exe` (signed) and `KalCode_0.1.8_build901_arm64.dmg` (signed, notarized). Release notes: https://kalcoded.com/updates#release-0-1-8. Release commit: `6867475421761476d0103ee733115732538ac532`.

Copy: [`announcement.md`](announcement.md) (long, short, one-liner) and [`social.md`](social.md) (X, LinkedIn, Reddit, Discord). Posting is manual; nothing here is posted automatically.

## Assets

Videos are local files in `C:\Users\Kaleb\Videos\KalCode-0.1.8-launch\`:

| File | Use |
| --- | --- |
| `KalCode_0.1.8_60s_1080p60.mp4` | Landscape master (1920x1080, 60 fps). X, LinkedIn, email/blog header. |
| `KalCode_0.1.8_60s_vertical_1080x1920.mp4` | Vertical. Phone-first feeds, Stories, Shorts. |
| `KalCode_0.1.8_30s_1080p60.mp4`, `KalCode_0.1.8_15s_1080p60.mp4` | Only if produced. Use the 30 s cut where a feed autoplays short clips; otherwise use the master. |

Screenshots are in `marketing/0.1.8/screenshots/`, one per shot in [`screenshots.md`](screenshots.md). If the files land with other names, match them by shot ID.

| Shot | File |
| --- | --- |
| S1 | `screenshots/s01-operations-queue.png` |
| S2 | `screenshots/s02-operations-run.png` |
| S5 | `screenshots/s05-operations-environments.png` |
| S6 | `screenshots/s06-focus-trace.png` |
| S7 | `screenshots/s07-amber-waiting-dark.png` |
| S9 | `screenshots/s09-kalvoice-low-memory.png` |
| S11 | `screenshots/s11-app-icon.png` |
| S12 | `screenshots/s12-settings-updates.png` |

Before posting, check each image against the `screenshots.md` rules: version reads 0.1.8, mascot logo, no emails, tokens, real account names or private paths, no Gemini CLI or gated surfaces.

## Post order

| # | When | Where | Copy | Asset |
| --- | --- | --- | --- | --- |
| 0 | Before anything | Check https://kalcoded.com/download offers both build 901 files and https://kalcoded.com/updates#release-0-1-8 opens the 0.1.8 notes. Play both videos to the end. | | |
| 1 | T+0 | Blog / email list (if sending) | `announcement.md` > Long version | Header: `KalCode_0.1.8_60s_1080p60.mp4` (or S1 as a still) |
| 2 | T+0 | X, @KalCodeDev: 5-post thread. Pin post 1. | `social.md` > X thread | 1/5 master video; 2/5 S1 + S2; 3/5 S6 + S7; 4/5 S9; 5/5 S11 |
| 3 | T+15 min | X, @CampbellKaleb23: quote-post thread post 1 with one line in your own words | | none |
| 4 | T+30 min | LinkedIn company page | `social.md` > LinkedIn | `KalCode_0.1.8_60s_1080p60.mp4` |
| 5 | T+30 min | Discord / community announcement channel | `social.md` > Discord | S1 |
| 6 | T+1 h | Reddit r/ClaudeAI (founder account; check flair and showcase rules first) | `social.md` > Reddit | S1 + S5 in the post, or text-only if images aren't allowed |
| 7 | Next day | Reddit r/SideProject (same rules check) | `social.md` > Reddit | S1 |
| 8 | Any time after #2 | Vertical feeds (Stories, Shorts) | `announcement.md` > One-liner | `KalCode_0.1.8_60s_vertical_1080x1920.mp4` |

Stay in the replies for the first two hours after #2 and #6.

## Alt text

| Asset | Alt text |
| --- | --- |
| `KalCode_0.1.8_60s_1080p60.mp4` / vertical | KalCode 0.1.8 release film, no voice-over. Terminal panes with Claude Code and Codex, KalVoice splitting a pane by voice, the new Operations page with Runs, Queue, Services, Environments and Activity, the blue terminal focus trace, and the new mascot icon. Ends on kalcoded.com. |
| S1 | KalCode Operations page, Queue tab: four waiting items in order, a Claude Code task, pnpm build, pnpm test that depends on the build, and Deploy preview that depends on the tests. |
| S2 | KalCode Operations page, Runs tab: a finished pnpm test run with its status, exit code, the end of its output log, and the file dist/app.zip listed as an output. |
| S5 | KalCode Operations page, Environments tab: cards for Local, Preview, Staging and Production. Preview shows a deployed branch marked unverified. |
| S6 | Two terminal panes in KalCode. The right pane was just focused, and a blue trace is running around its edge. |
| S7 | KalCode Threads list with one thread waiting for a permission answer, shown with an amber needs-you badge. |
| S9 | KalVoice widget with the message: Your computer is low on memory, so KalCode couldn't keep this recording. Close some apps, then try again. KalCode is still open behind it. |
| S11 | The new KalCode app icon, a mascot on a dark tile, in the Windows taskbar and the macOS Dock. |
| S12 | KalCode Settings, Updates section, showing KalCode 0.1.8 build 901. |

## Reply lines

- **Known issue (KalVoice):** "After updating, KalVoice's on-device intelligence can take a few minutes to get ready. Give it a moment and it'll pick up on its own."
- **Coming from 0.1.7:** "0.1.7 asks once: choose Restart and install (or Settings > Updates). After that, new 0.1.8 builds install when you close KalCode."
- **Windows on 0.1.6:** "0.1.6 can't install updates on Windows. Download the installer from kalcoded.com/download and run it over your copy; your data is kept."
- **Intel Mac / Linux:** "Not yet. 0.1.8 is Windows 10 (1809)+ x64 and macOS 14+ on Apple silicon."
- **Gemini CLI:** "Still unavailable in KalCode. Claude Code and Codex work today."
- **Push-to-talk focus or closing terminals:** "A fix is coming in the next update." (Don't describe it as part of 0.1.8 build 901.)
- **Deploy health:** "Operations doesn't check deployed sites yet, so deploys are labeled unverified."

## Fact sources

Every launch claim, checked at release commit `6867475` (`6867475421761476d0103ee733115732538ac532`). Paths are repository-relative.

| Claim | Source (file:line at 6867475) |
| --- | --- |
| Operations is available on Stable | `crates/native-core/src/flags.rs:114` |
| Five views: Runs, Queue, Services, Environments, Activity | `apps/desktop/src/surfaces/operations/OperationsPage.tsx:334-336`; `docs/OPERATIONS.md:73,78,82,86,91` |
| Queue agent tasks, builds, tests, scripts, deploys, releases, background commands, services | `apps/desktop/src/surfaces/operations/OperationsPage.tsx:109` |
| Priority and dependencies; Run now can't skip a blocked dependency | `docs/OPERATIONS.md:12,79-80` |
| Nothing runs until you confirm it | `docs/OPERATIONS.md:22-32` |
| A restart never reruns work; the queue pauses | `docs/OPERATIONS.md:38-39` |
| Services: stop/restart only for services Operations started | `docs/OPERATIONS.md:82-85` |
| Environments: Local to Production; deploys unverified | `docs/OPERATIONS.md:86-90` |
| Blue focus trace, plays once, skipped with reduced motion | `apps/desktop/src/shell/panes/PaneCanvas.module.css:66-112` |
| Amber means waiting for you | `apps/desktop/src/shell/rail/Rail.module.css:410`; `apps/desktop/src/surfaces/code/panes/Panes.module.css:212`; `apps/desktop/src/surfaces/threads/model.ts:20` |
| Free and Pro: 12 terminals per workspace | `apps/desktop/src-tauri/src/account/model.rs:66,107-121` |
| MAX and MAX 2X: no KalCode limit; unverified plan gets Free | `apps/desktop/src-tauri/src/account/model.rs:104-115`; `crates/native-core/src/workspaces.rs:34-35` |
| Limit message names the plan; nothing is closed | `crates/native-core/src/workspaces.rs:775-783` |
| Limit also applies to KalVoice and Operations terminals | `apps/desktop/src-tauri/src/kalvoice_executor.rs:1503-1504`; `apps/desktop/src-tauri/src/operations_commands.rs:310-313` |
| KalVoice prepares the model once per take, before the mic opens | `crates/kalvoice/src/voice.rs:26,30`; `docs/KALVOICE.md:109-114` |
| Low memory stops the recording instead of closing KalCode | `crates/kalvoice/src/audio.rs:36-40,53` |
| Widget no longer covers pane controls | commit `de7bc694` ("reserve the widget's band for a problem it keeps open"), ancestor of 6867475 |
| Windows freeze on focus changes fixed | `Cargo.toml:25-26`; `third_party/tao/KALCODE_PATCH.md:1-15` |
| Mascot is the app icon and in-app logo | `apps/desktop/src/shell/Brand.tsx:14,64`; `apps/desktop/src-tauri/tauri.conf.json:56` |
| Public version 0.1.8 | `apps/desktop/src-tauri/tauri.conf.json:5` |
| "0.1.8 build N" in detailed views | `apps/desktop/src/platform/version.ts:2-4` |
| Later same-version builds stage in the background and install when KalCode closes | `apps/desktop/src-tauri/src/updater_commands.rs:659-663,757-775`; `apps/desktop/src-tauri/src/lib.rs:989` |
| Not during logoff or shutdown | `apps/desktop/src-tauri/src/updater_commands.rs:758-761,1375` |
| Settings > Updates: "Installs when you close KalCode." | `apps/desktop/src/surfaces/settings/updaterModel.ts:51,99-101` |
| A new version (0.1.7 to 0.1.8) still asks: "Restart and install" | `apps/desktop/src/surfaces/settings/updaterModel.ts:95-101`; `apps/desktop/src/surfaces/settings/UpdaterSettings.tsx:148`; `apps/desktop/src/shell/UpdateReadyNotice.tsx:105,133`; the 0.1.7 client has no install-on-close path (`UpdaterSettings.tsx:147` at tag `candidate/0.1.7-B11-7d33abe`) |
| Restore previous version only reaches a build that can open your data | `apps/desktop/src-tauri/src/updater_commands.rs:1630-1651` |
| Platforms, upgrade paths, Gemini CLI known issue, provider billing | `docs/releases/0.1.8+901.md:7-11,33,40-41,44` (release notes on `main`, bound to 6867475) |
| Download files and notes anchor live | https://kalcoded.com/download, https://kalcoded.com/updates#release-0-1-8 (checked 2026-10-01) |
| KalVoice on-device intelligence can take a few minutes after updating | Owner-confirmed known issue for the 0.1.8 launch |

Not in 0.1.8 build 901, so not announced: the F8 push-to-talk refocus fix and "closing a terminal ends it" (both merged after 6867475 and ship in a later 0.1.8 build).
