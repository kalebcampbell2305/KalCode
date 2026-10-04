# Provider account state and coding terminals

The shell restores the persisted native account registry before starting asynchronous checks.
`ProviderAccountSessions` owns account identity, authentication health, model discovery and the
account-bound usage reader. `providerAccountState` exposes those independent facts together.
Account Hub, launchers and terminal account pickers share this authority. Owner nicknames and
defaults remain registry metadata; provider checks update session facts only.

Authentication grants access to the provider's native coding session. Plan, quota, reset timing
and model discovery are informational. Their absence or failure never revokes authentication or
requires login. Actual missing, expired or revoked native authentication offers inline reconnect.
A cancelled, failed, mismatched or abandoned login cannot resume a pending launch.

Usage percentages require a finite provider measurement in the range 0 through 100, a valid
timestamp and a current reporting window. Unknown, unsupported, malformed, failed or stale
measurements show **Usage unavailable**; an initial active request shows **Checking usage…**.
An actual zero remains zero, and positive fractions below one percent display **<1%**.
Low usage is a quota observation, never an authentication health state.

Usage caches bind to provider, account identity and authentication generation. Native live caches
also bind to credential-file revision without retaining credential contents. Responses from an
earlier binding cannot update a later account. Codex rollout files cannot establish quota ownership
after reconnect and are not used as current account usage. Claude cache readings require an
explicit matching account UUID. Unsupported provider usage remains unavailable.

Code's New Agent flow creates independent provider PTYs in the current workspace, retaining the
explicit account, model and effort. A count of three creates three independent coding terminals.
After genuine expiry, inline reconnect preserves the request and launches only its unfinished
terminals. No agent creation path navigates to Threads. Switching the account of a live terminal
starts a fresh session after explicit confirmation; it never rebinds or resumes the old provider
session under another account.

Regression coverage lives in `ProviderAccountSessions.test.tsx`, `accountUsageReader.test.tsx`,
`accountUsage.test.ts`, `NewAgentDialog.test.tsx`, the `provider-account-launch-state` browser
specification, and native account/auth/usage and interactive CLI tests. Browser tests exercise the
memory transport; native PTY fixtures separately verify independent processes and session IDs.
These tests do not claim live paid-provider access or production updater delivery.
