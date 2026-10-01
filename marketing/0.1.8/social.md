# KalCode 0.1.8 social posts

Post from @KalCodeDev (official). The founder account (@CampbellKaleb23) may quote-post the X thread. Attach the media named in each post from `screenshots.md` or the film cuts in `video-script.md`. Lines marked [IF SILENT UPDATES SHIP] go out only if the published 0.1.8 build installs later 0.1.8 builds when KalCode is reopened.

Don't claim: prices, Gemini CLI, speed figures, "instant" speech, deploy health checks, or features listed as not shipped in `video-script.md`.

---

## X (thread, each post under 280 characters)

**1/5** (media: 60 s film, landscape, or the 30 s cut)
KalCode 0.1.8 is out for Windows and macOS.

The headline: Operations. Queue agent tasks, builds, tests and deploys, confirm them, then follow every run to its result in one place.

kalcoded.com/download

**2/5** (media: S1 Queue, S2 Run detail)
Operations has five views: Runs, Queue, Services, Environments and Activity.

Add priorities and dependencies. Nothing runs until you confirm it, and a restart never reruns work on its own.

**3/5** (media: S6 focus trace GIF, S7 amber waiting)
Terminals are easier to read at a glance.

Focus a pane and a blue trace runs once around its edge. Amber now means one thing: a thread or terminal is waiting for you.

Terminal limits follow your plan. MAX and MAX 2X have no KalCode limit.

**4/5** (media: S9 KalVoice low-memory message)
KalVoice prepares your on-device speech model once per take, before the mic opens.

If memory runs low mid-recording, it stops the recording and tells you. KalCode keeps running.

**5/5** (media: S11 new app icon)
Also in 0.1.8: a fix for a Windows freeze on focus changes, and the new KalCode logo.

[IF SILENT UPDATES SHIP] Later 0.1.8 builds install when you reopen KalCode.

Release notes: kalcoded.com/updates#release-0-1-8

### Single post (if not threading)

KalCode 0.1.8 is out on Windows and macOS. New: Operations, one place to queue, confirm and follow agent tasks, builds, tests and deploys. Plus terminal focus you can see, plan-based terminal limits, a steadier KalVoice and a new logo. kalcoded.com/download

---

## LinkedIn (company page; about 1,100 characters)

KalCode 0.1.8 is out for Windows and macOS.

KalCode is a desktop workspace for software work with AI coding agents: real project terminals, Claude Code and Codex threads under your own accounts, and KalVoice for on-device dictation and voice commands.

0.1.8 adds Operations. Queue agent tasks, builds, tests, scripts and deploys with priorities and dependencies. KalCode asks you to confirm before anything runs. Then follow each run in five views:

- Runs: status, output log, history and the files a command reports as outputs
- Queue: waiting work in order
- Services: processes and ports in your workspaces
- Environments: Local, Preview, Staging and Production, with unverified deploys labeled as unverified
- Activity: recent run events and commits

Also in this release:
- A blue focus trace on terminal panes, and amber reserved for "waiting for you"
- Terminal limits that follow your plan
- KalVoice prepares its speech model once per take, and low memory no longer closes KalCode
- A fix for a Windows freeze on focus changes
- The new KalCode logo

Release notes: https://kalcoded.com/updates#release-0-1-8
Download: https://kalcoded.com/download

(media: S1 Queue screenshot, or the 60 s film)

---

## Reddit

Post only in communities that allow a developer's own project, and follow each one's self-promotion rules (for example a weekly showcase thread). Post from the founder's own account and say plainly that you build KalCode. Answer questions in the comments. Don't cross-post the same text to several subreddits at once.

Suggested communities: r/ClaudeAI (check its current flair and showcase rules first) and r/SideProject. Check any other community's rules before posting there.

**Title:** I build KalCode, a desktop workspace for Claude Code and Codex. 0.1.8 adds a queue for agent tasks, builds and deploys

**Body:**

I'm the developer of KalCode, a Windows and macOS app that puts real project terminals, Claude Code and Codex threads (on your own accounts) and on-device voice dictation in one workspace. Version 0.1.8 is out, and here's what changed.

**Operations.** You can now queue work: an agent task, a build, a test run, a script, a deploy or a service. Each one gets a priority and the tasks it depends on. Nothing runs until you confirm it, and after a restart KalCode won't rerun anything on its own; the queue pauses instead. Each run keeps its output log and the files the command says it produced. There are also views for services (processes and ports in your workspaces), environments (Local, Preview, Staging, Production) and recent activity.

One deliberate limit: KalCode doesn't check whether a deployed site is healthy yet, so deploys are labeled unverified. It doesn't pretend otherwise.

**Smaller things:**
- Focusing a terminal plays a short blue trace around its edge. Amber is now only used for "waiting for you".
- Terminal limits follow your plan (12 per workspace on Free and Pro, none on MAX).
- KalVoice prepares its speech model once per take. If memory runs low mid-recording, it stops the recording instead of crashing the app.
- Fixed a Windows freeze when keyboard focus moved away from KalCode while it was handling key presses. This one came from a reentrant lock in the windowing library; KalCode now carries the upstream fix.

Release notes: https://kalcoded.com/updates#release-0-1-8

I'd like to hear what you'd want Operations to track next.
