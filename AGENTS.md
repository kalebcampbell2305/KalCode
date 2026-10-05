# KalCode agent policy

## Permanent provider account truth and agent launch rule (owner directive 2026-10-04)

**UNKNOWN PROVIDER USAGE NEVER EQUALS 0%. FAILURE TO READ PLAN OR USAGE METADATA MUST NOT BLOCK A VALID PROVIDER CODING SESSION.**

- Authentication, plan metadata, usage/reset timing and model discovery are distinct facts in the shared provider account authority. Every surface uses the same account ID, nickname, identity and default; informational failures never revoke a valid session.
- Display a percentage only from a valid provider-reported measurement. Missing, malformed, unsupported, failed or stale usage is **Usage unavailable** (or **Checking usage…** while fetching), never fake 0%, Low or Exhausted. Preserve legitimate zero and distinguish positive fractions below 1% from zero.
- Restore persisted identities and provider-native authentication immediately; validate safely and refresh metadata asynchronously. Require reconnection only when the provider actually reports expired/revoked or missing authentication, never because plan, usage, reset or model metadata could not be read.
- A valid provider session that can start must launch regardless of unknown plan/usage. Provider adapters preserve native authentication, configuration and account isolation. Provider-enforced restrictions remain authoritative.
- **Agent means a real coding terminal, never a Thread.** Agent creation never routes to Threads or says “resume this thread.” Launch N creates N independent provider sessions in the current workspace using the explicitly selected account, model and effort.
- Genuine expiry offers inline **Reconnect**, preserves the pending launch, and automatically creates only its unfinished agents after successful authentication. Never make the user navigate away and reconstruct the request.
- Apply this to Claude Code, Codex, Cursor, Gemini and every future provider. Validate available/unavailable metadata, genuine expiry/reconnect, multi-agent creation and restart persistence through the shared paths.

This file is the authority imported by `CLAUDE.md`; Claude Code and Codex follow the same rule.

## Permanent optimization rule (owner directive 2026-10-04)

"KALCODE MUST BE CONTINUOUSLY OPTIMIZED FOR REAL-WORLD SPEED, RELIABILITY, RESOURCE EFFICIENCY, AND SIMPLICITY.

MEASURE REAL BOTTLENECKS.
KEEP THE UI THREAD FREE.
USE ONE CANONICAL STATE MODEL.
KEEP PROVIDER ADAPTERS THIN.
PRIORITIZE THE CODE TAB.
REUSE EXPENSIVE RESOURCES SAFELY.
CONTROL RESOURCE PRESSURE.
KEEP AGENT LIFECYCLES CLEAN.
RETRIEVE ONLY RELEVANT MEMORY.
PARALLELIZE MERGING AND SHIPPING.
CLEAN SAFE STORAGE BLOAT.
RECOVER FROM FAILURES AUTOMATICALLY WHERE SAFE.
REMOVE UNNECESSARY USER STEPS.
PROFILE REAL PRODUCTION WORKLOADS.

FAST, BEAUTIFUL, RELIABLE, AND SIMPLE IS THE STANDARD."

- **Measure first.** Optimize measured bottlenecks (p50/p95, render counts, CPU/RAM), never guesses; record before/after numbers and keep the measurement scripts re-runnable. Profile realistic workloads (1, 4, 10, 20+ agents, several providers and accounts, large output, long sessions) and the release build, not only dev.
- **UI thread.** Click → immediate visual response → background work continues → state updates in place. Git scans, indexing, provider health/usage, network, model discovery, Browser init, memory retrieval, telemetry and log processing never block a menu or pane from opening.
- **One canonical state.** Each truth (coding agents, terminals, accounts, usage, models, Runs, Queue, services, environments, Needs You, workspaces, Browser, entitlements, memory) has one shared source every surface reads; no surface keeps a conflicting copy. One agent's change must not rerender every pane.
- **Thin provider adapters.** Provider differences live in adapter/capability layers; adding a provider never requires rewriting the Fleet, KalVoice, Runs, Queue, KalTidy, memory, Code, account UI or orchestration.
- **Resources.** Reuse expensive resources safely (warm workers, WebViews, cached account/model/workspace metadata, progressive restore) without leaks. The Resource Governor protects UI responsiveness under CPU/RAM/disk pressure, lowers non-urgent background work and says what it is doing; it never silently kills active work and is never plan gating.
- **Polling.** Prefer events, backoff, caching, dedupe, batching and refresh-on-focus over constant polling.
- **Visual performance.** Beautiful never means heavy: smooth animation, working reduced motion, no animation that delays an action.
- No needless rewrites: preserve good architecture and fix the highest-impact measured issues first.

## Permanent provider-agnostic agent status rule (owner directive 2026-10-04)

"KALCODE AGENT STATUS IS PROVIDER-AGNOSTIC.

WORKING, IDLE, NEEDS YOU, WAITING, DONE, FAILED, TESTING, AND OTHER AGENT STATES APPLY TO ALL REAL CODING AGENTS REGARDLESS OF PROVIDER.

NO CORE AGENT UI OR STATUS LOGIC SHOULD BE HARD-CODED TO CLAUDE CODE.

ALL CURRENT AND FUTURE PROVIDERS MAP INTO ONE SHARED KALCODE AGENT-STATE MODEL."

- **One model.** Provider session → canonical KalCode agent state → every surface. The states are STARTING, READY, WORKING, TESTING, WAITING, NEEDS YOU, IDLE, DONE, FAILED and STOPPED. They are defined once in `crates/contracts/src/agent_state.rs` (`AgentState::of`) and mirrored by `packages/protocol/src/agent-state.ts` (`agentStateOf`), and a test keeps the two identical. The Agents tab, Agent Fleet, Code, What's Happening, Needs You, Runs, Queue, KalTidy, counters, filters, completion badges, the locator and KalVoice all read it. Never add a per-surface or per-provider status mapping.
- **Real state only.** Each provider adapter maps its native session events (hooks, notify, process lifecycle) into the shared runtime status. Status never comes from the provider's name, a timer or terminal prose. Where a provider exposes no signal, say so truthfully instead of guessing.
- **Filters.** Global status filters (All, Needs you, Working, Waiting, Idle, Done, Failed) include agents from every provider. A provider filter is separate and optional and never replaces them.
- **Copy.** Counts are provider-neutral ("3 agents working"). Provider and account identity appear on the individual agents ("Claude A · WORKING", "Codex B · NEEDS YOU").

## Permanent Unified Memory definition (owner directive 2026-10-04)

**UNIFIED MEMORY IS KALCODE'S SHARED, PROVIDER-INDEPENDENT PROJECT MEMORY.** It preserves useful
long-lived project context across agents, providers, terminals, sessions, restarts, KalVoice,
Brainstorm, Runs, and orchestration. Memory must be relevant, inspectable, editable, fast, safe,
and truthful. Users should not have to keep re-explaining their project. Reuse the canonical
workspace memory service; never create provider-owned competing project memory. Retrieve the
smallest useful context, retain provenance, withhold stale claims, and never blindly retain
terminal logs, conversations, secrets, or credentials. See `docs/UNIFIED-MEMORY.md` for the
implemented paths and current provider/workflow limits.

## Permanent Cursor provider rule (owner directive 2026-10-04)

**CURSOR IS A FIRST-CLASS KALCODE CODING PROVIDER. CURSOR AGENTS ARE REAL CODING TERMINALS, NEVER CHAT THREADS.**

Use the shared provider, account, model, PTY/session, agent, workspace, KalVoice, Runs/Queue, orchestration and context systems. Preserve native Cursor file access, edits, shell, Git, search, tools, configuration, environment, authentication, integrations and interactive input/output. A capability that works in Cursor's supported native terminal but fails only in KalCode is a KalCode compatibility bug.

Discover Cursor's models from the actual account/runtime; never maintain or invent a fixed availability list. Preserve exact model IDs/numbers and supported reasoning parameters, including models from any upstream vendor or custom model actually exposed. Never imply an unavailable model or effort is supported. Use native persistent sign-in; support multiple accounts only through a verified isolation mechanism. Do not manufacture multiple identities for one native account. Show real provider usage only; otherwise show **Usage unavailable**.

Keep account and exact model identity consistent across Code, Agent Fleet, Account Hub, Providers, Runs, Queue, orchestration and KalVoice. Workspace context belongs to KalCode/the workspace and remains provider-neutral. Cursor uses the existing KalCode visual hierarchy and lifecycle; no disconnected Cursor subsystem. See `docs/providers/cursor.md` for the supported integration and its verified limits.

## Permanent workspace execution rule (owner directive 2026-10-03)

**KALCODE CODE MODE / WORKSPACE EXECUTION MUST BE AVAILABLE BY DEFAULT. THE USER SHOULD NEVER BE BLOCKED BY "CODE-MODE HOST IS DISABLED" DURING NORMAL USE.** This policy applies to Claude Code, Codex, Windows and macOS, Stable and Dev.

The execution host must initialize automatically, recover safely when possible, and support real terminals, coding agents, file operations, tests, builds, Git, merging and shipping. Do not require a manual enable switch, configuration edit, Refresh or an extra KalCode approval for routine workspace execution.

Do not hide host failures: fix the underlying initialization/configuration problem. Preserve the actual error and an actionable retry when recovery fails. Reinitialize only owned failed execution processes; never replay potentially completed commands or interrupt active coding terminals. Keep provider authentication, selected permission modes, OS security, credential protection, signing and updater integrity authoritative. Verify the real execution path and restart behavior with isolated test profiles; never close the owner's active app.

## Permanent active application protection (owner directive 2026-10-03)

**NEVER CLOSE, RESTART, OR TERMINATE THE KALCODE APPLICATION THE OWNER IS WORKING IN.** It may contain many running coding terminals. This applies to development, testing, updates, release verification and cleanup. Never use process-wide termination or an updater/installer that would interrupt that instance or its terminals.

Agents may open a separate KalCode instance for testing, using isolated application data and explicitly tracked process ownership. Stop only test instances and children that the task itself created. Verify update delivery with isolated installations/profiles; leave any proof requiring interruption of the owner's active instance pending until the owner closes it themselves. This rule overrides earlier release instructions that would close or restart the owner's active application.

## Permanent background process and focus rule (owner directive 2026-10-03)

**KALCODE AGENTS MUST NEVER SPAM THE WINDOWS DESKTOP WITH EXTERNAL TERMINAL WINDOWS.** User-visible shell work runs inside KalCode's integrated terminals. Infrastructure and background commands run headless/hidden and must never steal focus. Do not launch Windows Terminal, cmd, PowerShell or another external console window unless the user explicitly requests an external terminal.

- Trace the actual process parent and launch owner before repairing a popup. Prevent window creation at that boundary (`windowsHide`, `CREATE_NO_WINDOW`, or the canonical process host/PTY as appropriate); never minimize, move, hide or close a window after creating it as the fix.
- Apply this to agent execution, tests, Git/worktrees, Cargo/builds, package managers, release/verification scripts and shell wrappers. Avoid unnecessary shells, `wt.exe`, `start` and visible `Start-Process` for background work.
- Deduplicate active logical jobs, bound retries/concurrency, and ensure cancellation and completion clean up owned children. Never terminate unrelated user processes.
- Verify sustained concurrent coding/build/test/Git/worktree work with desktop window/focus observation: zero external console popups or focus theft, working integrated terminals, and a responsive app. Preserve equivalent background behavior on macOS.

## Permanent provider session persistence rule (owner directive 2026-10-02)

**KALCODE PROVIDER ACCOUNTS MUST PERSIST ACROSS APP RESTARTS.** Once a user connects a valid Claude Code, Codex, or other supported provider account, closing and reopening KalCode must not require manual Refresh or re-authentication unless the provider session has actually expired or been revoked.

- Restore persisted account identities, nicknames, defaults, ordering and last known safe status immediately. Keep the Code-tab account picker ready to launch real coding agents with valid accounts.
- New coding terminals reuse the selected provider account's existing native sign-in. A completed account connection must not replay first-run login in every terminal. Keep noncredential onboarding compatibility separate from authentication: never copy tokens, switch accounts silently, or bypass genuine expiration, provider approval, or workspace trust.
- Validate sessions and refresh health/usage asynchronously. Startup and account selection must not wait on provider/network checks. Distinguish connected, checking, expired and validation error; an unfinished or failed background check is not proof of sign-out. Label cached usage as stale until refreshed.
- Background validation must use a provider-supported check that cannot refresh or mutate credentials. Never run a short-lived command known to risk token loss (including affected Claude `auth status` versions). If no safe passive check exists, preserve last-known state and let the next real provider coding session enforce authentication; do not fake a fresh validation timestamp.
- Keep credentials in provider-native persistence or existing OS/secure credential storage on Windows and macOS. Never copy secrets into plaintext account metadata, localStorage, logs, telemetry or repository files. Preserve genuine provider expiration, revocation and authentication boundaries.
- Owner clarification (2026-10-03): preserve provider-native sessions, including credential files managed by the provider itself. The plaintext prohibition applies to new KalCode credential storage: do not create a second token cache, copy provider secrets, or switch existing native storage in a way that forces valid accounts to sign in again. Do not claim provider-owned files are encrypted when they are not.
- Verify multiple accounts, complete application restart, immediate launch, transient validation failure and genuine expiration on both platforms. Tests must not mutate the owner's provider credentials.

## Permanent permission UX rule (owner directive 2026-10-03, replaces 2026-10-02)

**KALCODE SHOULD NOT INTERRUPT NORMAL DEVELOPMENT WITH INTERNAL PERMISSION PROMPTS. NORMAL SAFE CODING WORK SHOULD EXECUTE DIRECTLY.** The owner: "take away all approvals in the entire KalCode." Routine development = no permission prompt. Genuinely risky or external security actions are handled appropriately.

- Coding agents (Claude Code, Codex, Gemini CLI), threads, KalVoice, Code terminals, orchestration, Squads, Handoffs, tests, builds, Git/worktrees (including push), dev servers and workspace edits run without Approve/Allow/Confirm/Continue prompts.
- New sessions start in **Bypass** unless the saved default is read-only Plan (`startable_default_mode`, `paneStartMode`, `startModeFor`). Never downgrade a saved Bypass to Approve, and never require a Bypass confirmation. Only the user (never an agent or KalVoice) changes a mode.
- Bypass means no provider prompts:
  - Claude Code: `--permission-mode bypassPermissions`, with `skipDangerousModePermissionPrompt` pre-accepted in the account's managed profile.
  - Codex: `-a never` with `danger-full-access`.
  - Gemini CLI: `--approval-mode yolo`.
- KalVoice and utility actions ("open four Claude Code agents", "run the tests", "start the dev server") execute without approval stubs. Environment Doctor repairs keep Approve.
- Real security still exists. Keep:
  - provider sign-in and authentication;
  - OS/UAC/admin authorization;
  - credential and secret protection (the credential-file read deny floor applies in every mode, and credential access still asks);
  - billing and payment authorization;
  - safeguards against meaningful user-data deletion;
  - signing certificates;
  - genuinely irreversible production authorization.

## Permanent native provider parity rule (owner directive 2026-10-04)

> "A PROVIDER INSIDE KALCODE MUST RETAIN THE CAPABILITIES IT HAS IN ITS NORMAL NATIVE TERMINAL ENVIRONMENT.
>
> KALCODE ADDS UI, ORCHESTRATION, VOICE, ACCOUNT MANAGEMENT, BROWSER, OPERATIONS, AND WORKSPACE MANAGEMENT AROUND PROVIDERS — IT MUST NOT TAKE PROVIDER FUNCTIONALITY AWAY.
>
> IF SOMETHING WORKS IN THE PROVIDER'S NORMAL TERMINAL BUT DOES NOT WORK INSIDE KALCODE, THAT IS A KALCODE COMPATIBILITY BUG AND SHOULD BE FIXED.
>
> THIS RULE APPLIES TO CLAUDE CODE, CODEX, CURSOR, GEMINI, AND EVERY FUTURE PROVIDER."

KalCode is a transparent terminal/PTY host plus an orchestration layer. A provider launched by KalCode must be able to do everything it does when the user starts it in PowerShell or Terminal: read, edit, create and delete files; search; run shell commands, Git, builds and tests; use its native tools, web/research, MCP servers, plugins/extensions/skills and subagents; use provider-native commands; stream output, ask questions and take keyboard input; use its normal authentication, configuration, PATH and environment; handle long-running commands, interrupts, ANSI/colour/progress output and session resume.

- **Transparent launch.** The provider sees the correct executable, arguments, working directory, environment variables, PATH, HOME/user directories, provider config, authentication, terminal capabilities, stdin/stdout/stderr, dimensions, resize events, signals, exit codes, filesystem and Git environment. Never launch a provider in an artificially incomplete environment. A provider's environment is the user's own environment minus KalCode-internal variables (`KALCODE_*`, `WEBVIEW2_*`, `WEBKIT_INSPECTOR*`), with the launch hardening in `crates/providers/src/env.rs`.
- **Real capability over stubs.** If the provider has a native capability, use it. Replace it with a KalCode stub only for a genuine technical reason, recorded in the capability matrix. KalCode additions (panes, Agent Fleet, account routing, usage, KalVoice, Browser, Runs, Queue, Needs You, orchestration, workspace restoration) sit around the provider and never reduce what it can do.
- **Configuration parity.** Launching through KalCode discovers the same legitimate configuration a native launch does: settings, MCP configuration, plugins, skills/extensions, agents, global and project instructions (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`), permission configuration and project configuration. Per-account profiles may isolate credentials and session state, but they must not hide the user's configuration unless the user explicitly chose a separate KalCode profile.
- **Interactive fidelity.** Real PTY/TTY behaviour: stdin forwarding, raw mode, keyboard shortcuts, Ctrl+C, resize, ANSI and cursor control, progress rendering, prompts and interactive selections, subprocesses, long-running processes, exit and restart. A provider must never fail because KalCode's terminal emulation is incomplete.
- **No KalCode capability ceiling.** KalCode must never be the reason a provider says "I cannot do that here." Reproduce NATIVE PROVIDER TERMINAL vs KALCODE PROVIDER TERMINAL, compare, and fix the difference.
- **Capability matrix.** Keep `docs/providers/native-parity.md` truthful: for each provider and capability, the native support and KalCode parity status. If the provider doesn't support something, don't fake it. If it does and KalCode doesn't, fix KalCode.
- **Security is not a limitation to remove.** Parity never bypasses provider authentication, OS security boundaries, credential protection (including the credential-file read deny floor), genuine destructive-action safeguards or provider-enforced restrictions. The goal is NO EXTRA KALCODE LIMITATION, not BYPASS REAL SECURITY.

## Permanent high-standard quality rule (owner directive 2026-10-04)

> "KALCODE IS HELD TO AN EXTREMELY HIGH STANDARD.
>
> FUNCTIONAL IS NOT ENOUGH.
>
> EVERY USER-FACING FEATURE, WORKFLOW, INTERACTION, AND VISUAL SURFACE MUST BE BEAUTIFUL, SIMPLE, FAST, POLISHED, RELIABLE, AND PRODUCTION-READY.
>
> NOTHING USER-FACING SHIPS BLAND.
>
> REVIEW THE ACTUAL RENDERED PRODUCT BEFORE SHIPPING.
>
> REMOVE FRICTION.
> PRESERVE RESPONSIVENESS.
> FIX WEAK DETAILS.
> KEEP KALCODE COMPETITIVE WITH THE BEST PRODUCTS ON THE MARKET.
>
> IF IT WORKS BUT DOES NOT FEEL FINISHED, IT IS NOT DONE."

This applies automatically to all KalCode work by Claude Code, Codex and future agents. It extends the visual quality, simplicity and responsiveness rules below.

- **The target is SIMPLE + BEAUTIFUL + FAST + POWERFUL.** Don't sacrifice one for another. Beautiful does not mean over-designed; powerful does not mean complicated; simple does not mean bland.
- **Not done** if it feels bland, unfinished, generic, clunky, slow, confusing, visually weak, poorly integrated or half-polished, or if it looks like prototype or placeholder UI, default framework components, generic developer tooling, cheap AI-generated design or a cluttered dashboard.
- **Every detail matters:** typography, spacing, alignment, hierarchy, icons, motion, hover/focus/loading/empty/error states, menus, buttons, terminal headers, panes, widgets, account selectors, agent cards, Browser, navigation, onboarding, Settings, responsive layouts, accessibility and performance.
- **Rendered review is required.** Look at the real rendered product before calling user-facing work complete. Ask: Does it look beautiful and premium? Is anything bland, confusing or unnecessary? Can a step be removed? Does it feel fast and native to KalCode? Would it stand beside the best products on the market? If not, polish it before shipping. Tests and code review alone are not enough for visual work.
- **UX.** Use the fewest safe steps. Infer what can be inferred safely. Act where the user already is instead of sending them to Settings. If the user must hunt, fix the UX. If three clicks can become one, make it one.
- **Performance.** Every click gets immediate feedback. Network calls, provider refresh, Git scans, usage checks, browser initialization and background processes run asynchronously. Animation makes KalCode feel better, never slower.
- **Reliability.** Beautiful UI on broken behaviour is unacceptable. Require correct behaviour, preserved state, graceful recovery, truthful status, clean errors, no fake provider state, no stale data and no hidden background failures (see the zero-known-issues rule).
- **Design language.** A deep graphite/near-black foundation, subtle space/depth atmosphere where appropriate, the electric-blue accent, premium typography, excellent spacing, restrained glow, strong hierarchy, smooth motion and state transitions, information-rich without clutter. Provider branding stays secondary; KalCode owns the hierarchy.
- **Competitive standard.** Study elite products (BridgeMind, T3 Code, Apple and other top developer/AI products) for interaction quality, density, motion, layout, clarity, responsiveness and polish. Never copy them; build an original KalCode implementation.

## Permanent zero-known-issues reliability rule (owner directive 2026-10-04)

> "KALCODE SHOULD STRIVE FOR ZERO KNOWN USER-FACING ISSUES.
>
> IF WE KNOW ABOUT A BUG OR BROKEN EXPERIENCE, IT IS NOT 'GOOD ENOUGH.'
>
> FIX KNOWN ISSUES QUICKLY, FIX ROOT CAUSES, VERIFY THE REAL USER FLOW, AND SHIP THE FIX.
>
> HIGH QUALITY INCLUDES RELIABILITY."

Bugs, crashes, broken workflows, stale state, failed provider integrations, updater failures, inconsistent UI state, hidden errors, orphan processes, broken navigation and regressions are never accepted as normal. This applies automatically to all KalCode work by Claude Code, Codex and future agents.

- **Loop:** REPRODUCE → FIND ROOT CAUSE → FIX IT → TEST THE ACTUAL FAILURE → AUTO-MERGE → AUTO-SHIP → VERIFY USERS RECEIVE THE FIX.
- Don't leave known bugs in the product unnecessarily. Don't hide broken behaviour behind a UI patch; fix the underlying behaviour.
- Prevent issues with focused regression tests, truthful state handling, safe recovery, provider/session isolation, good error handling, restart/reconnect testing, update-path verification and real production checks.
- A bug found during other work is fixed, or reported to the owner as open with its reproduction. It is never silently ignored.

## Permanent terminal containment and agent identity rule (owner directive 2026-10-03)

An agent is always a real provider coding terminal/session in Code. Agent commands never create chat Threads. Opening four Claude Code agents creates four fresh Claude Code terminals in the current workspace; opening six Codex agents creates six fresh Codex terminals. Each binds its provider account, exact model, effort and working directory. Agent Fleet focuses that same terminal. Threads remain a separate product concept. Preserve terminal identity through resource waits, retry, restoration and runtime errors; never fall back to chat execution or Threads navigation.

KalCode agents must never spam the Windows desktop with external terminal windows. User-visible shell work runs inside KalCode's integrated PTY; background work runs headless/hidden and must never steal focus. Do not spawn Windows Terminal, cmd, PowerShell or another external console unless the user explicitly requests one. Prevent window creation at the owning spawn boundary; minimizing or hiding a window after creation is not a fix. Deduplicate active logical jobs, bound retries, and terminate owned child processes on cancellation/completion without disturbing unrelated user work.

For Codex tool execution on Windows, use the existing PTY execution mode (`exec_command` with `tty: true`) so commands stay contained. Any explicitly launched background helper must use the platform's no-window creation mechanism (`windowsHide`, `CREATE_NO_WINDOW`, or `Start-Process -WindowStyle Hidden` as applicable). Test the actual owning spawn path and observe window/focus events; reduced popup frequency is not completion.

## Permanent provider tool capability rule (owner directive 2026-10-04)

"KALCODE MUST NOT BREAK OR STRIP AWAY A CODING PROVIDER'S LEGITIMATE TOOL CAPABILITIES.

PROVIDER SESSIONS INSIDE KALCODE SHOULD RETAIN THEIR NATIVE FILE, SHELL, SEARCH, MCP, BROWSER/RESEARCH, AND OTHER TOOL CAPABILITIES WHERE THE PROVIDER SUPPORTS THEM.

TOOL CALLING MUST FLOW CORRECTLY THROUGH THE PROVIDER ADAPTER, EXECUTION HOST, AND RESULT PATH.

DO NOT APPLY PROVIDER-SPECIFIC HACKS WHEN THE BUG BELONGS TO THE SHARED TOOL/ADAPTER ARCHITECTURE.

NORMAL SAFE DEVELOPMENT TOOL USE SHOULD NOT BE BLOCKED BY KALCODE-INTERNAL PERMISSION FRICTION."

- KalCode's hook channel (`kalcode-hook`, `crates/hook-bridge`) **observes** ordinary provider sessions. A KalCode-side failure (slow, busy, restarting, updating, unreachable, stale session, oversized input) must never block or prompt for a tool call: the provider's own permission system decides. Only engine routing passes `enforce` and fails closed.
- Launch flags must not remove native tools. No blanket `--strict-mcp-config`, `mcp_servers={}`, `web_search='disabled'`, MCP sentinels, `--extensions none`, or feature switches that turn off provider-native tools. Plan mode keeps the provider's own read-only research tools (web search/fetch, read-only shell).
- Repository-supplied configuration that would run with no trust prompt (for example `.mcp.json` servers in Claude's `-p` mode) stays out; the user's own configured servers and tools are passed through.
- Each adapter declares its tools truthfully in `ProviderCapabilities.tools` (native, needs configuration, or unavailable with the real reason). Never fake a tool, and never tell a provider the whole tool system is unusable when one capability is missing.
- When a tool genuinely fails, surface the real reason (MCP server unavailable, provider session expired, not supported by this provider, execution host failed), never a generic harness refusal.

## Permanent provider-agnostic rule (owner directive 2026-10-04)

"KALCODE IS PROVIDER-AGNOSTIC BY DEFAULT.

EVERY CORE FEATURE, WORKFLOW, FIX, AND UX IMPROVEMENT SHOULD WORK ACROSS ALL CURRENT AND FUTURE CODING PROVIDERS THROUGH SHARED KALCODE SYSTEMS.

PROVIDER-SPECIFIC DIFFERENCES BELONG INSIDE CLEAN ADAPTER/CAPABILITY LAYERS.

DO NOT HARD-CODE KALCODE AROUND CLAUDE CODE, CODEX, CURSOR, GEMINI, OR ANY ONE PROVIDER.

IF A FEATURE CAN BE SHARED, BUILD IT ONCE.

IF PROVIDER CAPABILITIES DIFFER, HANDLE THE DIFFERENCE TRUTHFULLY AND GRACEFULLY."

- Applies to Code, coding agents, terminals, Agent Fleet, Accounts, Usage, Models, KalVoice, Runs, Queue, Squads, Handoffs, Launch Recipes, Stuck Agent Detection, Agent File Ownership, KalTidy, Unified Memory, Live Browser, tool calling, external APIs, provider session persistence, permissions, navigation, orchestration, automatic routing, status, model selection and account switching. Assume each works with Claude Code, Codex, Cursor, Gemini and future providers unless a real technical reason prevents it.
- Core features talk to one shared provider interface (KalCode core → shared provider capability layer → per-provider adapters). Do not scatter `if Claude … else if Codex …` through the product; keep provider-specific behavior inside the adapter/capability layer.
- Ask "does this provider support this capability?" (multiple accounts, model selection, reasoning/effort, usage reporting, session resume, MCP, web/search, subagents, tool calling, file editing, terminal execution, native plugins/extensions), never "is this Claude Code?".
- No fake parity. Use a capability when the provider has it; otherwise show a truthful fallback ("Usage unavailable", "Model selection controlled by provider", "Session resume unsupported"). Never invent provider features to make the UI look consistent.
- For every provider, an agent is a real coding terminal/session (four Cursor agents = four Cursor coding terminals). Never turn one provider's agent into a Thread while another gets a terminal.
- Every provider account joins the same canonical account system (nickname, identity, plan, auth state, health, usage, reset time, models, default where supported) with consistent UI and behavior.
- KalVoice is provider-independent and routes through the same provider/orchestration layer ("launch four agents" uses context/default; "launch two Codex agents using Codex B" uses Codex B; "open the agent that just finished" opens whichever provider owns it).
- Unified Memory belongs to KalCode and the workspace, not to any provider; every provider consumes relevant project memory through the same KalCode memory system.
- The Code tab treats providers consistently; the + launcher offers each provider, Terminal, Live Browser and Widget. New providers plug into the existing Agent Fleet, Runs, Queue, Accounts, KalVoice, Usage UI, KalTidy, Handoffs, Squads, Unified Memory, terminal lifecycle and navigation without rebuilding them.


## Permanent multi-shipper / parallel release rule (owner directive 2026-10-03)

> "KALCODE HAS NO SINGLE SHIPPER TERMINAL.
>
> ANY VALIDATED CODING AGENT/TERMINAL MAY MERGE WORK AND INITIATE SHIPPING.
>
> MULTIPLE RELEASE JOBS MAY BUILD, PACKAGE, SIGN, VALIDATE, AND PREPARE IN PARALLEL.
>
> ONLY THE FINAL SHARED PRODUCTION-PUBLISH MUTATION MAY USE A SHORT EXCLUSIVE LOCK.
>
> NEVER LET ONE RELEASE DRIVER HOLD THE WHOLE SHIPPING PIPELINE FOR HOURS.
>
> NEWEST VALID BUILD WINS.
> OLDER RELEASE JOBS MUST NOT OVERWRITE NEWER PRODUCTION BUILDS.
>
> LONG RELEASE QUEUES CAUSED BY ONE GLOBAL SHIPPER ARE A PIPELINE BUG."

This replaces the single-release-driver model, including the old "one release at a time" and `target/lanes/release.lock` slot rules. Where an older instruction conflicts, this rule wins.

- **Any terminal ships.** Any coding agent that finishes validated user-facing work merges it and starts its own release job: OWNER REQUEST → BUILD → FOCUSED VALIDATION → AUTO-MERGE → AUTO-START RELEASE JOB → BUILD/PACKAGE/SIGN IN PARALLEL → SHORT FINAL PUBLISH LOCK → USERS RECEIVE NEWEST BUILD → VERIFY → CLEAN UP. It never hands work to a special shipper. The release harness is the shared executor. No owner approval is needed for normal validated work, and no job waits for a new public version.
- **Release jobs run concurrently.** Build, packaging-relevant tests, Windows and macOS packaging, signing, notarization, artifacts, release metadata, upload preparation, staging uploads, updater-metadata preparation and smoke validation may all run for several builds at once. No lock may cover any of that work.
- **Release job identity.** Every job is identified by commit SHA, internal build number, public version and release job ID. Jobs never share mutable temporary state: each uses its own build, staging and state directories (for example `target/release-pipeline/<version>-<sha12>`). A genuinely shared physical resource, such as one QA account or one signing device, is held only for the minutes it is used, never across a whole release.
- **Platforms are independent.** Windows build/sign/package never waits on macOS, and macOS build/sign/notarize never waits on Windows. When stable publication needs both platforms, prepare both concurrently and wait only at the final publish boundary.
- **Only the final production mutation is serialized.** Mutating shared production state (stable updater feed, stable release pointer, latest-build metadata, canonical production manifest, final publication record) takes a short exclusive lease, `target/lanes/publish.lock` (one line: session, job, commit, build N, UTC start). Hold it only around the atomic feed/pointer write and its immediate readback, never during builds, signing, notarization or QA. A lease older than 30 minutes, or held by a session that no longer appears in ListAgents, is stale, and any session may take it over.
- **Newest valid build wins; the feed only moves forward.** Inside the lease, read the live feed's build number first. If live ≥ this job's build N, do not publish. Record the job as SUPERSEDED (artifacts may finish and be kept as evidence) and retire it. An older job never overwrites a newer published build.
- **Scope blockers to the smallest component.** A Mac-only blocker never freezes Windows preparation, and a Windows QA blocker never stops macOS packaging. A signing problem with one artifact never stops another build from compiling. One QA decision, old build, open app instance or release-driver session never holds the release system hostage unless there is a real technical dependency.
- **Failure and supersession.** A failed job never stops the other jobs: isolate it, then fix and retry only that job or component. When a newer build contains the same changes and ships, mark the older blocked job SUPERSEDED and retire it safely. Never finish obsolete releases in order.
- **Shipped** still means: the user closes KalCode, reopens it, the production update path serves the newest valid build, and the feature is there.

## Permanent build cache and build machine rule (owner directive 2026-10-04)

**KEEP THE BUILD CACHE. NEVER FORCE A FULL REBUILD.** Release builds on the Mac and on Windows reuse the warm compiled cache (`target/`, including Cargo `.fingerprint` and incremental data) from the most recent build of the nearest commit. Never delete Cargo fingerprints, incrementals or the release `target` before a release build, and never start from a cold clone when a warm one exists. Cargo's own fingerprinting decides what is stale, so a warm cache is correct, not a shortcut. The only exception is a targeted removal of one artifact that is proven to be wrongly reused, such as `guardian-packaging.mjs` and `hook-packaging.mjs` forcing their one binary to relink; never remove a whole cache. A slow cold rebuild is a pipeline bug to fix.

- **Release builds always run on the owner's main Windows PC** (and the Mac for macOS). Building, signing and packaging never move to another machine.
- **The build PC runs everything (owner directive 2026-10-04: it now has 64 GB of RAM).** Gates (`kalcode-win-gate`, label `kalcode-gate`), builds, tests and QA run on the owner's main Windows PC. Do not use the second Windows machine (`kalcode-win-gate-2`, `kalcode-win-desktop-qa`) for gates, QA or anything else.

## Permanent fastest truthful release policy (owner directive 2026-10-02)

**KALCODE OPTIMIZES FOR THE FASTEST TRUTHFUL PATH FROM CODE TO USERS.**
This directive applies to Claude Code, Codex, and future agents. It replaces older release-gate instructions wherever they impose unnecessary delay, repeated validation, arbitrary waiting, broad checklists, or release ceremony. It takes precedence over conflicting historical instructions below and in release kits, campaign documents, and automation. Keep older evidence; remove irrelevant gates from the critical path.

Default lifecycle: **IMPLEMENT -> TEST WHAT CHANGED -> REVIEW -> MERGE -> BUILD -> SHIP -> VERIFY -> CLEAN UP.** Use the fastest technically safe merge, build, shipment, and production verification.

**Owner reaffirmation (2026-10-03), verbatim. This is the core KalCode engineering rule:**

> "KALCODE ALWAYS USES THE FASTEST CORRECT PATH FROM OWNER REQUEST TO USERS.
>
> BUILD THE REQUESTED WORK.
> VALIDATE THE RELEVANT CHANGE.
> AUTO-MERGE TO MAIN.
> AUTO-SHIP IMMEDIATELY.
> VERIFY USERS CAN RECEIVE IT.
> CLEAN UP.
>
> DO NOT ADD UNNECESSARY QA, APPROVALS, WAITING, RELEASE CEREMONY, OR VERSION GATES.
>
> FASTEST POSSIBLE WHILE STILL WORKING CORRECTLY IS THE DEFAULT."

Fastest possible does not mean careless: maximum speed with high quality and correctness. Don't stop between stages without a real blocker. On a blocker, IDENTIFY → FIX → RERUN ONLY THE INVALIDATED CHECK → CONTINUE, never restarting the pipeline. Long releases are pipeline problems to fix, not something to accept. These practices, learned on the 2026-10-03 trains, keep it fast:

- **Trains are for gates, not releases.** Combine ready PRs on one `train/<topic>` branch to share one gate run. Releases are not serialized: see the multi-shipper rule. Any session starts its own release job, and only the final feed write takes `target/lanes/publish.lock`.
- **One gate per train, on idle runners.** The PR's Gate (Windows) job runs the full `ship.mjs gate` on the shared Windows PC. Don't run a second full gate locally at the same time, and don't run heavy local cargo/Playwright work while a release is packaging: contention causes timeouts and memory-guard aborts. Use local `--only <lanes> --keep-going` for fast diagnosis.
- **Speculative builds.** Start the signed Windows and macOS builds from the exact commit under test while its gate runs. Publish only after the gate passes and the commit is on main. If only test files change afterwards, the build stays valid.
- **Rerun only what changed.** After a fix, rerun the invalidated lanes, not the whole gate. Classify every remaining failure truthfully: train regression, intended behavior with a stale test, already failing on main, or environmental. Only real product risk blocks shipping. Record the classification and file follow-ups.
- **Update tests with behavior.** When a change alters a default, schema version, launcher structure or spec inventory, update the unit, UI and native e2e specs that encode it in the same PR. Check `git merge-tree` against other open PRs touching the same files, not just main.

### Only relevant risk may block delivery

Every gate must answer: **What specific realistic failure does this gate protect against for this change?** If it has no strong answer, it must not block merge or release.

Do not block on arbitrary waiting or soak periods, giant generic QA checklists, unrelated suites, repeated valid tests, inapplicable historical procedures, automatable owner steps, a new public version, unfinished unrelated features, reopening completed work, just-in-case audits, broad cross-product regression for isolated edits, or duplicate review of unchanged code.

For each change, identify its affected surface and realistic failure modes, run the smallest tests that control those risks, reuse valid evidence, and ship. A small UI fix needs focused UI proof and the relevant build; a terminal change needs terminal and affected integration proof; billing needs billing/entitlement proof; updater/release changes need package/update-path and signing proof. Do not run unrelated tests merely because they exist.

**Valid evidence stays valid until the change invalidates it.** Do not repeat a test, QA flow, signing/platform check, or release proof when its implementation and dependencies are materially unchanged, its environment remains valid, and no new failure evidence exists. Rerun only what was invalidated.

### Merge and ship immediately

When implementation is correct, reviewed proportionately, and relevant tests pass, merge through the normal PR path. Resolve actual conflicts; do not manufacture process or hold independent completed work for unrelated work. Preserve one canonical writer for conflicting surfaces.

Merged is not done. User-facing work proceeds automatically through the current build, required packaging/signing, publication, updater availability, and focused production proof. Public versions are owner-controlled labels, never shipping gates. Ship internal builds under the current public version; only an explicit owner declaration changes the public version, consistently across affected surfaces.

No two-session/no-commit rule may stall useful progress. Commit coherent validated units incrementally; avoid both giant uncommitted batches and arbitrary commit ceremony.

### Merged to main = ship immediately (owner directive 2026-10-02)

**IF USER-FACING KALCODE WORK IS MERGED TO MAIN, SHIP IT IMMEDIATELY. MERGE AND SHIPPING ARE ONE CONTINUOUS PIPELINE. DO NOT LEAVE COMPLETED USER-FACING WORK SITTING ON MAIN. SHIPPING SHOULD BE FAST, AUTOMATED, FOCUSED, AND LIMITED TO REAL RELEASE-CRITICAL WORK.**

Flow: IMPLEMENT → TEST RELEVANT CHANGES → REVIEW → MERGE TO MAIN → BUILD CURRENT VERSION → PACKAGE / SIGN AS REQUIRED → PUBLISH → UPDATE FEED → USERS CAN RECEIVE IT → QUICK PRODUCTION VERIFICATION → CLEAN UP.

- **Never wait for:** another feature, another public version, another owner message, a future release window, an arbitrary batch, unnecessary QA replay, unrelated testing, or release ceremony.
- **Test before merge.** After merge, run only the release-critical proof: the build succeeds, packaging succeeds, signing/notarization succeeds, publishing succeeds, update distribution is correct, the app launches, and the changed functionality is available. Re-run nothing else unless the change invalidated it.
- **Parallelize the release:** Windows and macOS builds, updater metadata while binaries build, website and release metadata while packaging runs, concurrent uploads, and concurrent non-conflicting smoke checks.
- **The current public version ships.** Multiple builds may go out as the same public version, told apart by internal build identifiers. Only the owner changes the public version.
- **Blockers:** build failure, broken package, signing/notarization failure, publish/upload failure, updater/feed failure, production regression, billing/entitlement failure (if affected), a security/integrity issue, or a genuinely required missing credential.

  Handle a blocker with: FIX → RERUN ONLY WHAT WAS INVALIDATED → CONTINUE SHIPPING. Never restart the whole release.
- **Automate the routine:** merge continuation, builds, packaging, the signing workflow, publishing, updater metadata, artifact upload, website/release references, production smoke checks and safe cleanup. Involve the owner only for a real approval, credential, ambiguity or risky irreversible action.
- **Keep it fast.** If a release takes far longer than the underlying build, sign and publish work, investigate and simplify the release pipeline. Don't accept the delay as normal. Keep optimizing so completed work reaches users as fast as the build, signing and distribution systems allow.

### Shipped means existing users receive it (owner directive 2026-10-02)

For user-facing work, "shipped" means the update is actually available through KalCode's production update path: merged → build → sign/package → publish → production update feed live → the user closes KalCode → reopens it → KalCode receives and applies the new build → the new feature is available. Merging, building an installer, uploading an artifact or creating a release entry is not shipping. After every user-facing shipment, verify on Windows and macOS that an existing installed KalCode receives the new build through the normal close/reopen experience. The owner must never need to download and reinstall KalCode by hand for a normal update. If close/reopen does not deliver the build, shipping is not complete: fix the update path and continue.

### Fastest truthful path from main to users (owner directive 2026-10-02)

**KALCODE RELEASES MUST USE THE FASTEST TRUTHFUL PATH FROM MAIN TO USERS.** Once user-facing work is merged to main, shipping begins immediately.

- **Parallelize.** Run release stages in parallel whenever it is safe; never serialize independent build, sign, package or publish work. Examples: Windows and macOS builds together; two builds side by side; notes, metadata and website while binaries build; update-feed preparation before the artifacts finish.
- **No repeats, no waits.** Never repeat QA that is still valid. Never add arbitrary waits. Every blocking gate must name the specific failure it prevents right now.
- **Bootstrap builds.** If an intermediate bootstrap build is genuinely required, prepare the final build concurrently, so it can publish the moment the dependency clears.
- **Slow releases are bugs.** A long release is a pipeline problem to investigate and optimize, not something to accept as normal. Record per-release timings (merge, build start/end, sign, package, notarize, upload, publish, feed live, user-receivable verified) and use them to remove recurring bottlenecks.
- **Shipped.** An existing user can close KalCode, reopen it, receive the production update and use the new feature.

This supersedes older release-gate behavior that delays publication.

### Build → auto-merge → ship; versions are marketing labels (owner directive 2026-10-02)

**KALCODE DEVELOPMENT IS CONTINUOUS.** The owner gives an agent something to build. The agent builds it, tests the relevant change, reports or shows the result, and **merges it to main automatically. Owner approval is not needed to merge.** Merging user-facing work to main automatically ships it to users in one continuous pipeline: build the current public version → sign/package → publish → production update feed → users receive it → quick production verification → cleanup.

- **Never wait for:** a separate "ship" command, another feature, a batch, a version change, a marketing video, a release date, unrelated QA, a soak period, or release ceremony.
- **Post-merge work is release-critical only.** Prove the build, the package, signing/notarization, publishing, the update feed, that users receive the build, and that the changed feature works in production. Keep still-valid evidence.
- **Stop only for real blockers:** a build, packaging, signing, updater or production failure; a security/integrity issue; an affected billing/entitlement failure; user-data safety. On a blocker: fix → rerun only what the fix invalidated → continue.
- **Versions are labels, not gates.** Public version numbers are owner-controlled **marketing labels**. They never control building, merging or shipping, and many builds can ship under the same label. "Change KalCode to 0.1.10" is a simple, consistent version-label switch (app, package, installer and updater metadata, About, website, release metadata). Then keep building, with no rebuilt features, re-run QA, reopened work or release ceremony. Never question whether there are "enough changes" for a version.
- **Release history.** Keep lightweight, truthful release history (git history, docs/releases, notes) so "what did we add for 0.1.10?" or a launch video can be answered from real history. It is metadata, never a gate. Never invent features.

### Automatic merge rule (owner directive 2026-10-02)

**Owner approval is NOT required for normal validated KalCode work.** Once the requested work is complete, the relevant change is tested, the implementation is confirmed correct, relevant failures are resolved and no blocker is known, **MERGE TO MAIN AUTOMATICALLY**. Never ask "Should I merge this?".

The flow is OWNER REQUESTS → BUILD → TEST → REVIEW INTERNALLY → MERGE AUTOMATICALLY → SHIP AUTOMATICALLY → VERIFY USERS CAN RECEIVE IT → CLEAN UP. Merging and shipping are part of completing the task.

Stop before merging only for a real reason:
- conflicting requirements, or destructive or irreversible ambiguity;
- failing relevant tests, or an unresolved merge conflict;
- a security or data-integrity concern, or a missing required credential;
- real uncertainty about whether the requested behavior is desired.

### Automate and parallelize safely

Automate builds, tests, metadata, configured signing, publication, updater metadata, website release references, production checks, and cleanup. Do not require routine manual steps merely because old procedures did. Ask the owner only for a real decision, unavailable credential/action, irreversible risk, or ambiguity.

Run useful independent work concurrently: Windows and macOS builds, release notes and tests, website and packaging, independent verification, and non-conflicting artifact preparation. Do not serialize unrelated steps. Read-only agents may review in parallel; conflicting writes have one owner.

KalCode supports Windows and macOS where the feature applies. Test platform-specific behavior on the affected platform, validate shared changes appropriately on both, and reuse unchanged platform evidence instead of blindly repeating every test.

### Real blockers and non-negotiable integrity

Real blockers include failing relevant tests, reproducible regressions, correctness-affecting merge conflicts, missing signing/notarization capability or credentials, broken packages/deployments/update paths, billing or entitlement mismatches, security/integrity defects, and ambiguity that risks user data or production.

On failure: **FAILURE -> ROOT CAUSE -> FIX -> RETEST AFFECTED SURFACE -> CONTINUE.** Fix it immediately where possible. Do not restart the whole release or run unrelated suites after a small fix.

Speed never overrides code-signing integrity, notarization, credentials/secrets, billing/entitlements, updater integrity, or user-data safety. Make applicable checks fast and automated, not optional.

### Focused production proof and completion

Verify the smallest facts proving delivery: correct version/build served, updater can receive it, app launches, changed behavior works, and relevant backend, billing, or website surfaces work when affected. Do not add giant post-release ceremonies. Once production truth is established, finish.

After shipping, preserve required artifacts/evidence and apply the permanent safe storage policy. Remove only proven-obsolete Rust/Cargo targets, packaging intermediates, temporary data, duplicate builds, and abandoned build outputs. Never delete source, current work, active worktrees, current certified artifacts, evidence, credentials/signing material, or uncertain items.

**DONE = implemented + relevant tests pass + reviewed + merged + built + signed/packaged where required + published + user-receivable + focused production verification passes + safe cleanup complete.** Code written, tests passed, or merged alone is not done.

This file is the canonical engineering and release policy for every agent working in this repository: Claude Code, Codex, and any future agent. `CLAUDE.md` imports it. If another instruction file conflicts with this one, this one wins, unless the owner explicitly overrides it in the conversation.

## Permanent account-aware launch rule (owner directive 2026-10-03)

Every entry point for a new provider terminal, coding agent or thread follows the same account rule on Windows and macOS: use the provider's sole account automatically; when several accounts exist, show a clean account picker immediately in the launch flow. Never require a Settings visit to choose or connect an account.

- Reuse the shared `LaunchAccountPicker` and canonical provider account/session APIs. Show restored identities while slower provider/model discovery runs; preserve the exact selected account, workspace defaults and draft through background updates.
- Missing or expired accounts use the existing provider-owned sign-in flow inline. Preserve authentication, entitlement and provider approval boundaries; account selection never implies permission to bypass them.
- Ordinary shell terminals do not require a provider account. Agents remain real coding terminals; Threads remain separate.

## Permanent definition: AGENT means a coding agent (owner directive 2026-10-02)

**Creating a new KalCode coding agent always creates a fresh live provider coding session. Multi-agent launch creates N independent provider processes and terminal sessions, subject to provider-account and real hardware/resource limits; KalCode imposes no local coding-agent or terminal plan caps. New agents must never inherit ended or failed state from historical sessions. Agent UI state reflects the real provider process: starting or waiting during initialization, live only after successful creation, and failed only for an actual failure.**

New-agent creation and historical restoration are separate lifecycle paths. Use fresh agent, provider-session and PTY identities for new launches; sharing a provider account never means sharing a runtime identity. Resume preserves the historical agent's conversation while creating a new process instance. Ship and verify every required runtime helper beside the application on Windows and macOS, including `kalcode-hook`; a missing helper or failed spawn must report its real cause, never an "earlier run" explanation.

"IN KALCODE, AN AGENT IS A REAL CODING AGENT RUNNING IN A CODING TERMINAL/PANE.

AGENT IS NOT A THREAD.

'START SIX CLAUDE CODE AGENTS' MEANS LAUNCH SIX CLAUDE CODE CODING TERMINALS.

'START THREE CODEX AGENTS' MEANS LAUNCH THREE CODEX CODING TERMINALS.

THE AGENTS TAB / AGENT FLEET REPRESENTS THESE REAL CODING AGENTS AND OPENS THEIR ACTUAL CODE TERMINALS.

THREADS REMAIN A SEPARATE PRODUCT CONCEPT."

This applies to Claude Code, Codex and every future agent, in product code, UI copy, KalVoice and orchestration.

- **Agent** = a real provider coding session (Claude Code, Codex, Gemini CLI) running in its own terminal pane in Code, with a provider, account, exact model, effort, workspace, worktree/branch where relevant, live status and current task. N agents = N panes.
- **Thread** = the chat-oriented surface in Threads. Never implement, list, count or open an agent as a Thread, and never call a thread an agent.
- In storage, coding sessions retain their existing record IDs and are identified by `runtimeKind: "interactive_pty"`, stamped from the durable provider-pane marker before resource admission. This shared storage does not make an agent a chat Thread. Agent surfaces read `useCodingAgents()`; opening an agent uses `uiIntents.focus({ kind: "agent", agentId, workspaceId })`, and Code persists `{ kind: "agent", agentId }` pane content. Never route an agent through a Thread focus target or fall back to a headless chat when its terminal runtime is unavailable.
- Code's **New agent** launcher (+) chooses provider → account (only when there are several) → exact model → effort → count, and starts that many panes. KalVoice "start six Claude Code agents" launches six panes; "show my agents" / "Agent Fleet" opens the Fleet on the Dashboard; "the agent that just finished" means the latest finished coding agent.
- Agents rail, Agent Fleet, Needs You counts, widgets, Squads, Handoffs, Queue, Runs and future automation use this same definition. Do not create an alternate one.

## KalVoice integration rule (owner directive 2026-10-01)

Codex and Claude Code share this policy, including the release lifecycle enforced by Claude's `tooling/release/ship.mjs lifecycle hook`. Apply the same delivery requirements regardless of agent. Reuse KalVoice's existing local speech, routing, provider authentication, workspace, terminal, app-control, and release systems. Prioritize working scene awareness, natural targeting, navigation, multi-agent launching, terminal prompting, follow-up context, focus illumination, and meaningful completion callbacks. Optional voice polish must not delay validated core improvements. Preserve native provider approvals and truthful account, plan, and hardware limits. Ship through the normal gates as the next internal build of the current public version on both Windows and macOS; do not create a new public version or treat a merge as delivery.

**No separate KalVoice approval layer (owner reaffirmed 2026-10-01).** This applies to every user, including Owner. A voice action uses the same authenticated account, entitlements, and canonical action path as the corresponding app action. Do not add a KalVoice permission prompt or require users to approve KalVoice itself. Existing app and provider authorization remains authoritative; voice must not impersonate an approval response or bypass a provider sign-in requirement. Target clarification selects an object or account and is not an approval gate.

## Completion requires verified delivery (owner reaffirmed 2026-09-30)

**MERGED IS NOT SHIPPED. BUILT IS NOT SHIPPED. DONE means users can receive the validated update and live production has been verified.**

After implementation, tests, review, and merge, immediately continue through the current-public-version build, required signing and packaging, publication, update availability, and live production verification. For public 0.1.8, publish a newer internal 0.1.8+N build; never wait for 0.1.9 or describe assignment to a future build as completion.

If another agent or session owns the release lane, actively coordinate the handoff and follow it through publication and production verification. A handoff alone is not completion. If GitHub Actions cannot run, determine whether the approved local release pipeline can safely perform the required gates, build, signing, publication, and verification; use it when permitted. Never bypass a required gate.

Stop only for a real external blocker, such as unavailable credentials, broken signing infrastructure, or a required human action. Report the exact blocker immediately, with the affected step and next action. Do not claim that CI billing prevents shipping unless the approved local path also cannot complete the release. This is permanent repository memory for future Claude Code and Codex sessions.

## Permanent release infrastructure rule: self-hosted release runners (owner directive 2026-09-30)

**GitHub-hosted Actions minutes or billing must never block KalCode from shipping.**

- The owner's main Windows PC is the trusted self-hosted **Windows** release runner. The owner's Mac is the trusted self-hosted **macOS** release runner.
- Release and signing credentials stay on the trusted machine that needs them. They are never exposed to untrusted branches or pull-request jobs. Release jobs run only for merged `main` or other trusted refs.
- GitHub may coordinate the workflow, but the heavy build, sign, notarize and package work runs on our own machines.
- Keep the existing trusted artifact and update hosting (the kalcoded.com release authority and signed update feed) unless something else is clearly a better fit. The updater needs only a trusted published artifact and feed; shipping does not require GitHub-hosted runners.
- Target flow after a change passes its gates and merges:
  1. The self-hosted release workflow starts automatically.
  2. Windows: build, sign, package.
  3. macOS: build, sign, notarize, package.
  4. Publish the current-public-version internal build (for example 0.1.7+N).
  5. Update the feed so users can receive it.
  6. Verify production.
- Never wait for a new public version number.
- If CI billing or minutes are the blocker, replace that dependency with self-hosted execution.
- Implement this with the smallest technically correct change. Preserve the existing release pipeline (`tooling/release/ship.mjs`), signing infrastructure and valid evidence. Do not rebuild the release system.

## Permanent cross-platform rule

Unless the owner explicitly says otherwise, every new KalCode or KalVoice feature, fix, UI behavior, workflow, automation, and product capability must support **both Windows and macOS**. This is a universal engineering rule for all future work.

- Deliver support for both platforms as part of the same task. Never treat the other platform as future work or call a single-platform implementation complete.
- Keep user-facing behavior and the product experience as consistent as possible across Windows and macOS.
- Use platform-native implementations where required. Different low-level code is acceptable; the product experience should still match.
- Account for both platforms during design, implementation, testing, and release verification. Report any unverified platform behavior honestly.
- Only an explicit owner instruction can narrow a task to one platform.

## Permanent responsiveness rule (owner directive 2026-10-02)

**KALCODE MUST FEEL INSTANT. USER INTERACTION MUST NEVER WAIT ON WORK THAT CAN SAFELY HAPPEN ASYNCHRONOUSLY. EVERY CLICK SHOULD RECEIVE IMMEDIATE FEEDBACK. LATENCY IS A PRODUCT FEATURE.**

- Every click, key press, switch, open, close and navigation gets visible acknowledgement within about one frame: pressed state, highlight, pane appearing, spinner or status. The user must never wonder whether a click worked.
- Never block an interaction on network or provider calls, disk scans, Git, usage refreshes or telemetry unless the result is genuinely required first. Open the menu, pane or surface immediately, then fill it in place. Acknowledge agent actions at once and run them asynchronously.
- Keep the UI thread free. No slow work in sync Tauri commands, which run on the main thread. Use `#[tauri::command(async)]` or `spawn_blocking`. Never hold a lock across slow work on a UI path.
- Never recreate terminals, Browser instances or other expensive components unnecessarily. Avoid needless re-renders and app-wide state churn. Keep polling cheap and quiet when nothing has changed. Never add artificial delay or let an animation gate an action.
- Optimistic UI only when the operation is safe and reversible. Never fake speed by hiding failures or stale state: the UI responds immediately while truthful state catches up.
- Measure before and after on the real binary, and judge by p95 as well as p50. `apps/desktop/tests/perf/interactions.ts` measures input→next paint and input→visible per interaction, and `apps/desktop/tests/perf/run.ts` measures startup, IPC, memory and idle CPU (see `docs/PERFORMANCE.md`). Fix measured bottlenecks with the smallest correct change. Never rewrite working systems for theoretical speed, and never trade away correctness, safety or data integrity.

## Permanent Resource Governor rule (owner directive 2026-10-04)

**KALCODE'S RESOURCE GOVERNOR MUST PROTECT SYSTEM RESPONSIVENESS WITHOUT BECOMING AN ARTIFICIAL AGENT LIMIT. USER-REQUESTED CODING AGENTS SHOULD START IMMEDIATELY WHENEVER THE OS CAN REASONABLY RUN THEM. DO NOT BLOCK AGENT STARTUP MERELY BECAUSE CPU USAGE IS HIGH. THROTTLE OPTIONAL BACKGROUND WORK FIRST. ONLY DELAY USER-REQUESTED AGENTS FOR GENUINE HARD RESOURCE PRESSURE, AND SHOW THE REAL REASON.**

- **Priority, throttled from the bottom:** 1 KalCode UI, 2 user-requested coding agents, 3 builds/tests the user started, 4 important active services, 5 optional/background work, 6 indexing/maintenance/analytics.
- **Hard pressure only:** critically low available memory, disk effectively full, the OS cannot create another process, or severe exhaustion likely to crash. Then show the real reason (for example "Memory is critically low.") with actions such as [Run KalTidy] / [Start Anyway] where safe. Never a generic "CPU busy".
- **Never a fake concurrency cap.** Presets impose no agent count; only a limit the person set explicitly in Custom mode may hold an agent, and Start Anyway still applies.
- **Truthful statuses:** STARTING, READY, WORKING, WAITING, NEEDS YOU, DONE, FAILED. Never IDLE for an agent whose process hasn't started.
- **Provider-agnostic:** applies equally to Claude Code, Codex, Cursor, Gemini and future providers, and to every launch path (panes, New agent, KalVoice, user-initiated Squads and Handoffs).
- This replaces older conflicting governor/admission rules and is shared by Claude Code and Codex through this file.
- Implementation: `crates/resources/src/hard.rs` (hard-pressure thresholds), `evaluate_user_agent_admission` in `crates/resources/src/admission.rs` (user-requested agents), `evaluate_admission` (fail-closed background work). Tests in `crates/resources/tests/user_agent_admission.rs` and `apps/desktop/src-tauri/src/resource_commands_tests.rs` must keep proving that CPU load never holds a user-requested agent.

## Permanent parallel integration rule: the shared merge train (owner directive 2026-10-04)

> "KALCODE USES PARALLEL INTEGRATION. Any coding agent may finish and submit work for merge. Ready changes prepare, rebase, validate and form merge groups in parallel. Only the final atomic update to main is serialized. Compatible PRs are batched against the same main snapshot. One conflicting PR must not block unrelated completed work. Claude Code and Codex use the same merge queue. No agent may bypass it. Test the actual merge candidate, land it quickly, then ship immediately."

This replaces "merge it yourself", `gh pr merge`, hand-built `train/<topic>` branches and every other direct update of `main`. Every Claude Code and Codex session uses the same tool, `tooling/merge-train/train.mjs`; main changes only through it.

**1. Submit, never merge.** When your PR is validated (relevant tests pass, reviewed proportionately, `biome ci .` clean), queue it:

- `node tooling/merge-train/train.mjs submit <pr>` adds the `merge-queue` label. The queue is the open, non-draft, same-repository PRs carrying that label, in the order it was added. Never run `gh pr merge` and never push to `main`.
- Then drive the train yourself; any agent may, at any time, concurrently with others: `node tooling/merge-train/train.mjs run`. Nobody waits for a designated merger.

**2. What the train does.** `run` repeats build → gate → land until the queue is empty:

- **build** fetches main once (the snapshot BASE) and merges every queued PR head onto it with `--no-ff` merge commits (PR commits are kept, so GitHub marks each PR merged when it lands). It pushes the result as `merge-train/<base12>-<id>`. A PR that conflicts is skipped and told why: the files, and whether it conflicts with main (rebase it) or with PRs ahead of it (it retries on the next train). It never blocks the others. Two agents building at once on the same BASE get the same candidate; the branch is created atomically and the loser reuses it.
- **gate**: `gate.yml` runs "Gate (Windows)" on the exact candidate commit, against the BASE recorded in its `Merge-Train-Base` trailer, with `--keep-going`. A docs-only train still gates, but the gate selects no heavy stages for it.
- **land** fast-forwards main to the candidate only if Gate (Windows) executed successfully for that exact candidate push on the main Windows PC, every included PR head is unchanged and still queued, and main is still BASE (`--force-with-lease`, held under the short local `target/lanes/main-update.lock`). If main moved or a PR changed, `run` rebuilds on the new main automatically. A failed gate is bisected; a PR that fails alone is removed from the queue with a comment linking the failing gate.
- `node tooling/merge-train/train.mjs status` shows the queue, the candidates and their gate state. `build` and `land <merge-train/branch>` run single steps.

**3. No PR-specific bypass.** `land --pr` is disabled. Submit every ready PR to the same queue and gate its exact candidate, including compatible queued changes.

**4. After landing, ship.** `land` comments "Landed in main <sha>" on each PR, removes the label, appends `LANDED <sha> SHIP` to `target/lanes/merge-log.md`, and prints `SHIP <sha>` with the release-kit start command (`tooling/merge-train/on-landed.mjs`). Start that release immediately (multi-shipper rule). Main stays green: if a landed change breaks main, fixing it is the lander's top priority.

**5. Gate on the owner's main Windows PC (64 GB).** The train runs one candidate gate for compatible queued PRs. Never route gates or QA to the second Windows PC. The normal main push workflow may run again after landing; it does not replace the candidate's required evidence. Cancel gate runs for superseded branches. Docs-only PRs skip the PR gate (Markdown, `docs/**` except `docs/releases/**`, `marketing/**`).

**6. Announce shared hot spots.** Before submitting changes to KalVoice, threads/provider panes, release tooling, `AGENTS.md`, website deploy config, D1 migrations or the updater, send a one-line SendMessage to the live sessions (ListAgents). Never force-push, rebase or merge another session's branch without asking that session.

**7. Release jobs run in parallel; one website deploy at a time** (shared Worker); landing never waits for either.
- **Release.** Follow the multi-shipper rule. Any session starts a release job for the landed commit. Jobs build, sign and prepare concurrently in their own state directories. Only the final production feed/pointer write takes the short `target/lanes/publish.lock` lease, with a forward-only build-number check. `target/lanes/release.lock` is retired and blocks nothing.
- **Website.** Claim `target/lanes/website-deploy.lock`, deploy from main, verify the build stamp, then release the lock. If another release's publish is about to deploy the website, sequence after it and ping each other.
- **Takeover.** If a lock's session no longer appears in ListAgents (or a publish lease is older than 30 minutes), any session may take the lock over. A stalled older release job is superseded by any newer build that ships, never waited on.

## Permanent visual quality rule (owner directive 2026-10-02)

**FUNCTIONAL IS NOT ENOUGH FOR USER-FACING KALCODE. EVERYTHING USERS SEE MUST LOOK BEAUTIFUL, PREMIUM, INTENTIONAL, FAST AND UNMISTAKABLY KALCODE. NOTHING USER-FACING SHIPS BLAND. KEEP IT SIMPLE. KEEP IT BEAUTIFUL. KEEP IT FAST.**

**Scope.** This covers every surface a user or the owner sees:
- the desktop UI: Code tab, Threads, Browser, Agent Fleet, Operations, Account Hub, onboarding, settings, dialogs, menus, empty states, charts and widgets;
- dashboards, including owner and internal ones;
- websites, pricing and release pages;
- marketing assets, videos, and installers where visual.

It does not mean styling backend-only code, scripts, APIs or invisible infrastructure.

**Standard.** Every visible surface feels premium, intentional, polished, modern and cohesive. It is information-rich without clutter, visually impressive, easy to understand, and fast.

Never ship anything that looks like:
- default framework UI, a generic SaaS dashboard, or plain Bootstrap-style cards and random rectangles;
- unfinished developer tooling or bland enterprise software;
- cheap gamer UI, excessive neon, or AI-generated visual slop;
- a placeholder design.

**If the first implementation works but looks bland, it is not done.**

**KalCode design language.** Default to the established system:
- **Base:** a near-black/graphite foundation, with a deep-space/midnight atmosphere where appropriate.
- **Accent:** the signature electric-blue.
- **Type:** bright, high-contrast typography.
- **Surfaces:** restrained neutral borders, subtle depth, premium shadows, restrained glow, and clean glass/depth effects where useful.
- **Shape and spacing:** radii of about 10–14px; tight, deliberate spacing.
- **Motion:** smooth 160–260ms motion, plus subtle parallax/depth only when it genuinely helps.
- **Provider colours:** mainly small identity indicators. KalCode owns the visual hierarchy.

It should feel like a sophisticated AI engineering environment, not a bland IDE.

**Hierarchy.** Not everything is equally prominent. Decide what matters most, what the user needs next, and what stays secondary. Express that with scale, spacing, typography, contrast, position, motion and depth. Important things feel important; secondary things stay quiet.

**Motion makes KalCode feel alive.** Use pane transitions, hover feedback, animated state changes, subtle electric-blue focus, number/chart transitions, loading transitions, and polished open/close. Motion must communicate focus, state, movement, progress or causality, never mere decoration. It must never make the app feel slower.

**Beautiful also means fast** (see the responsiveness rule). The target is CLICK → IMMEDIATE RESPONSE → BEAUTIFUL TRANSITION → RESULT, never CLICK → WAIT → ANIMATION → RESULT. Never trade responsiveness for effects.

**Details matter.** Get these right:
- typography, alignment, spacing and icon consistency;
- button hierarchy;
- hover, focus, loading, empty, error and disabled states;
- tooltips, menus and scroll behaviour;
- responsive resizing, truncation, long content and high-density layouts.

A feature is not visually finished just because its happy-path screen looks good.

**Don't over-engineer.** Prefer SIMPLE + BEAUTIFUL + FAST over COMPLEX + FLASHY + OVERBUILT. Use the smallest technically correct implementation at a high visual standard. Never turn a small feature into a large redesign unless it is necessary (see Scope discipline).

**Final visual pass (required before user-facing work is complete).** Look at the actual rendered result: a screenshot, a Playwright run or the real app. Then ask:
- Does it look premium and unmistakably KalCode?
- Is anything bland or confusing?
- Does the hierarchy make sense, and does it feel finished?
- Is it still beautiful at realistic window sizes?
- Does it feel fast?

If any answer is no, polish it before shipping. Give subagents doing user-facing work these criteria explicitly.

**Owner reaffirmation (2026-10-03), verbatim:**

> "NOTHING USER-FACING IN KALCODE SHIPS BLAND.
>
> EVERY EXISTING AND NEW USER-FACING SURFACE SHOULD BE BEAUTIFUL, PREMIUM, POLISHED, FAST, SIMPLE, AND UNMISTAKABLY KALCODE.
>
> FUNCTIONAL IS NOT ENOUGH.
>
> REVIEW THE ACTUAL RENDERED UI.
>
> IF IT LOOKS GENERIC, UNFINISHED, CLUTTERED, OR BLAND, POLISH IT BEFORE SHIPPING.
>
> CODE IS KALCODE'S PRIMARY DAILY-USE SURFACE AND SHOULD RECEIVE THE HIGHEST LEVEL OF UX AND VISUAL QUALITY.
>
> USE OTHER GREAT PRODUCTS FOR INSPIRATION, NEVER FOR COPYING."

- **Inspiration, never copying.** Study excellent AI and developer products for hierarchy, density, motion, terminal and agent organization, and status visualization. Never copy their frames, layouts or branding. The result must be an original KalCode design.
- **No permanent clutter.** Don't add always-visible bars or chips that duplicate a dedicated surface (the bottom status strip was removed for this reason). Prefer more space for the work.

## Permanent simplicity and UX polish rule (owner directive 2026-10-03)

**KALCODE MUST BE EXTREMELY SIMPLE TO USE. EVERY WORKFLOW SHOULD USE THE FEWEST SAFE STEPS POSSIBLE. IF KALCODE ALREADY KNOWS SOMETHING, DO NOT ASK THE USER AGAIN. PUT ACTIONS WHERE THEY ARE NEEDED INSTEAD OF MAKING USERS HUNT THROUGH SETTINGS. CODE IS THE PRIMARY DAILY WORK SURFACE AND SHOULD RECEIVE FIRST-CLASS UX. EVERY USER-FACING SURFACE MUST BE BEAUTIFUL, FAST, POLISHED, AND UNMISTAKABLY KALCODE. SIMPLE DOES NOT MEAN BLAND. REMOVE UNNECESSARY FRICTION WITHOUT REMOVING USEFUL POWER.**

The goal is fewer clicks, less hunting, less configuration, less waiting and less repetition. This applies to Claude Code, Codex and every future agent, for every surface.

- **Fewest safe steps.** If three clicks can safely be one, make it one. Combine mechanical steps. When only one valid choice exists, use it automatically. When several exist, show the choice where the action happens, never behind a Settings detour.
- **Never ask twice.** Reuse what KalCode already knows: the current workspace, provider account, preferred model and effort, layout, previous choices, recent terminal, Browser URL and project path. Remember reasonable preferences across restarts.
- **No empty friction.** Remove confirmations that add no real safety, and modals where an inline action would do. Never remove a confirmation that protects user data, credentials, billing or running work.
- **Errors lead to recovery.** Every failure shows what happened plus the most useful next action, for example "Claude session expired [Reconnect]", or "Port 3000 already in use [Stop conflicting process] [Use another port]".
- **Remove clutter, keep power.** Drop UI that no longer serves a purpose, even if "it was already there". Use progressive disclosure: common actions visible, advanced actions available when needed.
- **Code first.** Users should be able to do nearly all coding work without leaving Code: launch agents, pick the provider account, see account usage, pick the exact model and effort, run terminals, open Live Browser and Widgets, see Needs You and agent state, use KalVoice, review changes, run tests and switch accounts.
- **Never slower.** Every simplification preserves or improves responsiveness (see the responsiveness rule). Menus, panels, launchers and navigation open immediately; slow work happens asynchronously.
- **Keep account types distinct.** The KalCode account (the user's profile and login, with an editable display name) is separate from provider accounts (Claude A, Codex B). Renaming one never touches the other's identity or authentication.
- Fix friction with the smallest correct change that has the biggest UX impact (see Scope discipline). An audit is not a license for a giant redesign.

## Permanent account-usage rule (owner directive 2026-10-03)

**USAGE FOLLOWS THE EXACT ACCOUNT.** Each connected provider account has one authoritative state: provider, nickname, email/identity, provider plan, authentication state, health, current usage, rolling-window usage (for example 5-hour), weekly usage, reset/cooldown, model availability and default status. Code and its launcher, New Agent, Accounts & Usage, Account Hub, Agent Fleet, terminal headers, Runs, Queue, Squads, Handoffs and KalVoice all read that same state; never maintain a disconnected account or usage system. An agent launched on "Claude B" uses Claude B's authentication, provider session, usage, reset information and model availability.

- Read every usage signal the provider actually exposes before showing "Usage unavailable". Never invent or estimate usage; "Usage unavailable" is shown only when the provider genuinely exposes nothing for that account.
- Usage refresh is asynchronous and never blocks opening a menu, the launcher, the Agents panel or Accounts & Usage. Cached values are labelled stale until refreshed (see the provider session persistence rule).

## Permanent agent cleanup rule (owner directive 2026-10-03)

Failed, stopped, finished and stale coding agents must be easy to clear. Each such agent card has a close (X) action where the user already is, and KalTidy is the one coherent cleanup tool: stop idle terminals, clear failed agents, clear finished/stopped agents, review what would be cleaned, and close all terminals and agents in the current workspace. Only Close all asks, with ONE confirmation ("Close all terminals and agents? Active agents, builds, tests, and running processes will be stopped." / Close all / Cancel). Every close terminates the underlying processes through the canonical close path (no orphan provider processes), removes dead agent state, and keeps Agent Fleet, Needs You and Runs truthful. Agents remain real coding terminals, never Threads.

## Permanent Code tab and provider account state rule (owner directive 2026-10-03)

"KALCODE SHOULD NOT INTERRUPT NORMAL DEVELOPMENT WITH INTERNAL PERMISSION PROMPTS.

NORMAL SAFE CODING WORK SHOULD EXECUTE DIRECTLY.

THE CODE TAB IS KALCODE'S PRIMARY WORKING SURFACE AND RECEIVES FIRST-CLASS UX, PERFORMANCE, AND VISUAL POLISH.

EVERY PROVIDER ACCOUNT HAS ONE COHERENT IDENTITY INCLUDING ITS REAL AUTHENTICATION, HEALTH, PLAN, MODEL AVAILABILITY, AND USAGE STATE.

AGENTS LAUNCHED WITH A SPECIFIC ACCOUNT MUST USE AND DISPLAY THAT EXACT ACCOUNT'S REAL STATE.

USAGE MUST NEVER BE INVENTED OR DISCONNECTED FROM THE ACCOUNT IT BELONGS TO.

NOTHING USER-FACING SHIPS BLAND."

- **One account state, real data only, exact account.** See the account-usage rule: every surface reads one authoritative state per provider account (`useAccountUsage` / `ProviderAccountSessions`); usage is never invented; an agent launched on Claude B is Claude B everywhere.
- **Low usage.** Show low usage clearly but subtly ("Claude A · 8% remaining ● Low"). KalCode may suggest another account, but never silently rebinds an agent.
- **New Agent launcher.** Opens instantly from current account state and refreshes usage in place. The flow is account → exact model → effort → launch, skipping the account step when only one valid account exists.

## Permanent Agents tab and Live Browser rule (owner directive 2026-10-03)

"KALCODE AGENTS ARE REAL CODING TERMINALS, NOT THREADS.

THE AGENTS TAB IS A BEAUTIFUL LIVE CONTROL SURFACE OVER THOSE REAL CODING AGENTS.

IT MUST MAKE STATUS, TASK, PROVIDER, ACCOUNT, WORKSPACE, AND ATTENTION STATE OBVIOUS AT A GLANCE.

KALCODE PANES SHOULD BE EXPANDABLE, RESIZABLE, MOVABLE, AND RESTORABLE WHERE APPROPRIATE.

LIVE BROWSER IS A FIRST-CLASS CODE PANE AND SHOULD SUPPORT NORMAL SECURE WEBSITE/OAUTH AUTHENTICATION FLOWS.

NOTHING USER-FACING SHIPS BLAND.

KEEP EVERYTHING SIMPLE, BEAUTIFUL, FAST, AND UNMISTAKABLY KALCODE."

- **Groups and summary.** The Agents tab groups agents as All, Needs You, Working, Done, Idle and Failed, under a summary such as "27 agents · 1 working · 2 need you · 9 done · 15 idle".
- **Cards.** Compact cards show account, task, state, provider · workspace, exact model · effort, worktree and elapsed time. Where available, they add branch, files touched, current action, account usage and the Needs You reason.
- **Click.** Clicking an agent focuses its real Code terminal. Never route an agent to Threads.
- **Search, cleanup and layout.** Search and filter are instant. Cleanup is available per card (close failed or finished, open, retry/resume) and globally (Clear failed, Clear finished, Close idle, KalTidy, Close all). Groups and details expand and collapse, panels resize, and the layout persists across restarts. Never duplicate terminal UIs inside the Agents tab.
- **Live Browser.** It opens from the Code + menu, the terminal ⋯ menu, agent actions and the Browser control, preferring the far right. It supports URL, back/forward/reload, Local/Preview/Production, viewport presets, screenshots, console errors, open externally, Ask Agent, and resize/move/dock/focus/close/restore. It connects to agents (for example, detecting a dev server and offering to open it beside that agent).
- **Site sign-in.** Use legitimate browser/OAuth flows. Never capture or store Google credentials or bypass provider security. Persist site sessions securely. Where embedded sign-in is blocked, fall back to system-browser OAuth that returns to KalCode.
- **Design.** Use BridgeMind / T3 Code only as inspiration for density and status clarity. Never copy them.

## Permanent version rule (owner directive 2026-10-02; replaces the old release-and-marketing model)

**BUILD CONTINUOUSLY. SHIP CONTINUOUSLY. THE PUBLIC VERSION IS JUST AN OWNER-CONTROLLED LABEL. WHEN THE OWNER REQUESTS A VERSION CHANGE, UPDATE THE VERSION CONSISTENTLY AND CONTINUE WORKING.**

**1. Continuous development, independent of the version number.** Features, fixes, redesigns, improvements, builds, merges, deployments and shipping happen at any time under the current public version. A finished change that passes the normal harness (implement, test, review, integrate, build, deploy/publish, verify) ships through the normal KalCode update system right away: the Owner build updates, users receive the validated build, and the website and product surfaces update where relevant. Never wait for, or hold work for, a new version number. Never say "this ships with 0.1.9" unless the owner explicitly asked to hold that change.

**2. Internal builds.** Distinct builds share the public version and are told apart by an internal build/revision number, commit hash or equivalent (for example KalCode 0.1.8 build 184, 185, 186). Increment whatever internal build/update metadata the updater needs on Windows and macOS so a newer build ships while the public version stays the same.

**3. Owner dogfooding.** Where practical, the Owner account/build receives a fully validated production candidate first: validated build, then Owner receives it, then production verification, then users receive it. This never bypasses a required safety gate, and normal users are never the first people exposed to an unverified build.

**4. Owner-controlled version switch.** The public version changes ONLY when the owner explicitly says so, for example "Change KalCode to 0.1.9", "Switch the version to 0.1.10" or "KalCode is now 0.1.11". Never infer or automatically increment it because many features shipped, time passed, a release happened, a major feature was completed or a build was published, and never bump it to satisfy a tool or hook.

**5. A version change is a simple number change.** Update the canonical public version and every reference that needs it so KalCode reports the new version consistently: canonical application version, package metadata, desktop app metadata, installer/package metadata, updater metadata, website version display, About/version UI, and release/build configuration that requires it. Use one canonical version source wherever technically appropriate. The next appropriate build carries the new version through the normal gates, and development continues normally.

A version change does **not** by itself mean: creating new features, stopping current development, repeating completed testing, reopening finished work, a marketing campaign, a launch video, a large changelog or What's New, an artificial release milestone, reclassifying features, or waiting for unfinished features. Do those only when separately requested or technically required.

**6. Versions serve the marketing cadence, not engineering.** A new public version needs no minimum number of features: 0.1.9 may carry one major feature, 0.1.10 three, 0.1.11 two. The owner changes the version whenever they want a new public marketing or update moment; never question whether a version has "enough" changes. If the owner separately asks for a launch/update video, changelog, release post or marketing assets, build them around the features shipped since the previous public version; never create them automatically just because the number changed. Cadence: BUILD → OWNER CHANGES VERSION WHEN DESIRED → OPTIONAL MARKETING/VIDEO → KEEP BUILDING.

**Current capability status (keep this line accurate).** Builds ship as `X.Y.Z+N`: the checked-in public version plus build number N (the commit count of the merged `main` release commit). The release tooling stamps it (Windows version resources `X.Y.Z.N`, macOS `CFBundleVersion` N), the updater orders builds numerically, and installed 0.1.7 clients accept newer builds and versions. The UI shows the public version, plus "build N" where versions are detailed. The current public version is 0.1.9 (owner-declared 2026-10-02), and there is no separate Owner update channel yet: Owner-first means installing the validated build on the Owner machines before publishing it to the feed. Never bump the public version to ship a build. When a lifecycle hook reports unshipped desktop changes, ship them as a new internal build of the current public version.

## Permanent automatic-update rule (owner directive 2026-10-01)

**EVERYTHING IS AUTOMATIC.** A new build of the current public version (for example 0.1.8+N → 0.1.8+M) reaches the owner and every user just by closing KalCode and opening it again, on both Windows and macOS. KalCode downloads and verifies the build in the background and installs it when KalCode closes. There is no prompt, notice or "Restart to update" click for same-version builds. The in-app update prompt is only for new public versions (0.1.8 → 0.1.9). Keep every signature, integrity, journal and rollback safeguard. Release verification must prove the close-and-reopen path on both platforms.

## Permanent zero-owner release rule (owner directive 2026-10-01)

Releases, including builds that carry an owner-requested version change, complete without the owner: "you should not need me for anything." Agents run the gates, builds, signing, publication, merges, deploys and approvals themselves. QA evidence comes from automation (end-to-end tests, UI automation, gate runners on both platforms, agent review) instead of owner sittings or clicks. Never bypass signing, notarization, signature, integrity, updater or security checks. If something is physically impossible without a human, such as an operating-system consent that can only be given at the machine, make it a one-time setup, report that exact action once, and never make it a per-release step.

## Permanent website rule (owner directive 2026-10-03)

"THE KALCODE WEBSITE SHOULD FEEL LIKE KALCODE ITSELF.

THE WEBSITE IS NOT JUST MARKETING. IT IS AN INTERACTIVE PRODUCT DEMO, ONBOARDING EXPERIENCE, TUTORIAL, AND CONVERSION FUNNEL.

VISITORS SHOULD BE ABLE TO EXPERIENCE THE KALCODE WORKFLOW BEFORE DOWNLOADING.

THE DEMO MAY BE TEMPORARY/NON-PERSISTENT, BUT IT SHOULD FEEL FULLY INTERACTIVE.

THE WEBSITE MUST TRACK THE REAL PRODUCT, STAY TRUTHFUL ABOUT AVAILABLE VS COMING-SOON FEATURES, AND NEVER MISREPRESENT WHAT USERS RECEIVE.

NOTHING SHIPS BLAND.

THE WEBSITE MUST BE BEAUTIFUL, DYNAMIC, FAST, SIMPLE, AND UNMISTAKABLY KALCODE."

- **The live demo** is the home page's centerpiece: `apps/website/src/lib/live/` (state, sample workspace, renderer, tour) and `src/scripts/live/` (browser runtime, loaded on demand). One renderer draws both the build-time first paint and every client update.
- **It mirrors the shipped app, from shared sources:** shell, labels and flows follow `apps/desktop` (Command Deck top bar, the Stable sidebar, tabbed Code panes, the New agent launcher, shared Agent Fleet task names and secondary account metadata); statuses come from `@kalcode/protocol/display-status`; availability, plans and limits from `@kalcode/protocol/plans`; icons are generated from the app's lucide version (`scripts/gen-live-icons.mjs`, drift-tested); colours and type from `@kalcode/ui` tokens. When the app's UI changes, update the demo in the same follow-up so a visitor who downloads KalCode sees what the website showed them.
- **Agents in the demo are coding terminals**, per the AGENT definition above, never threads.
- **The demo is not the Free plan.** It is a temporary sample in the browser; the Free plan is a real account tier from `plans.ts`. Never invent prices, limits or plan features for the website.
- **Truth:** a demo surface whose `PLAN_FEATURE_GROUPS` entry is `coming_soon` carries a Coming soon tag automatically; flipping the entry to `available` (after production verification) removes it. Sample data is fictional sample data, never real user information.
- **Fast:** the demo script loads only near the viewport or on a Try control, honours reduced motion, pauses off-screen, and needs no inline styles (strict CSP).

## Permanent KalCode pricing and entitlements (owner directive 2026-10-04)

This section REPLACES every older conflicting pricing/entitlement rule and is authoritative for BOTH Claude Code and Codex (`CLAUDE.md` imports this file).

**KALCODE PRICING MONETIZES THE VALUE KALCODE ADDS AROUND AI CODING, NOT ARTIFICIAL LOCAL TERMINAL OR CODING-AGENT LIMITS. ALL PLANS RECEIVE UNLIMITED LOCAL TERMINALS AND UNLIMITED LOCAL CODING AGENTS FROM KALCODE'S SIDE.** Never reintroduce these caps without explicit owner instruction, including through Code, Fleet, launchers, KalVoice, Squads, Queue, APIs or cached entitlements. Real hardware, OS, provider subscription/concurrency and upstream limits still apply. The Free queue limit bounds waiting tasks, never running local agents.

| Plan | Positioning | Monthly | Yearly | Annual savings | Workspaces | Provider accounts | KalVoice cloud/month | Brainstorms/month | Recipes | Integrations | Operations history |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Free | TRY -> Try KalCode. | $0 | $0 | $0 | 2 | 2 | 25 | 3 | 1 | 1 | Recent 10 Runs; 3 queued tasks; current Services/Environments; limited Activity |
| Pro | BUILD -> Your everyday AI engineering workspace. | $10 | $100 | $20 | 10 | 6 | 150 | Unlimited | 10 | 5 | 30 days |
| MAX | ORCHESTRATE -> Run serious multi-agent engineering workflows. | $25 | $250 | $50 | Unlimited | 12 | 500 | Unlimited | Unlimited | 25 | 1 year |
| MAX 2X | AUTOMATE -> Maximum KalCode. Maximum autonomy. | $50 | $500 | $100 | Unlimited | Unlimited | 1,000 | Unlimited | Unlimited | Unlimited | Maximum/longest |

**Every plan:** all supported coding providers (Claude Code, Codex, Cursor, Gemini and future providers), real native provider terminals/tools/parity, Code, Threads, basic Browser, Agent Fleet, Command Deck, account-aware launching, exact model identity, provider account persistence and usage visibility where supported, KalTidy including agent cleanup, Account Hub / Account + Usage Center, basic Unified Memory, basic Needs You, navigation, quick switcher, back/forward, smart resume, actionable errors, premium responsive UI, accessibility, automatic updates, security and reliability fixes. Never charge users to remove bad UX. Provider usage is governed by users' own provider accounts; local/on-device voice and dictation never consume cloud quota.

**Pro adds:** Full Operations; practical project/local and cross-provider memory; Live Browser Studio; Adaptive Canvas; advanced Code widgets and contextual actions (Fix This, Debug This, Ask Agent, Quick Send / Send to Agent); richer Continue Where I Left Off; advanced account/model controls; richer Mission Control.

**MAX adds:** Squads, Agent Handoff Chains, Agent File Ownership, Stuck Agent Detector, unified orchestration, advanced Fleet, full Mission Control, KalCode Deploy, advanced Browser Studio and cross-provider orchestration memory, custom integrations, advanced environment/Git/deployment workflows, standard Remote, advanced automatic routing suggestions and multi-agent workflows. Mark MAX **MOST POPULAR** and visually emphasize it.

**MAX 2X adds the strongest autonomy as it ships:** Keep Working and automatic next steps; task/provider/account/agent selection; context preparation; worktree lifecycle; test selection; retry/failure/interrupted-work recovery; agent handoffs; environment startup; review loops; Browser previews; release preparation and deployment automation; proactive Needs You; full Remote; highest relay, background automation, cloud-backed and memory/cloud-sync capacity; full OpenAI-supported external API/MCP integration capacity; appropriate early access to autonomy/orchestration/provider features. MAX means the user orchestrates KalCode; MAX 2X means KalCode can increasingly orchestrate itself. Example: dashboard request -> brainstorm -> plan -> implementation agent -> test agent -> fix/retest -> review -> preview -> prepare deployment -> involve the user for a genuine decision. This never bypasses provider authorization or privacy/security.

**One source of truth:** `packages/protocol/src/plans.ts` defines IDs, names, positioning, prices, numeric quotas, retention, Remote, memory, orchestration/autonomy and the availability roadmap. Website, account page, desktop, Account Hub, billing/API and signed entitlements derive from it; native mirrors have drift tests. Enforce paid access from verified server authority where required. Do not scatter hard-coded plans or prices. Do not change prices or feature plan assignments without explicit owner instruction.

**Website:** simple top cards (unlimited local agents/terminals, workspace/account/KalVoice allowances; MAX Squads + Handoffs + Deploy; MAX 2X maximum autonomy), polished monthly/yearly toggle, MAX Most Popular, full matrix behind Compare All Features. Prominent message: "Unlimited local coding agents + terminals on every plan. Bring your AI accounts. KalCode handles the workflow." Explain provider/hardware limits. Graphite, electric blue, premium typography, subtle depth, immediate response and excellent mobile layout.

**Billing:** preserve account-first selected-plan/interval checkout through sign-in and return automatically; Free activates without Stripe. Inspect actual live billing before changes; preserve existing subscriptions and active price IDs, never mix live/test or blindly delete products/prices. Verify monthly/yearly, upgrade/downgrade/cancel, webhooks, signed grants, Account Hub and owner revenue. Account Hub shows real interval, KalVoice remaining first/used/progress/reset, workspace/accounts/integrations, premium capabilities and manage plan. Never show obsolete terminal/agent caps.

**Roadmap truth:** `available` requires implemented -> tested -> merged -> shipped -> user-receivable -> production verified, with `verifiedIn` recording the build. Otherwise use `coming_soon`. Once an assigned feature ships, automatically update the catalog, website and relevant in-app descriptions and deploy/verify without owner reminders. Never label unfinished capabilities available.

**Scope and delivery:** audit all product/website/demo/billing/API/entitlement/KalVoice/integration/account/revenue surfaces; remove stale active pricing and numeric caps. Historical release evidence remains historical, never current policy. Test affected pricing, entitlements, checkout, quotas and unlimited agents/terminals; automatically merge, ship current public version, deploy, verify production and safe cleanup. No new public version or extra owner permission is required.

## Definition of Done

Writing code is not the end of a task. Unless the owner explicitly says "do not ship", "local only", "prototype only" or equivalent, every completed engineering task continues through its whole lifecycle:

```
IMPLEMENT → TEST → REVIEW → COMMIT → INTEGRATE/MERGE → BUILD → DEPLOY/PUBLISH → VERIFY PRODUCTION → REPORT COMPLETE
```

"Complete the task" already means commit, push, merge, ship, deploy and publish once the required automated gates pass. Never ask the owner to say those words.

## Scope discipline

**Smallest correct change. Fastest truthful path. Exact owner intent.**

- **Scope is the request.** Do exactly what the owner asked. Expand scope only when that is strictly required to make the change correct, safe or functional. If a 10-line fix is correct, make the 10-line fix.
- **No unrequested scope creep.** Don't redesign adjacent systems, refactor or rename unrelated code, replace dependencies, or add frameworks, services, abstractions, features or behavior changes that weren't asked for. Don't reopen finished work, redo valid QA, or widen a release. Note unrelated problems in the backlog in one line and keep going.
- **Minimum architecture.** Prefer existing code, then a small extension, then a targeted fix. Add a new abstraction only when the current design genuinely can't support the request. Never build for imagined future needs.
- **Choosing between solutions,** in this order: correct, safe, small, fast, maintainable, consistent with the existing KalCode architecture. Never pick the most elaborate option by default.
- **Owner direction wins.** Follow a specific implementation direction unless it's impossible, unsafe, destructive or incompatible with the product. If it can't work, verify that first, state the concrete blocker briefly, build the nearest correct solution and continue. Don't use a minor concern to justify a redesign.
- **Preserve what works.** Never throw away or rebuild working code, valid tests, release evidence, certifications, approved decisions or partial progress because another design seems cleaner. Build forward from the current state.
- **Proportional validation.** A local change gets targeted tests. A shared subsystem gets its affected integration tests. A release-critical change gets the relevant release gates. Reuse evidence that the change doesn't invalidate. Don't rerun everything for a small edit.
- **No process sprawl.** A simple task has one owner, one implementation, focused tests, and it's done. Use subagents, extra branches/worktrees or reviewers only when they genuinely save time on independent work. Don't re-plan in circles.
- **Honest estimates.** Report implementation time, targeted validation time and release time separately. Never present a whole release campaign as the cost of a code change.
- **Questions.** Don't ask what the repo, live state, docs or a safe command can answer, or anything a reasonable reversible decision covers. Ask only when the desired behavior is genuinely ambiguous (two materially different outcomes), when credentials/2FA are needed, or for irreversible, destructive, legal or business decisions.
- **Communication.** Keep updates short: what's changing, any real blocker, what passed, what's complete. If something is simple, say so.

**This applies to all KalCode work.** That includes new features, products, modules, panes, tools, workflows, provider integrations, AI systems, KalVoice, Browser, agent orchestration, release infrastructure, website, subscriptions, UI redesigns, backend services, APIs and automation. A new product is not permission to build a big architecture around it. For greenfield work:

1. Build exactly the requested product, as the smallest *complete* version that satisfies the request.
2. Reuse existing KalCode systems wherever they're enough. Add infrastructure only when the product genuinely needs it.
3. Add no speculative features or hypothetical-future design. Don't redesign adjacent areas just because the new product touches them.
4. Keep it modular enough to maintain, but don't over-abstract.
5. Get the real user path working end to end quickly, test that path, then integrate and ship through the normal pipeline.

"Smallest" never means incomplete, fragile, hacked together or low quality. It means no unnecessary architecture, features, abstractions or scope. Build the full thing that was asked for, and nothing that wasn't.

Before any significant design change, check: did the owner ask for this? Is it required for correctness or safety? Is there a smaller correct solution? If there is, use it.

## Pipeline by change type

Run `node tooling/release/ship.mjs classify --base <ref> --head <ref>` to get the lanes a change needs. The table below is the policy that command implements.

| Change | Lifecycle |
|---|---|
| Website only (`apps/website/**`) | test → merge → deploy the website → verify the live site |
| Desktop app (`apps/desktop/**`, `crates/**`, `packages/**` used by the desktop, `Cargo.*`, lockfiles) | test → merge → signed build with a new internal build number → automated release gates → Owner-first rollout → publish the build update → verify the update feed and a production install. Ships to current-version users as soon as the gates pass. The public version changes only when the owner requests it (see the version rule) |
| Website and desktop | both pipelines |
| Published docs (`docs/**` that the website or release notes publish) | publish the affected docs |
| Internal (`tooling/**`, `.github/**`, tests, agent/dev files) | test → review → merge. No customer release unless a production artifact changes |

## Gates

- The canonical branch (`main`) and production systems stay behind automated gates.
- Never bypass a failing test, signing, security, migration, updater or integrity check just to ship.
- When a gate fails: diagnose → fix → rerun the smallest invalidated set → continue on your own.
- Never stop just to report that a fix exists when you can safely finish the lifecycle yourself.
- Never push directly to `main`. Branch, open a PR, let CI pass, then merge. The merge is part of "done", not a separate request.

## When to ask the owner

Ask only for consequential decisions:

- destructive data operations
- irreversible migrations
- billing or pricing changes
- legal terms
- security-policy reductions
- credential or account decisions that need the owner
- knowingly shipping a serious regression

Some steps only a human can do: OAuth sign-in, 2FA, passwords, OS consent prompts, signing-credential renewal (`az login`), and real voice input. Ask for those as a single one-line action, for example "Google OAuth required — click Continue with Google". Everything else takes the fastest truthful automated route to production.

## Owner account rule

The owner operates only the `Kaleb` Windows account and the `kalebcampbell` Mac account. Never ask them to switch to QA or test accounts. Automate clean-profile testing instead (disposable data roots, CI, VMs).

**All agent work on the owner's Mac must run inside the `kalebcampbell` macOS account (owner directive 2026-10-03).** This includes SSH, builds, signing, packaging, installation, app automation, testing and update verification. Do not create, sign in to or use another macOS QA/test account, and do not ask the owner to do so. Use task-owned workspaces and isolated data directories within `kalebcampbell` when isolation is needed, preserving the owner's live work and session data. This is an OS-login rule, not merely an account signed into KalCode. Existing authorization to complete the task covers routine work in this account; an alternate Mac account is never a prerequisite.

## Reporting

"Complete" means production has been verified, not merely that the code compiles or a PR is open. The final report states what shipped, where it is live (version, URL, commit), what was verified, and any known issues that remain.

## Permanent storage hygiene and Cargo priority (owner directive 2026-10-01)

**KALCODE AGENTS CLEAN UP AFTER THEMSELVES. Storage hygiene is part of DONE.** This shared policy applies to both Claude Code and Codex; `CLAUDE.md` imports this file. Do not rely on conversation memory.

Before storage-intensive work (Rust compilation, desktop/release builds, Windows or macOS packaging, installer generation, large dependency installs, or multiple worktree builds), check available disk space. If space is dangerously low, reclaim proven disposable storage first, preserve active work, then continue. Do not wait for a disk-full build failure.

After significant implementation, building, testing, merging, packaging, release-candidate work, shipping, production verification, QA, or temporary-worktree use, perform conservative post-task storage review. Preserve required artifacts and evidence before cleaning. Inspect artifacts the task created or made obsolete, classify each large candidate as **SAFE TO DELETE / KEEP / UNSURE**, and automatically delete only **SAFE TO DELETE**. Never delete an item merely because it is large. Keep uncertain items. Prefer your own disposable artifacts first; ordinary safe cleanup must not be delegated back to the owner.

Safe candidates, only after proving they are unnecessary, include obsolete build directories and intermediates, superseded unsigned/test builds, duplicate installers/packages, temporary extractions, abandoned task caches and QA scratch directories, disposable logs/screenshots, stale Vite/Next/webpack caches, obsolete node_modules/dist/build outputs in retired copies, safe package/application/installer temp files, and obsolete crash dumps. Evidence-bearing logs/screenshots are not disposable.

Never delete, reset, overwrite, clean, prune, or disturb current source, uncommitted work, active branches/worktrees, current release branches, useful active Rust caches, current release packages, certified builds, signing material, credentials, provider authentication/session data, required QA evidence/receipts/screenshots, release records, production handoffs, deployment evidence, shipping/rollback artifacts, or anything unclear. Do not invalidate completed validation or redo valid work merely because cleanup occurred.

Before removing any worktree, prove all of the following: no active process uses it; no agent is working there; no uncommitted changes exist; no unique branch/work would be stranded; no release/QA evidence depends on it; and its useful changes are merged or preserved. Age, size, or an apparently finished task is not proof. If uncertain, **KEEP IT**.

### Rust / Cargo priority

Cargo/Rust artifacts are expected to be a major recurring storage consumer. After major Rust builds, packaging, release work, or worktree retirement, inspect target directories and Cargo caches, including old worktrees, retired branches, duplicate repo copies, obsolete builds, and abandoned QA/build directories. Aggressively remove obsolete incremental/debug/release artifacts only when proven unnecessary.

Cleanup priority:

1. **STALE TARGET TREES** from inactive, obsolete worktrees/repo copies.
2. **OBSOLETE INCREMENTAL ARTIFACTS**.
3. **DUPLICATE BUILD OUTPUTS**.
4. **OLD RELEASE/DEBUG OUTPUTS** no longer required.
5. **CARGO REGISTRY/GIT CACHE ONLY IF STILL NEEDED**; these are regenerable, but clearing them can slow future builds.

Preserve the **ACTIVE KalCode target/** when useful for current development and when removal would force a costly rebuild. Do **not** routinely run broad `cargo clean` against the active tree. Active-cache cleanup requires demonstrated storage pressure/reason, substantial benefit, preserved current work/evidence, and an acceptable rebuild cost. Involve the owner if recovery requires sacrificing useful active caches, meaningful work, credentials/keys/evidence, or current release/QA state. Prefer stale outputs first. The goal is minimum storage bloat without constant expensive rebuilds, not deleting every cache after each task.

### Release order, broader audits, and reporting

Shipping and verification come before release cleanup: **BUILD -> TEST -> SIGN -> PACKAGE -> VERIFY -> SHIP -> VERIFY USERS CAN RECEIVE IT -> PRESERVE REQUIRED RELEASE ARTIFACTS/EVIDENCE -> CLEAN OBSOLETE INTERMEDIATES**. Never remove anything still needed to finish or prove a release. Coordinate with an already active cleanup owner; do not run competing cleanup.

When storage is meaningfully constrained, broaden the audit to drive free space, largest directories, KalCode repo copies/worktrees, Rust targets, node_modules/package caches, temp/QA directories, and release artifacts. Reclaim the largest proven SAFE items first; never make speculative deletions. Keep the process simple.

Routine reports should state storage reclaimed, important active caches/releases/evidence preserved, and remaining free space. For major cleanup, also report free space before/after, largest removals, important large items intentionally kept, whether active Rust caches were preserved, and whether future builds will take longer.

For significant work, DONE means: **IMPLEMENT -> TEST -> REVIEW -> MERGE -> BUILD -> SHIP WHEN REQUIRED -> VERIFY -> PRESERVE REQUIRED ARTIFACTS/EVIDENCE -> CLEAN SAFE DISPOSABLE ARTIFACTS -> LEAVE ADEQUATE DISK SPACE FOR THE NEXT TASK**. Cleanup must never alter project truth.

## Permanent smart agent and terminal naming (owner directive 2026-10-04)

This policy is authoritative for BOTH Claude Code and Codex (`CLAUDE.md` imports this file), and replaces older visible agent call-sign rules.

**KALCODE DOES NOT USE A/B/C/AA/AB ALPHABET SEQUENCES AS VISIBLE CODING-AGENT NAMES. A NEW AGENT STARTS WITH ITS CLEAN PROVIDER NAME. ONCE IT RECEIVES A REAL TASK, KALCODE AUTOMATICALLY GIVES IT A SHORT HUMAN-READABLE TASK NAME. PROVIDER ACCOUNT, MODEL, AND EFFORT LIVE IN SECONDARY METADATA. MANUAL USER RENAMES ALWAYS OVERRIDE AUTOMATIC NAMING. THIS RULE APPLIES TO ALL CURRENT AND FUTURE PROVIDERS.**

- Naming priority is **user custom name > intelligent task-based name > clean registered provider name** (Claude Code, Codex, Cursor, Gemini, and future providers). Account labels may remain secondary metadata; never concatenate them into the main title.
- Use one shared provider-independent naming system. Task names are concise, normally 2-5 words, not pasted prompts: Pricing Redesign, Provider Tool Fix, Billing Webhooks, Live Browser. Authentication input, injected environment metadata and slash commands are not tasks.
- Name the first meaningful task. Keep the automatic title stable through replies/refinements; update it only when a genuinely different primary task makes the prior title misleading. Never replace a manual name, even if it equals the provider default.
- Persist title and manual/automatic ownership across workspace switches, restarts, updates and layout restore. Code, Agent Fleet, Runs, Needs You and KalTidy use the same durable agent identity/name; account, exact model and effort stay separately available.
- Test multiple providers, manual precedence, persistence and cross-surface consistency. Mirror the shipped behavior in the website demo. Submit validated work through the shared merge train, ship immediately and verify users can receive it; no direct main mutation or separate public-version wait.

## Permanent Codex sub-agent concurrency (owner directive 2026-10-04)

**CODEX MAY RUN A MAXIMUM OF 10 CONCURRENT SUB-AGENTS PER PARENT AGENT. 10 IS THE CANONICAL LIMIT. DO NOT REVERT TO THE OLD 3-AGENT LIMIT OR INCREASE IT ABOVE 10 WITHOUT EXPLICIT OWNER INSTRUCTION.** This supersedes every older conflicting sub-agent maximum, including 3 and 15. Do not silently configure a lower maximum.

When ten child agents are active, wait for one to finish/close and reuse the available slot before spawning another. Apply the same rule to orchestration, implementation, research, parallel review, testing, manager/worker structures, KalVoice-triggered Codex work and Codex sub-agents used by Squads or Handoffs. This is not a KalCode subscription entitlement: top-level local coding agents and terminals remain unlimited on every plan.

Use the supported Codex `agents.max_concurrent_threads_per_session = 10` setting (which excludes the primary thread; legacy alias `agents.max_threads`). KalCode's interactive and headless Codex launch paths share the canonical override in `crates/providers/src/codex/argv.rs`, including resumed sessions. Preserve provider-native sub-agent capabilities and unrelated user configuration. A running external tool host may expose fewer slots; report that actual host constraint truthfully rather than claiming the setting changes an already-running session. Do not persist the host's temporary constraint as a lower policy.
