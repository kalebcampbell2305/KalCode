# KalCode takeover — 2026-09-25

## Authority and release hold

Starting integration commit: `3ca2eb507c7f80010ce651b264021674916d9a30` on `main`.
Security integration worktree: `.worktrees/sec-harden`, branch `sec/providers-harden`.
Rollback checkpoint: `takeover-20260925-before-hardening`.

The owner explicitly requires security hardening before new features, installation,
publication, or deployment. No private private personal assistant project is in scope. Provider inference,
account changes, production stores and credentials are not needed for certification.

## Recovered Git state

- Main was clean. No stashes were present.
- All 31 linked worktrees were inspected with `git status --short` and ancestry counts.
- All branch tips except `p2/utility-dock` were already ancestors of main.
- `p2/utility-dock` contains one unique commit, `a957a3e`, with native utilities,
  IPC and KalVoice integration. It is preserved, pending completeness/security review.
- `.worktrees/env-doctor` at `943b001` contains modified contracts, permission
  classification/service/tests and untracked `crates/doctor`. Preserve these edits.
- `sec/providers-harden` is clean at the starting integration commit. Its reflog
  records branch creation only; no partial hardening implementation was recovered there.

## Takeover map

| Classification | Recovered area | Evidence / next gate |
| --- | --- | --- |
| COMPLETE at campaign scope, historical verification | Foundation, terminal/workspace runtime, thread runtime, permissions, dashboard, pane canvas, rail/home, provider panes | Z0–Z7 campaign records and merged ancestry; fresh integration baseline running |
| PARTIAL | KalVoice, Git core, Context/Firewall, Resource Governor, provider health | Implementations exist; distinguish library completion from remaining integration and release gates |
| NEEDS INTEGRATION / REVIEW | Utility Dock | `a957a3e`; must retain newer provider changes when merging |
| PARTIAL / NEEDS REVIEW | Environment Doctor | Uncommitted work in its existing worktree |
| BLOCKED for release | Current provider integration | Owner's six security findings below |
| NOT STARTED or partial contracts, pending detailed census | Remaining advanced roadmap and gated Agents/Missions/Automations/Skills/Plugins/Memory/Command Center | Compare current code with ADVANCED plan; do not infer completion from contracts or documents |

The local 0.1.5 installer build record identifies `363d5a0` and includes
`kalvoice-whisper`; documentation claiming the installer omits speech is stale.
The checked-in website release manifest identifies 0.1.1. Neither artifact proves
current main safe to install or publish.

## Security repair order and ownership

The owner's updated concurrency limit is one lead plus at most two active subagents.
The active isolated scopes are locator privacy and hook hardening; the lead owns
provider launch policy, integration, testing and commits. Earlier audit agents are stopped.

1. Reproduce and repair locator privacy: immediate opt-out purge, workspace deletion,
   stale indexing races and restart persistence. Ownership: `crates/locator`.
2. Reproduce provider launch weaknesses: Gemini Plan self-escalation, repository config,
   connected Codex tools, and interactive/headless policy parity. Ownership to be assigned
   after supported CLI controls are verified; no guessed flags.
3. Authenticate and bound hook records, including provider/session binding, replay,
   payload validation and resource limits. Review the existing HMAC protocol first.
4. Run focused regressions, complete checks, isolated real-app tests, then independent
   adversarial review. Repair confirmed findings and repeat affected gates.
5. Only the lead stages explicit reviewed paths, commits, integrates and assesses release.
   Resume the preserved Utility Dock/Doctor work and remaining roadmap after security gates.

## Verification ledger

Fresh baseline `pnpm check` on unchanged main exited 0: format, lint, typecheck,
JS/Rust tests, branding, capability grants, zero-cost and release manifest checks passed.
JS tests: protocol 56, testing 24, UI primitives 26, API 119, desktop 332, website 239;
tooling 18. Existing explicit provider-quota and release-performance ignores remain.

Security regression `terminal_control_sequences_cannot_forge_canonical_provider_status`
failed on the inherited code with a forged `WaitingForUser` event, then passed after
removing OSC 9's authority to change canonical thread status. This is focused proof,
not completed hardening certification.

An isolated, synthetic Codex 0.155.1 configuration probe showed that
`-c mcp_servers={}` does NOT clear an existing server map: the synthetic server
remained enabled in `codex mcp list --json`. Do not use an empty map as a deny control.
The probe used a temporary CODEX_HOME containing only test configuration, no credentials,
and started no provider inference or MCP server.

No installation, publication or deployment has occurred during takeover.

### Independent review and provider isolation decision

Locator initially passed 55 tests, including atomic opt-out and stale-worker tests.
Independent review identified an additional visibility window: a search after workspace
deletion could return old rows before the queued cleanup ran. Repair now also covers
authoritative workspace validation in search/open, with a blocked-worker regression.
Canonical thread history remains untouched, as required by migration 0003.

Hook repair initially passed 40 hook-bridge tests and 17 session tests. Independent review
found a session-exit/approval-insertion race, an unbound registration API, and acceptance
of semantically empty Codex notifications. These are undergoing regression-first repair.
Session-key authentication cannot distinguish the legitimate helper from a child inheriting
that same key; channel, identity, resource bounds and policy routing remain essential.

The installed Codex 0.155.1 native terminal has no supported user-config isolation flag.
Headless `--ignore-user-config` exists, but does not suppress every managed/system source.
Empty MCP maps, profiles over inherited configuration, and enumerate/disable approaches
do not establish the required authority boundary.

The owner selected **KalCode-managed provider profiles with separate supported sign-in**.
Preserve the existing standalone CLI setup; do not copy/link/read authentication files.
This is a security prerequisite, not permission to relax the Trust Kernel.

A temporary Gemini system-settings overlay was rejected after testing the actual published
0.61.0 package. Its loader skips user-owned system files as insecure, and its local `admin`
settings are replaced by remote-admin defaults. A synthetic hostile workspace retained its
mutating tool list in the real loader despite the proposed floor. The experiment was removed
from the source tree; its source and failing offline probe remain in ignored `target` evidence.
Do not revive this approach based on the passing Rust argument/configuration tests alone.

Provider, hook, and locator release certification remains incomplete. No provider inference
or real account sign-in has been performed during these synthetic tests.


### Subsequent hardening evidence

The final independent hook review found no reproducible remaining approval, channel or
lifecycle bypass. It reran 41 bridge tests, 21 session tests, and four lifecycle races
20 times each (80/80). Same-session child key inheritance remains an explicit limit.
The production event sink is nonblocking; its queue has no lifetime byte cap.

The lead reran all 127 provider library tests successfully. The locator IPC opt-out/restart
proof is now a standalone `locator-privacy.spec.ts` (1 passed), allowing a coherent privacy
repair commit independent of provider profile work.

Published Gemini 0.61.0 loader probes show that managed workspace settings require
`GEMINI_CLI_TRUST_WORKSPACE=true` before launch; `--skip-trust` alone happens too late.
The candidate design uses a dedicated `GEMINI_CLI_HOME`, stable neutral per-thread CWD,
exact built-in tool registry floor and an actual repository included only for context.
A random MCP allowlist sentinel is required to prevent server startup; wildcard exclusion
alone is insufficient. Machine policy and runtime reload paths still require containment.
The profile architecture is approved, but implementation and release verification are pending.


### Owner architecture correction and queued app work

The latest owner direction supersedes the earlier Trust Kernel model for hosted CLI sessions:
KalCode/KalVoice control the workspace without approval; each real provider CLI owns execution
permissions and native prompts. Mode selectors must map supported native behavior. Remove
KalVoice's create/resume approval concept and production duplicate provider approval routing.
Direct KalCode shell/file/deploy/external-tool/browser automation must not become an unrestricted
bypass: route it through a provider or keep it unavailable pending an explicit security model.

KalVoice must support quantities, provider synonyms, mixed-provider batches, active/named
workspaces, independent real provider panes, automatic persistent layouts, and named pane
resize/reorder/maximize/collapse. Preserve existing work. Reuse the local deterministic router.
Current inspection found create commands start headless idle threads and navigate to Threads;
this must change to genuine interactive provider sessions and the Code canvas.

The owner also requires official provider marks alongside every visible provider-name label,
across app and website, including disconnected/missing states. Existing shared ProviderMark
and website ProviderGlyph intentionally use invented glyphs, so both need replacement using
verified provider-native assets and a shared identity treatment.

These requests steer the continuing build; they do not authorize installation/publication
before the security gates pass. The managed-profile choice remains approved.

Checkpoint verification after locator commit: rebuilt the E2E app and both helper binaries;
`providers2.spec.ts` plus `locator-privacy.spec.ts` passed 3/3 in 33.3 seconds. The tested
Codex scalar floor is an interim conservative implementation; native mode mappings are being
reconciled with the owner's newer architecture before release.

The locator precommit format scanner flagged one unchanged, pre-existing redaction test
fixture. PowerShell continued to the commit despite that scanner's nonzero exit. Subsequent
comparison proved the match byte-for-byte unchanged from the baseline and the committed
added-line scan had zero matches. Future scan and commit commands are separate gated steps.
