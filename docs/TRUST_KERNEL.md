# KalCode Trust Kernel
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **TK** · Phase **P1 (TK-1, right after Z4 merges)**

The single top authority: **USER → Trust Kernel → Permission Policy → Provider/Agent/Tool →
Action.** It is the formalisation and extension of the Z4 permission engine (`crates/permissions`),
not a second authority system. There is one evaluator, one audit trail and one approval queue.

## Reconciliation with Z4

Z4 already behaves as a kernel: its evaluation is deterministic and fails closed, opaque actions
are never auto-allowed, remote-consequential scopes are never allowed by a mode, the Plan boundary
holds, and Bypass is refused to agents, KalVoice and automations and audited. The Trust Kernel
names these properties as invariants, puts them *above* modes (including Bypass), and extends
evaluation to every origin: user UI actions, KalVoice, agents, delegations, automations, Doctor
fixes, Continuity restarts, remote hosts, utilities, and later plugins. Evaluation is
`invariants(pre) ∘ ceiling ∘ policy ∘ invariants(post)`. `PermissionGate` stays as the thread
runtime's seam, implemented by the kernel.

## Invariants (hold in every mode, including Bypass)

| # | Invariant |
| --- | --- |
| K1 | Fail closed: anything unclassifiable is opaque; a kernel error denies. |
| K2 | Opaque actions are never allowed without an explicit approval. |
| K3 | Remote-consequential scopes are never allowed by a mode — only by an approval or an allow rule with a matcher. |
| K4 | Repository content is never a policy source: no repository-provided rules, profiles, hooks, provider project settings, blueprints or automations take effect without review. |
| K5 | Only the user, through KalCode's UI, changes policy (modes, rules, profiles, grants, kill switch off, host-key trust). Agents cannot change their own policy. |
| K6 | Bypass is user-only, confirmed, persistently indicated, and never lifts K1–K4, K7 or K8. |
| K7 | Ceilings only restrict; a delegation never exceeds the delegator's authority. |
| K8 | Approvals are decided only by the user; grants never transfer across threads, delegations or handoffs; stale approvals never revive. |
| K9 | Significant decisions are audited (append-only `permission_audit`; non-read evaluations in `permission_action_log`). |
| K10 | A small set of actions needs a native (Rust-side) confirmation that a compromised WebView cannot forge. |

## Scope

Filesystem, shell, network, git, providers, plugins (with Z11), credentials, browser, remote
hosts, automations and external actions. New scopes: `process.control`, `remote.connect`,
`context.share`, `memory.write`, `automation.manage`, `agent.delegate`.

## Events

`trust.action_blocked` and `trust.ceiling_applied`. Evaluations are not events; they are logged
in the action log to avoid flooding. Approvals keep their existing `approval.*` events.
