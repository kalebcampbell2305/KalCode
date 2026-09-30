# KalCode agent policy

This file is the canonical engineering and release policy for every agent working in this repository: Claude Code, Codex, and any future agent. `CLAUDE.md` imports it. If another instruction file conflicts with this one, this one wins, unless the owner explicitly overrides it in the conversation.

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

**Current capability status (keep this line accurate).** As of 0.1.7, the updater compares public semver only, and published versions are immutable. Internal build-revision updates and Owner-first rollout are **not implemented yet**. Until they are, a desktop build reaches users only as a new public version. So desktop changes merge to `main` and wait, unless the owner declares a version or the build-revision update system has shipped. Building that system is tracked work. When a lifecycle hook reports unshipped desktop changes, it means "waiting for build-revision shipping or the owner's next version", not "bump the version".

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
| Desktop app (`apps/desktop/**`, `crates/**`, `packages/**` used by the desktop, `Cargo.*`, lockfiles) | test → merge → signed build with a new internal build number → automated release gates → Owner-first rollout → publish the build update → verify the update feed and a production install. The public version changes only at an owner-declared milestone (see the release and marketing model, including its current capability status) |
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
