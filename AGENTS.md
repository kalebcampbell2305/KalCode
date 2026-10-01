# KalCode agent policy

This file is the canonical engineering and release policy for every agent working in this repository: Claude Code, Codex, and any future agent. `CLAUDE.md` imports it. If another instruction file conflicts with this one, this one wins, unless the owner explicitly overrides it in the conversation.

## Completion requires verified delivery (owner reaffirmed 2026-09-30)

**MERGED IS NOT SHIPPED. BUILT IS NOT SHIPPED. DONE means users can receive the validated update and live production has been verified.**

After implementation, tests, review, and merge, immediately continue through the current-public-version build, required signing and packaging, publication, update availability, and live production verification. For public 0.1.7, publish a newer internal 0.1.7+N build; never wait for 0.1.8 or describe assignment to a future build as completion.

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

## Permanent release and marketing model

**Features ship continuously. Builds increment internally. Public versions are deliberate, owner-declared milestones.**

There are two separate concepts: continuous product builds, and public version (marketing) milestones.

**1. Continuous product builds.** A finished KalCode change that passes the normal harness (implement, test, review, integrate, build, deploy/publish, verify) ships automatically through the normal KalCode update system:
- the Owner build updates;
- users receive the validated production build;
- the website and product surfaces update where relevant;
- finished, useful work does not wait for the next marketing version.

Each production build is identified by an internal build/revision number (for example public 0.1.7 with builds 217, 218, 219, or equivalent metadata). The public version does not change per build. The updater must compare that internal build/revision metadata correctly, so a newer build ships while the public version stays the same.

**2. Owner dogfooding.** Where practical, the Owner account/build receives a fully validated production candidate first, before broad rollout. The order is: validated build, then Owner receives it, then production verification, then users receive it. This never bypasses a required safety gate, and normal users are never the first people exposed to an unverified build.

**3. Public version milestones.** The public, user-facing version changes **only** when the owner explicitly declares a new milestone, for example "Make this KalCode 0.1.8", "Release 0.1.8" or "Cut 0.1.8". Until then KalCode keeps shipping validated builds while publicly staying on the current version. Never infer a public version bump, and never bump to satisfy a tool or hook.

**4. A version release is a marketing event.** When the owner declares a new version:
1. update the public version consistently;
2. gather everything meaningful added since the previous public version;
3. write the What's New summary;
4. update the changelog and release notes;
5. update the relevant website references;
6. prepare announcement copy, and screenshots where useful;
7. prepare the "What's new in KalCode <version&gt;" video;
8. prepare social-media launch content;
9. ship and verify the milestone through the normal release pipeline.

The version number is the story around a meaningful group of improvements, not a counter for every code change.

### Permanent continuous-shipping rule (owner directive)

**A completed KalCode feature never waits for the next public version number.**

If KalCode is publicly 0.1.7, every new feature, fix, UI change and KalCode or KalVoice change goes through build, test, merge, production artifact and ship, and **updates the current 0.1.7 users** as soon as the normal automated gates pass. For example: 0.1.7, then feature A ships, then feature B, then feature C. Users receive all of them, and it is still publicly called 0.1.7.

- The public version number is **not** a feature gate. Never hold finished work for a future public version.
- Never say "this change waits on main for the next version" or "this ships with 0.1.8" unless the owner explicitly told you to hold that change.
- Increment whatever internal build/revision/update metadata is technically required so the updater recognizes the newer build, on Windows and macOS.
- When the owner says "Make KalCode 0.1.8", no product feature changes or unlocks. Everything already shipped stays exactly as it is. Only the public milestone moves, with its What's New, changelog, release notes, website/version references, marketing video and social posts.

**Features ship immediately after validation. Users get them in the current version. Public version numbers are owner-declared marketing milestones only.**

**Current capability status (keep this line accurate).** Builds ship as `X.Y.Z+N`: the checked-in public version plus build number N (the commit count of the merged `main` release commit). The release tooling stamps it (Windows version resources `X.Y.Z.N`, macOS `CFBundleVersion` N), the updater orders builds numerically, and installed 0.1.7 clients already accept `0.1.7+N`. The UI shows the public version, plus "build N" where versions are detailed. The first `0.1.7+N` production build is not yet published, and there is no separate Owner update channel yet: Owner-first means installing the validated build on the Owner machines before publishing it to the feed. Never bump the public version to ship a build. When a lifecycle hook reports unshipped desktop changes, ship them as a new internal build of the current public version.

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
| Desktop app (`apps/desktop/**`, `crates/**`, `packages/**` used by the desktop, `Cargo.*`, lockfiles) | test → merge → signed build with a new internal build number → automated release gates → Owner-first rollout → publish the build update → verify the update feed and a production install. Ships to current-version users as soon as the gates pass. The public version changes only at an owner-declared milestone (see the continuous-shipping rule) |
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
