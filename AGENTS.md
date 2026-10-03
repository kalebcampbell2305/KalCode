# KalCode agent policy

## Permanent fastest truthful release policy (owner directive 2026-10-02)

**KALCODE OPTIMIZES FOR THE FASTEST TRUTHFUL PATH FROM CODE TO USERS.**
This directive applies to Claude Code, Codex, and future agents. It replaces older release-gate instructions wherever they impose unnecessary delay, repeated validation, arbitrary waiting, broad checklists, or release ceremony. It takes precedence over conflicting historical instructions below and in release kits, campaign documents, and automation. Keep older evidence; remove irrelevant gates from the critical path.

Default lifecycle: **IMPLEMENT -> TEST WHAT CHANGED -> REVIEW -> MERGE -> BUILD -> SHIP -> VERIFY -> CLEAN UP.** Use the fastest technically safe merge, build, shipment, and production verification.

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

## Permanent definition: AGENT means a coding agent (owner directive 2026-10-02)

"IN KALCODE, AN AGENT IS A REAL CODING AGENT RUNNING IN A CODING TERMINAL/PANE.

AGENT IS NOT A THREAD.

'START SIX CLAUDE CODE AGENTS' MEANS LAUNCH SIX CLAUDE CODE CODING TERMINALS.

'START THREE CODEX AGENTS' MEANS LAUNCH THREE CODEX CODING TERMINALS.

THE AGENTS TAB / AGENT FLEET REPRESENTS THESE REAL CODING AGENTS AND OPENS THEIR ACTUAL CODE TERMINALS.

THREADS REMAIN A SEPARATE PRODUCT CONCEPT."

This applies to Claude Code, Codex and every future agent, in product code, UI copy, KalVoice and orchestration.

- **Agent** = a real provider coding session (Claude Code, Codex, Gemini CLI) running in its own terminal pane in Code, with a provider, account, exact model, effort, workspace, worktree/branch where relevant, live status and current task. N agents = N panes.
- **Thread** = the chat-oriented surface in Threads. Never implement, list, count or open an agent as a Thread, and never call a thread an agent.
- In code, an agent is a thread record whose `runtimeKind` is `interactive_pty` (native stamps it from the provider-pane marker on `thread_list`/`thread_get`; `isCodingAgent` in `apps/desktop/src/surfaces/dashboard/data/agents.ts`). Agent surfaces read `useCodingAgents()`; opening an agent goes through `uiIntents.focus({ kind: "thread", ... })`, which focuses its Code pane.
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

## Permanent parallel merge protocol (owner directive 2026-10-02)

**EVERY KALCODE TERMINAL MAY MERGE. THREE TO FIVE MERGES CAN LAND AT ONCE. NO SINGLE MERGER, NO LEAD APPROVAL. COORDINATE SO NOTHING BREAKS.** This applies to every Claude Code and Codex session.

**1. Merge your own work.** When your PR is validated (relevant tests pass, reviewed proportionately, `biome ci .` clean), merge it yourself. Don't wait for, or route through, another session.

**2. Pre-merge check (fast; takes seconds).**
- `git fetch origin`.
- `git merge-tree --write-tree origin/main HEAD` must be conflict-free. If not, rebase or merge main and re-test.
- If main moved since you tested, compare the files main changed (`git diff --name-only <tested-base> origin/main`) with your touched files and their direct dependents. Re-run the targeted tests only when they overlap.
- Merge exactly what you tested: `gh pr merge <n> --merge --match-head-commit <sha>`.

**3. Main stays green, and the breaker fixes it.** Before merging, run `biome ci .` (whole repo, about 1 s) and the tests for every file you touched, including tests that read source text. A format-only commit can break a regex test. If your merge breaks main, fixing it is your top priority. If you notice someone else's break, message that session at once (ListAgents → SendMessage).

**4. The shared runners are the bottleneck** (one Windows gate runner, one Mac gate runner). Run fewer gates and use them better:
- **Merge train.** With two or more PRs ready, whoever is ready first combines them on one branch (`train/<topic>`), runs ONE gate, and merges them all (see #107). Announce the train so the others don't gate separately.
- **Cancel waste.** Cancel gate runs for branches that are already merged or superseded.
- **Docs-only PRs skip the self-hosted gate** (Markdown, `docs/**` except `docs/releases/**`, `marketing/**`). The author still runs the lifecycle tests locally when `AGENTS.md` changes.
- **Release-critical packaging gets the machines first.** While a release is packaging on the Mac or Windows release machine, the macOS gate job may be skipped for changes whose macOS risk the release itself proves. Windows gate jobs queue.

**5. Announce shared hot spots.** Before merging changes to these areas, send a one-line SendMessage to the live sessions (ListAgents): KalVoice, threads/provider panes, release tooling, `AGENTS.md`, website deploy config, D1 migrations or the updater. Never force-push, rebase or merge another session's branch without asking that session.

**6. One release build and one website deploy at a time** (shared hardware and a shared Worker); merges never wait for either.
- **Release.** Claim it in `target/lanes/release.lock` (one line: session, commit C, build N, UTC start) and remove it after production verification. A release pins its commit C, so merges during a release don't restart it; they ride the next build. When a release publishes and main has unshipped desktop changes, the releasing session starts the next build immediately.
- **Website.** Claim `target/lanes/website-deploy.lock`, deploy from main, verify the build stamp, then release the lock. If another release's publish is about to deploy the website, sequence after it and ping each other.
- **Takeover.** If a lock's session no longer appears in ListAgents, any session may take the lock over and finish the work (the kit and state are in `target/recovery-*`).

**7. Log merges.** Append one line per merge to `target/lanes/merge-log.md`: UTC time, session, PR, merged sha, and the areas touched. Sessions read it to see what just landed.

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

## Permanent KalCode pricing and plan roadmap (owner directive 2026-10-01)

**KALCODE PRICING IS A CONTINUOUS PRODUCT SYSTEM.** Free = TRY ("Try KalCode."). Pro = BUILD ("For developers using AI every day."). MAX = ORCHESTRATE ("Serious multi-agent development.", marked MOST POPULAR). MAX 2X = AUTOMATE ("Maximum KalCode. Maximum autonomy.").

| Plan | Monthly | Yearly (saves) | KalVoice Requests/month | Open terminals | Parallel agents | Workspaces | Provider accounts |
|---|---|---|---|---|---|---|---|
| Free | $0 | $0 | 25 | 4 | 1 | 2 | 2 |
| Pro | $10 | $100 ($20) | 150 | 12 | 4 | 10 | 6 |
| MAX | $25 | $250 ($50) | 500 | 18 | 10 | Unlimited | 8 |
| MAX 2X | $50 | $500 ($100) | 1,000 | Unlimited | Unlimited | Unlimited | Unlimited |

- **One source of truth.** `packages/protocol/src/plans.ts` holds every price, limit, positioning line and the plan roadmap (`PLAN_FEATURE_GROUPS`). The website, account page, desktop onboarding and settings, Account Hub, the server-signed entitlement and KalVoice metering derive from it. Native Rust mirrors carry a drift test against it. Never hardcode a price, limit, plan name or feature's plan anywhere else. Paid entitlements are enforced server-side or from the verified signed tier, never from client-only values.
- "Unlimited" means KalCode imposes no limit of its own; hardware, OS, provider, account, API and upstream limits may still apply (`UNLIMITED_NOTE`). A KalVoice Request is one executed KalVoice command; on-device dictation and voice into terminals are never counted. Reaching a limit never closes anything; KalCode only refuses opening one more.
- Basic product quality (Account Hub, usage visibility, exact identity, navigation, command palette, terminal rename/status/smart close, Needs You, KalTidy, Favorites, core Code/Threads/Browser, security fixes, accessibility, updates) is on every plan. Monetize scale, orchestration, autonomy and cloud capacity. Max 2X gets the strongest autonomy and the highest cloud-backed capacity.
- **Never change prices, limits or a feature's plan without explicit owner instruction.** Existing subscribers and live Stripe prices are inspected before any billing change and never deleted blindly.
- **Roadmap truth.** Every plan feature is `available` or `coming_soon`. A feature becomes `available` only after it is implemented, tested, merged, built, shipped, user-receivable and production-verified; `verifiedIn` records that build. Never mark unfinished work Available.

**Automatic website sync (part of every feature's Definition of Done).** When implementing a feature: (1) find its entry in `PLAN_FEATURE_GROUPS`; (2) keep its plan assignment; (3) ship it through the normal lifecycle; (4) once production is verified, flip it to `available` with `verifiedIn: "<version>+<build>"` in the same release follow-up, deploy the website, and verify the live pricing page, without being reminded; (5) update account/billing/in-app plan descriptions when relevant. If a new feature has no plan entry, do not invent a pricing decision: ask the owner which plan(s) get it before changing public entitlements.

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
