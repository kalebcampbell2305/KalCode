# KalCode 0.1.8 announcement copy

Final copy for KalCode 0.1.8 (build 901), live on 2026-10-01. Every sentence maps to a row in the Fact sources table in [`LAUNCH.md`](LAUNCH.md#fact-sources), checked against release commit `6867475421761476d0103ee733115732538ac532`.

Links:

- Download: https://kalcoded.com/download (serves `KalCode_0.1.8_build901_x64-setup.exe` and `KalCode_0.1.8_build901_arm64.dmg`)
- Release notes: https://kalcoded.com/updates#release-0-1-8

Do not add: prices, Gemini CLI, Agents, Missions, Automations, provider panes, an effort control, "instant" or "real-time" speech or any KalVoice speed figure, health checks for deployed sites, or anything from a later 0.1.8 build (the F8 refocus fix, closing a terminal ends it). Those later fixes may be mentioned only as "coming in the next update".

---

## Long version (blog post / email)

**Subject:** KalCode 0.1.8: Operations, a new logo, and a steadier KalCode

**Preheader:** Queue, confirm and follow your project's work in one place. On Windows and macOS.

KalCode 0.1.8 is out for Windows and macOS.

### Operations

The biggest addition in 0.1.8 is Operations, a new page in the sidebar that follows your project's work from the queue to its result.

Add work to the queue: an agent task, a build, a test run, a script, a deploy, a release, a background command or a service. Give it a priority and the tasks it depends on. KalCode shows you a confirmation before anything runs, and it never reruns work on its own after a restart; the queue pauses instead.

Operations has five views:

- **Runs** keeps each run's status, output log and history, plus the files a command reports as its outputs.
- **Queue** lists waiting work in order. Anything already running opens straight to its run.
- **Services** shows the processes and ports in your workspaces. You can stop or restart the services Operations started; anything started elsewhere is view-only.
- **Environments** shows Local, Preview, Staging and Production for each workspace. KalCode doesn't check the health of deployed sites, so a deploy is labeled unverified.
- **Activity** shows recent run events and commits.

### Terminals you can read at a glance

When you focus a terminal pane, a quick blue trace runs once around its edge and leaves a thin blue outline. It never loops, and it's skipped when reduced motion is on. Amber now means one thing: a thread or terminal is waiting for you, for example for a permission answer.

Terminal limits now follow your plan. Free and Pro keep 12 terminals per workspace; MAX and MAX 2X have no KalCode limit. Reaching the limit never closes a terminal you have open, and the message tells you your plan and its limit.

### KalVoice

KalVoice now checks and prepares your on-device speech model once per take, before the microphone opens, and keeps that same model for the whole take instead of repeating the setup. If your computer runs low on memory while you're recording, KalVoice stops the recording and tells you, and KalCode keeps running. When the widget shows a lasting problem, it stays in its own band instead of covering the pane controls below it.

### Fixes and updates

- **Windows:** fixed a freeze where the KalCode window could stop responding when keyboard focus moved away from it. This affected 0.1.6 and 0.1.7 on Windows.
- **New logo:** the KalCode mascot is now the app icon on Windows and macOS and the logo inside the app.
- **Build numbers:** Settings > Updates shows the version with its build number, for example "0.1.8 build 901".
- **Updates without a prompt, from 0.1.8 on:** later builds of 0.1.8 download and verify in the background, then install when you close KalCode, so your next launch runs them. Settings > Updates says "Installs when you close KalCode." A new version still asks first.
- **Safer going back:** Restore previous version only goes back to a build that can open your data.

### How to get it

- **From 0.1.7:** KalCode offers 0.1.8 as an update. Choose Restart to update, or Settings > Updates > Restart and install. This one-time prompt is how you move to the new version; later 0.1.8 builds install on close.
- **Windows, from 0.1.6:** download the installer from kalcoded.com/download and run it once over your current copy. Your workspaces, threads, settings and sign-ins are kept.
- **macOS, from 0.1.6:** update from inside the app.
- **New to KalCode:** download it for Windows 10 (1809) or later on x64, or macOS 14 or later on Apple silicon.

Once 0.1.8 has updated your data, going back to 0.1.7 with Restore previous version isn't offered, because 0.1.7 can't open the updated data; a restore that would reach it stops and leaves your data unchanged.

After you update, KalVoice's on-device intelligence can take a few minutes to get ready.

KalCode works with Claude Code and Codex through your own provider accounts. Provider usage is billed by your provider.

Download: https://kalcoded.com/download
Full release notes: https://kalcoded.com/updates#release-0-1-8

---

## Short version (about 90 words; newsletter blurb, store-style "What's new", in-app or site banner)

KalCode 0.1.8 is out for Windows and macOS. New: Operations. Queue agent tasks, builds, tests and deploys with priorities and dependencies, confirm them, and follow each run's log, outputs, services and environments in one place. Focused terminals get a blue trace, and amber now means a thread or terminal is waiting for you. Terminal limits follow your plan. KalVoice gets ready once per take, and low memory no longer closes KalCode. Also new: a Windows freeze fix and the new KalCode logo. https://kalcoded.com/download

## One-liner

KalCode 0.1.8: Operations, plan-based terminal limits, a steadier KalVoice and a new logo, on Windows and macOS. https://kalcoded.com/download
