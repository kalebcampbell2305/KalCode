# KalCode 0.1.9 (build {{BUILD}})

KalCode 0.1.9 adds the Command Deck, Agent Fleet, the Provider Dock and KalVoice control of your workspace and agents. It also brings KalTidy, the Account Hub, a new account list, plan limits with monthly or yearly plans, and a set of fixes. It updates KalCode's data to save each thread's reasoning effort, after first making its usual backup. Once 0.1.9 has updated your data, Restore previous version can't go back to 0.1.8.

## Upgrading

- **From 0.1.8 or 0.1.7:** KalCode offers 0.1.9 as an update. Install it from inside the app with Restart to update or Settings > Updates. You can also download the installer (Windows) or DMG (macOS) from kalcoded.com/download and install it over your current copy. Your workspaces, threads, settings and sign-ins are kept.
- **Windows, from 0.1.6:** KalCode 0.1.6 can't install updates on Windows. Download the installer from kalcoded.com/download and run it once over your current copy; your data is kept.
- **macOS, from 0.1.6:** update from inside the app with Restart to update or Settings > Updates.
- **Later builds of 0.1.9** download and are verified in the background, then install without a prompt when you close KalCode, so the next launch runs them.
- **Version numbers:** KalCode shows version 0.1.9. Settings > Updates and other detailed views add the build number, for example "0.1.9 build {{BUILD}}". Version 0.1.2 with a build number is only for a private test build and is never offered as an update.
- **Going back:** KalCode records the build that last updated its data and offers Restore previous version only for a build that can open it. A restore that would reach an older build stops with "The previous version can't open data saved by this version, so it can't be restored. Your data has not been changed."

## New in 0.1.9

- **Command Deck:** the window is organized around what is working, what needs you and what is shipping. The top bar shows your workspace, its Git branch and changes, the environment, the permission mode new threads start in, search and commands (Ctrl+K or Cmd+K), and live counts of working and waiting agents. Projects sit in the sidebar, a rail on the right lists every running agent, and a strip along the bottom shows builds, tests, provider health and what is shipping.
- **Agent Fleet:** the Dashboard shows each agent as a live card with its call sign, account, workspace, branch, current action, changed files and whether it needs you. A new thread in a Git workspace runs in its own worktree and branch (on by default), so parallel agents never change the same folder. Ready to merge appears only when the agent stopped without failing, its work is committed and Git reports no conflicts. Commit changes commits any leftover changes on the agent's branch. Archiving removes a clean worktree folder and keeps the branch.
- **Provider Dock:** every connected account appears in the status strip with its sign-in health and running threads. Move the open thread to another compatible account from the account's menu, or drag a thread onto it and confirm. KalCode never switches accounts on its own.
- **KalVoice controls your workspace:** ask KalVoice to open or focus a thread, terminal, agent, Operations run or service, then follow up with "open it" or "that one". It can start Claude Code or Codex agents with your signed-in accounts, model and effort, and send a prompt to an agent. When several things match, it asks which one. It can also say when an agent finishes, fails or needs you.
- **KalVoice sign-in reminders** follow provider health, so signing out of a provider updates them right away. Push to talk can be cancelled while it is still starting: let go of the key or press Esc.
- **Reasoning effort:** a thread keeps the reasoning effort chosen for Claude Code or Codex, including after a restart.
- **KalTidy:** the broom button in the Code toolbar, the Command Palette or KalVoice ("close all idle terminals") stops idle terminals. Review terminals shows each one and why. Terminals running an agent, a service or Operations work, and the focused terminal, are never stopped by default. Nothing is stopped if KalCode can't check a terminal.
- **Account Hub:** your name and plan at the foot of the sidebar open Account & plan, Usage, Billing, connected providers, KalVoice, Settings and Sign out.
- **Providers > Accounts:** a compact list grouped by provider, with health, sign-in status, quick actions and details for each account. Accounts have the same names everywhere in KalCode. KalCode shows "Not reported" instead of guessing plans or usage.
- **Plan limits count across KalCode:**
  - open terminals: Free 4, Pro 12, MAX 18
  - workspaces: Free 2, Pro 10
  - provider accounts: Free 2, Pro 6, MAX 8
  - parallel agents: Free 1, Pro 4, MAX 10

  Higher plans have no KalCode limit. Reaching a limit never closes anything: KalCode only declines to open one more and says how many the next plan allows. If your plan can't be verified, the Free limits apply.
- **KalVoice Requests a month:** Free 25, Pro 150, MAX 500, MAX 2X 1,000. Each KalVoice command that KalCode carries out counts once. Dictation and voice into terminals never count. The meter shows what's left first.
- **Monthly or yearly:** onboarding offers Pro, MAX and MAX 2X monthly or yearly ($100, $250 or $500 a year). Free stays $0.
- **Free run history:** on Free, Operations > Runs lists your 10 most recent finished runs. Running work and the open run always stay listed.
- **Closing a terminal or agent ends it:** closing a terminal ends its shells, and closing a Claude Code or Codex pane stops the agent.
- **F8 push to talk after switching back** (Windows): F8 works again within about half a second of KalCode getting focus back.
- **Windows installer:** shows the KalCode mascot icon.
{{RESPONSIVENESS_LINE}}

## Known issues

- Settings > Permissions says every mode is available on every plan. Stable 0.1.9 offers Plan, Approve and Auto on every plan; Bypass and Custom are planned.
- Codex agents can't commit inside their own worktree, because their sandbox can't write the repository's Git data. Use Commit changes on the agent's card.
- Gemini CLI is still unavailable in KalCode, as described in the 0.1.6 notes. Claude Code and Codex are unaffected.
- If you start an update or Restore previous version while a provider sign-in or a file or folder picker is still open, the update stops and KalCode says to close sign-in or file dialogs and try again.
- KalVoice intelligence (assistant) responses can be delayed after you finish speaking.
- After updating, KalVoice's on-device intelligence can take a few minutes to become ready while KalCode cleans up the previous version's worker. It then starts on its own.
- The app binaries contain file paths from the build machine, including the build account's user folder name. They contain no credentials, tokens or email addresses.

## Platforms

| Platform | Package and requirements |
| --- | --- |
| Windows 10 (1809) or later, x64 | Signed per-user NSIS installer. |
| macOS 14 or later, Apple silicon arm64 | Developer ID-signed and notarized DMG with a stapled notarization ticket. Use `~/Applications/KalCode.app` for standard-user in-app updates and rollback. The DMG's Applications shortcut targets system `/Applications`, where later replacement requires administrator authority. |
| Intel Mac, universal Mac, Linux | No release artifact. |

Provider usage remains billed by your provider.

## Artifact identities

Source commit: `{{SOURCE_COMMIT}}`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `KalCode_0.1.9_build{{BUILD}}_x64-setup.exe` | PENDING | PENDING |
| `KalCode_0.1.9_build{{BUILD}}_arm64.dmg` | PENDING | PENDING |

PENDING: sizes, SHA-256 digests and signature bindings are filled in after both artifacts are rebuilt and certified from the source commit above. This file must not be published while any PENDING marker remains.
