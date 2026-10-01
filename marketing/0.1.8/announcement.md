# KalCode 0.1.8 announcement copy

Sources: `target/recovery-B12-release/notes/0.1.8.draft.md` (release notes draft) and the claim list in `video-script.md`. Every sentence below maps to a shipped change.

Do not add: prices, Gemini CLI, Agents, Missions, Automations, provider panes, effort control, "instant" or "real-time" speech claims, or health checks for deployed sites.

---

## Long version (blog post / email)

**Subject:** KalCode 0.1.8: Operations, a new logo, and a steadier KalCode

**Preheader:** Queue, run and follow your project's work in one place. Now on Windows and macOS.

KalCode 0.1.8 is out for Windows and macOS.

### Operations

The biggest addition in 0.1.8 is Operations, a new page in the sidebar that follows your project's work from the queue to its result.

Add work to the queue: an agent task for Claude Code or Codex, a build, a test run, a script, a deploy, a release, a background command or a service. Give it a priority and the tasks it depends on. KalCode asks you to confirm before anything runs, and it never reruns work on its own after a restart.

Operations has five views:

- **Runs** keeps each run's status, output log and history, plus the files a command reports as its outputs.
- **Queue** lists waiting work in order. Anything already running opens straight to its run.
- **Services** shows the processes and ports in your workspaces. You can stop or restart the services Operations started.
- **Environments** shows Local, Preview, Staging and Production for each workspace. KalCode marks a deploy as unverified, because it doesn't yet check the health of deployed sites.
- **Activity** shows recent run events and commits.

### Terminals you can read at a glance

When you focus a terminal pane, a quick blue trace runs once around its edge and leaves a thin blue outline. Amber now means one thing: a thread or terminal is waiting for you, such as a permission answer.

Terminal limits now follow your plan. Free and Pro keep 12 terminals per workspace; MAX and MAX 2X have no KalCode limit. Reaching the limit never closes a terminal you have open.

### KalVoice

KalVoice now checks and prepares your on-device speech model once per take, before the microphone opens, and uses that same model for the whole take. If your computer runs low on memory while you're recording, KalVoice stops the recording and tells you. It no longer takes KalCode down with it. And when the widget shows a problem, it stays in its own band instead of covering pane controls.

### Fixes and updates

- **Windows:** fixed a freeze where KalCode could stop responding when keyboard focus moved away from it.
- **New logo:** the KalCode mascot is now the app icon on Windows and macOS and the logo inside the app.
- **Updates:** builds of the same version can now update in place. In Settings > Updates you'll see the version with its build number, for example "0.1.8 build 900".
- **Quiet updates within a version:** later builds of 0.1.8 install by themselves when you close KalCode, so the next launch runs them. You'll only see the update prompt for a new version.
- **Safer going back:** Restore previous version only goes back to a build that can open your data.

### How to get it

On 0.1.7, update from inside KalCode with Restart to update or Settings > Updates. On Windows 0.1.6, download the installer from kalcoded.com/download and run it once; your workspaces, threads, settings and sign-ins are kept. On macOS 0.1.6, update from inside the app.

KalCode works with Claude Code and Codex through your own provider accounts. Provider usage is billed by your provider.

Download: https://kalcoded.com/download
Full release notes: https://kalcoded.com/updates#release-0-1-8

---

## Short version (about 80 words; newsletter blurb, store-style "What's new", in-app or site banner)

KalCode 0.1.8 adds Operations: queue agent tasks, builds, tests and deploys with priorities and dependencies, confirm them, and follow each run's log, outputs, services and environments in one place. Terminal panes show focus with a blue trace, and amber now means a thread or terminal is waiting for you. Terminal limits follow your plan. KalVoice is more dependable, and when memory runs low it stops the recording instead of crashing KalCode. Also new: a Windows freeze fix and the new KalCode logo.

## One-liner

KalCode 0.1.8: Operations, plan-based terminal limits, a steadier KalVoice and a new logo, on Windows and macOS.
