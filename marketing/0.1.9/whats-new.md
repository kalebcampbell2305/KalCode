# What's new in KalCode 0.1.9

**One place to actually run AI engineering.** KalCode 0.1.9 puts every agent, account and terminal into one command deck. You can see what's working, what needs you and what's shipping without hunting through windows.

## The big four

**Command Deck.** KalCode now opens on a control room. The top bar shows your workspace, branch and changes, environment, mode and search (Ctrl+K / Cmd+K), plus live counts of working agents and agents that need you. Projects sit on the left and every running agent on the right. A strip along the bottom shows builds, tests, provider health and what's shipping.

**Agent Fleet.** Every agent is a live card with a call sign (Claude A, Codex B), account, branch, current action, changed files and whether it needs you. Each new agent in a Git workspace works in its own worktree and branch, so parallel agents never step on each other. **Ready to merge** appears only when the facts say so: the agent finished, its work is committed and Git sees no conflicts.

**Provider Dock.** All your Claude Code and Codex accounts sit in the status strip with their sign-in health and running threads. To move a thread to another account, pick it from the account's menu, or drag the thread onto the account and confirm. KalCode never switches accounts behind your back.

**KalVoice runs your workspace.** Say "open the failed run", then "open it". Ask it to start Codex agents on your work account at high effort, or send a prompt to an agent. When more than one thing matches, KalVoice asks. It can also tell you when an agent finishes, fails or needs you.

## Also new

- **KalTidy:** one click stops idle terminals. It never touches agents, services, Operations work or the terminal you're in.
- **Account Hub:** your name and plan at the foot of the sidebar, with usage, billing, providers and settings one click away.
- **A new account list:** Providers > Accounts groups accounts by provider, with health and quick actions. Every account has the same name everywhere in KalCode.
- **Your KalVoice allowance at a glance:** see what's left first, then what you've used and when it resets.
- **Effort that sticks:** a thread remembers its Claude Code or Codex reasoning effort, even after a restart.
- **Close means close:** closing a terminal or an agent pane ends it. Nothing keeps running in the background.
- **F8 push to talk** works again right after you switch back to KalCode on Windows.
- **Push to talk you can cancel:** let go of the key or press Esc while it's starting.
- **Monthly or yearly plans** in the app, and plan limits that count across all of KalCode. Reaching a limit never closes anything.

## Coming soon

These are planned and not in 0.1.9:

- Squads (reusable agent teams)
- Agent Handoff Chains
- Brainstorm
- Live Browser Studio
- KalCode Deploy
- KalCode Remote
- More autonomy

More providers are coming. Today KalCode runs **Claude Code and Codex**.

Download: https://kalcoded.com/download · Full notes: https://kalcoded.com/updates#release-0-1-9
