# KalCode 0.1.8 social posts

Final, copy-paste ready. Post from @KalCodeDev (official); the founder account (@CampbellKaleb23) may quote-post the X thread. Posting order, media files and alt text are in [`LAUNCH.md`](LAUNCH.md). Every claim maps to a row in [Fact sources](LAUNCH.md#fact-sources).

Each block between the `---text---` markers is the exact text to paste. Character counts were measured on the raw text (X counts every link as 23 characters, so the posted length is never longer than the count shown).

Don't claim: prices, Gemini CLI, speed figures, "instant" speech, deploy health checks, Agents, Missions, Automations, provider panes, or anything from a later 0.1.8 build (the F8 refocus fix, closing a terminal ends it).

---

## X thread (5 posts, each 280 characters or fewer)

**1/5** (media: `KalCode_0.1.8_60s_1080p60.mp4`) - 221 chars

---text---
KalCode 0.1.8 is out for Windows and macOS.

The headline: Operations. Queue agent tasks, builds, tests and deploys, confirm them, then follow every run to its result in one place.

Download: https://kalcoded.com/download
---text---

**2/5** (media: `screenshots/s01-operations-queue.png`, `screenshots/s02-operations-run.png`) - 221 chars

---text---
Operations has five views: Runs, Queue, Services, Environments and Activity.

Give work a priority and dependencies. Nothing runs until you confirm it, and a restart never reruns work on its own. The queue pauses instead.
---text---

**3/5** (media: `screenshots/s06-focus-trace.png`, `screenshots/s07-amber-waiting-dark.png`) - 234 chars

---text---
Terminals you can read at a glance.

Focus a pane and a blue trace runs once around its edge. Amber now means one thing: a thread or terminal is waiting for you.

Terminal limits follow your plan. MAX and MAX 2X have no KalCode limit.
---text---

**4/5** (media: `screenshots/s09-kalvoice-low-memory.png`) - 215 chars

---text---
KalVoice now prepares your on-device speech model once per take, before the mic opens, and keeps it for the whole take.

If memory runs low mid-recording, it stops the recording and tells you. KalCode keeps running.
---text---

**5/5** (media: `screenshots/s11-app-icon.png`) - 219 chars

---text---
Also in 0.1.8: a fix for a Windows freeze on focus changes, and the new KalCode logo.

From here on, new 0.1.8 builds install when you close KalCode. No prompt.

Release notes: https://kalcoded.com/updates#release-0-1-8
---text---

### Single X post (if not threading) - 262 chars

---text---
KalCode 0.1.8 is out on Windows and macOS. New: Operations, one place to queue, confirm and follow agent tasks, builds, tests and deploys. Plus a terminal focus trace, plan-based terminal limits, a steadier KalVoice and a new logo.

https://kalcoded.com/download
---text---

---

## LinkedIn (company page) - 1,324 characters (limit 3,000)

(media: `KalCode_0.1.8_60s_1080p60.mp4`, or `screenshots/s01-operations-queue.png`)

---text---
KalCode 0.1.8 is out for Windows and macOS.

KalCode is a desktop workspace for software work with AI coding agents: real project terminals, Claude Code and Codex threads under your own accounts, and KalVoice for on-device dictation and voice commands.

0.1.8 adds Operations. Queue agent tasks, builds, tests, scripts and deploys with priorities and dependencies. KalCode asks you to confirm before anything runs, and a restart never reruns work on its own. Then follow each run in five views:

- Runs: status, output log, history and the files a command reports as outputs
- Queue: waiting work in order
- Services: processes and ports in your workspaces
- Environments: Local, Preview, Staging and Production, with deploys labeled unverified because KalCode doesn't check deployed sites' health
- Activity: recent run events and commits

Also in this release:
- A blue focus trace on terminal panes, and amber reserved for "waiting for you"
- Terminal limits that follow your plan
- KalVoice prepares its speech model once per take, and low memory no longer closes KalCode
- A fix for a Windows freeze on focus changes
- The new KalCode logo
- From now on, new 0.1.8 builds install when you close KalCode, without a prompt

Download: https://kalcoded.com/download
Release notes: https://kalcoded.com/updates#release-0-1-8
---text---

---

## Reddit

Post only in communities that allow a developer's own project, and follow each one's self-promotion rules (for example a weekly showcase thread). Post from the founder's own account and say plainly that you build KalCode. Answer questions in the comments. Don't cross-post the same text to several subreddits at once; space posts at least a day apart.

Suggested communities: r/ClaudeAI (check its current flair and showcase rules first) and r/SideProject. Check any other community's rules before posting there.

**Title** (118 characters, limit 300):

---text---
I build KalCode, a desktop workspace for Claude Code and Codex. 0.1.8 adds a queue for agent tasks, builds and deploys
---text---

**Body** (1,813 characters, limit 40,000; Markdown editor):

---text---
I'm the developer of KalCode, a Windows and macOS app that puts real project terminals, Claude Code and Codex threads (on your own accounts) and on-device voice dictation in one workspace. Version 0.1.8 is out, and here's what changed.

**Operations.** You can now queue work: an agent task, a build, a test run, a script, a deploy, a release or a service. Each one gets a priority and the tasks it depends on. Nothing runs until you confirm it, and after a restart KalCode won't rerun anything on its own; the queue pauses instead. Each run keeps its output log and the files the command says it produced. There are also views for services (processes and ports in your workspaces), environments (Local, Preview, Staging, Production) and recent activity.

One deliberate limit: KalCode doesn't check whether a deployed site is healthy, so deploys are labeled unverified. It doesn't pretend otherwise.

**Smaller things:**

- Focusing a terminal plays a short blue trace around its edge, once. Amber is now only used for "waiting for you".
- Terminal limits follow your plan (12 per workspace on Free and Pro, no KalCode limit on MAX and MAX 2X).
- KalVoice prepares its speech model once per take, before the mic opens. If memory runs low mid-recording, it stops the recording instead of taking the app down.
- Fixed a Windows freeze when keyboard focus moved away from KalCode while it was handling key presses. It came from a reentrant input lock in the windowing library (tao); KalCode now carries the upstream fix.
- From 0.1.8 on, newer builds of the same version install when you close the app, with no prompt. Moving from 0.1.7 to 0.1.8 asks once.

Download: https://kalcoded.com/download
Release notes: https://kalcoded.com/updates#release-0-1-8

I'd like to hear what you'd want Operations to track next.
---text---

---

## Discord / community blurb (664 characters, limit 2,000)

---text---
**KalCode 0.1.8 is out** for Windows and macOS.

- **Operations:** queue agent tasks, builds, tests and deploys with priorities and dependencies, confirm them, and follow each run through Runs, Queue, Services, Environments and Activity.
- Blue focus trace on terminals; amber means waiting for you.
- Terminal limits follow your plan.
- KalVoice gets ready once per take, and low memory no longer closes KalCode.
- Windows freeze fix and the new KalCode logo.

On 0.1.7? Choose **Restart and install** once. After that, new 0.1.8 builds install when you close KalCode.

Download: <https://kalcoded.com/download>
Notes: <https://kalcoded.com/updates#release-0-1-8>
---text---
