# KalCode agent policy

This file is the canonical engineering and release policy for every agent working in this repository: Claude Code, Codex, and any future agent. `CLAUDE.md` imports it. If another instruction file conflicts with this one, this one wins, unless the owner explicitly overrides it in the conversation.

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

## Permanent version rule (owner directive 2026-10-02; replaces the old release-and-marketing model)

**BUILD CONTINUOUSLY. SHIP CONTINUOUSLY. THE PUBLIC VERSION IS JUST AN OWNER-CONTROLLED LABEL. WHEN THE OWNER REQUESTS A VERSION CHANGE, UPDATE THE VERSION CONSISTENTLY AND CONTINUE WORKING.**

**1. Continuous development, independent of the version number.** Features, fixes, redesigns, improvements, builds, merges, deployments and shipping happen at any time under the current public version. A finished change that passes the normal harness (implement, test, review, integrate, build, deploy/publish, verify) ships through the normal KalCode update system right away: the Owner build updates, users receive the validated build, and the website and product surfaces update where relevant. Never wait for, or hold work for, a new version number. Never say "this ships with 0.1.9" unless the owner explicitly asked to hold that change.

**2. Internal builds.** Distinct builds share the public version and are told apart by an internal build/revision number, commit hash or equivalent (for example KalCode 0.1.8 build 184, 185, 186). Increment whatever internal build/update metadata the updater needs on Windows and macOS so a newer build ships while the public version stays the same.

**3. Owner dogfooding.** Where practical, the Owner account/build receives a fully validated production candidate first: validated build, then Owner receives it, then production verification, then users receive it. This never bypasses a required safety gate, and normal users are never the first people exposed to an unverified build.

**4. Owner-controlled version switch.** The public version changes ONLY when the owner explicitly says so, for example "Change KalCode to 0.1.9", "Switch the version to 0.1.10" or "KalCode is now 0.1.11". Never infer or automatically increment it because many features shipped, time passed, a release happened, a major feature was completed or a build was published, and never bump it to satisfy a tool or hook.

**5. A version change is a simple number change.** Update the canonical public version and every reference that needs it so KalCode reports the new version consistently: canonical application version, package metadata, desktop app metadata, installer/package metadata, updater metadata, website version display, About/version UI, and release/build configuration that requires it. Use one canonical version source wherever technically appropriate. The next appropriate build carries the new version through the normal gates, and development continues normally.

A version change does **not** by itself mean: creating new features, stopping current development, repeating completed testing, reopening finished work, a marketing campaign, a launch video, a large changelog or What's New, an artificial release milestone, reclassifying features, or waiting for unfinished features. Do those only when separately requested or technically required.

**6. Versions serve the marketing cadence, not engineering.** A new public version needs no minimum number of features: 0.1.9 may carry one major feature, 0.1.10 three, 0.1.11 two. The owner changes the version whenever they want a new public marketing or update moment; never question whether a version has "enough" changes. If the owner separately asks for a launch/update video, changelog, release post or marketing assets, build them around the features shipped since the previous public version; never create them automatically just because the number changed. Cadence: BUILD → OWNER CHANGES VERSION WHEN DESIRED → OPTIONAL MARKETING/VIDEO → KEEP BUILDING.

**Current capability status (keep this line accurate).** Builds ship as `X.Y.Z+N`: the checked-in public version plus build number N (the commit count of the merged `main` release commit). The release tooling stamps it (Windows version resources `X.Y.Z.N`, macOS `CFBundleVersion` N), the updater orders builds numerically, and installed 0.1.7 clients accept newer builds and versions. The UI shows the public version, plus "build N" where versions are detailed. The current public version is 0.1.8 (owner-declared 2026-10-01), and there is no separate Owner update channel yet: Owner-first means installing the validated build on the Owner machines before publishing it to the feed. Never bump the public version to ship a build. When a lifecycle hook reports unshipped desktop changes, ship them as a new internal build of the current public version.

## Permanent automatic-update rule (owner directive 2026-10-01)

**EVERYTHING IS AUTOMATIC.** A new build of the current public version (for example 0.1.8+N → 0.1.8+M) reaches the owner and every user just by closing KalCode and opening it again, on both Windows and macOS. KalCode downloads and verifies the build in the background and installs it when KalCode closes. There is no prompt, notice or "Restart to update" click for same-version builds. The in-app update prompt is only for new public versions (0.1.8 → 0.1.9). Keep every signature, integrity, journal and rollback safeguard. Release verification must prove the close-and-reopen path on both platforms.

## Permanent zero-owner release rule (owner directive 2026-10-01)

Releases, including builds that carry an owner-requested version change, complete without the owner: "you should not need me for anything." Agents run the gates, builds, signing, publication, merges, deploys and approvals themselves. QA evidence comes from automation (end-to-end tests, UI automation, gate runners on both platforms, agent review) instead of owner sittings or clicks. Never bypass signing, notarization, signature, integrity, updater or security checks. If something is physically impossible without a human, such as an operating-system consent that can only be given at the machine, make it a one-time setup, report that exact action once, and never make it a per-release step.

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
