# KalCode 0.1.9 announcement copy

Before posting, check that https://kalcoded.com/download serves the 0.1.9 build, and that https://kalcoded.com/updates#release-0-1-9 opens the 0.1.9 notes.

## One-liner

KalCode 0.1.9 is out: the Command Deck, Agent Fleet, the Provider Dock and KalVoice that runs your workspace. Every agent, account and terminal now sits in one place. https://kalcoded.com/download

## Short (launch post)

**Introducing KalCode 0.1.9.**

KalCode is the workspace for AI software engineering: Claude Code and Codex, your accounts, terminals, agents and Operations, all in one window. 0.1.9 turns that window into a command deck.

- **Command Deck:** see what's working, what needs you and what's shipping at a glance.
- **Agent Fleet:** every agent is a live card, working in its own worktree and branch. Ready to merge shows up only when Git agrees.
- **Provider Dock:** every Claude Code and Codex account in the status strip. Drag a thread onto another account to move it there.
- **KalVoice:** "open the failed run", "start two Codex agents on this", "that one". KalVoice finds it, routes it and tells you when an agent needs you.

Plus KalTidy, the Account Hub, a new account list, effort that sticks, and terminals that really close.

Coming soon: Squads, Handoff Chains, Brainstorm, KalCode Deploy, KalCode Remote and more autonomy.

Refactor the workflow. Code the future.
https://kalcoded.com/download

## Long (blog / email)

### KalCode 0.1.9: one place to actually run AI engineering

Using AI to write software today means running a lot of things side by side: Claude Code in one terminal, Codex in another, a second account for when the first hits its limit, a browser, a test runner, a deploy. It all works, but keeping it straight is the hard part.

KalCode exists to hold all of it, and 0.1.9 is the release where that becomes obvious from the first screen.

**The Command Deck.** KalCode now opens on a control room that answers three questions: what's working, what needs me, and what's shipping. The top bar shows your workspace, branch and changes, environment and mode, with search and commands under Ctrl+K (Cmd+K on Mac) and live counts of working and waiting agents. Projects sit on the left. Every running agent sits on the right, grouped into needs you, working and blocked. A strip along the bottom shows builds, tests, provider health and what's shipping. Every number is real; when there's nothing to show, KalCode says so.

**Agent Fleet.** Run several agents at once without them trampling each other. Each new agent in a Git workspace gets its own worktree and branch. Its card shows its call sign, account, branch and how far ahead it is, what it's doing right now, the files it changed and whether it needs you. **Ready to merge** isn't a guess: it appears only when the agent stopped without failing, its work is committed, its branch is ahead and Git reports no conflicts. If an agent left changes uncommitted, Commit changes commits them on its branch. Click a card and the workspace turns into that agent's thread.

**Provider Dock.** Every connected Claude Code and Codex account sits at the start of the status strip, with its sign-in health and how many of its threads are running or waiting. When one account is signed out or busy, move the open thread to another from the account's menu, or drag a thread onto an account and confirm. KalCode suggests a compatible account and never switches on its own.

**KalVoice runs your workspace.** KalVoice now understands what's on your screen. Ask it to open or focus a thread, a terminal, an agent, an Operations run or a service, then follow up with "open it" or "that one". It can start Claude Code or Codex agents on your signed-in accounts with the model and effort you name, and send a prompt to an agent. When several things match, it asks which you mean instead of guessing. It can also say out loud when an agent finishes, fails or needs you.

**And a lot of smaller things you'll feel every day:**

- **KalTidy** stops idle terminals in one click, or reviews them first. It never stops an agent, a service, Operations work or the terminal you're in.
- **Account Hub:** your name and plan at the foot of the sidebar, with usage, billing, providers and settings.
- **Providers > Accounts** is a compact list grouped by provider, and every account has the same name everywhere in KalCode.
- **KalVoice allowance:** see what's left first, then what you've used and the real reset date.
- **Effort sticks:** a thread remembers its reasoning effort across restarts.
- **Close means close:** closing a terminal or an agent pane ends it.
- **F8 push to talk** recovers right after you switch back to KalCode on Windows, and push to talk can be cancelled while it starts.
- **Monthly or yearly plans** in the app, and plan limits that count across all of KalCode. Reaching a limit never closes anything.

**Getting 0.1.9.** If you're on 0.1.8 or 0.1.7, KalCode offers the update: choose Restart to update, or go to Settings > Updates. On Windows 0.1.6, download the installer once from https://kalcoded.com/download. From 0.1.9 on, every update installs when you close KalCode. KalCode now saves each thread's reasoning effort, so Restore previous version only goes back to builds that can open that data. Windows 10 and later (x64) and macOS 14 and later (Apple silicon) are supported.

**What's next.** Squads (reusable agent teams), Agent Handoff Chains, Brainstorm, Live Browser Studio, KalCode Deploy, KalCode Remote, and more autonomy are all on the roadmap at https://kalcoded.com/pricing. They aren't in 0.1.9. KalCode runs Claude Code and Codex today, and more providers are coming.

Refactor the workflow. Code the future.

Full release notes: https://kalcoded.com/updates#release-0-1-9
