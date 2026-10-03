# Agent terminal Hand Off

Hand Off passes a focused task between real coding-agent terminals in the same project. It is available on Pro and above through the existing `provider_handoff` entitlement. Threads and multi-step Handoff Chains remain separate features.

## Use

1. Open **Hand off** in the sending terminal's header.
2. Choose a receiving coding agent, or open **New agent** using the existing provider/account/model launcher.
3. Choose **Review**, **Test**, **Fix**, or **Continue** and optionally add instructions.
4. Inspect the generated brief. Edits require a refreshed preview before sending.
5. Send the handoff and open the receiving terminal from its activity entry.

The brief uses observable repository context. KalCode does not claim access to an interactive provider's original prompt, hidden reasoning, or previous test results. Add relevant evidence to the editable brief yourself. All outgoing text passes the existing Context Firewall.

Review and Test request read-only work; the receiving provider's existing permission mode remains authoritative. Fix and Continue require the source to be stopped or the agents to use separate clean worktrees. A handoff never answers provider approvals, signs into a provider, stops the source automatically, or broadens permissions.

## Delivery and results

Queued work waits for authenticated provider readiness and empty input. Delivery is bound to the exact receiving provider-process instance. A restarted agent does not silently inherit a pending handoff.

Claude Code uses its structured lifecycle hooks. A fresh Codex pane must finish its first turn before its authenticated completion signal can establish readiness. Gemini currently cannot provide the readiness evidence required for automatic delivery and is unavailable as a receiving target.

**Delivered** means the guarded terminal write succeeded. **Agent working** and **Needs you** reflect the same receiving process's current state, not proof of progress on this particular task; an idle terminal never means the task passed. The user records explicit findings and a Completed or Failed outcome. **Return findings** prepares a reverse handoff for inspection and explicit sending.

Cancel removes queued work. Once delivery happens, control of the active task remains in the receiving terminal.

## State and recovery

The canonical native database stores handoff identities, delivery claims, status, and user-recorded results. Migration 0022 extends that database. The outgoing brief remains in the existing process-local ContextPackage path; raw terminal history is not copied into the handoff store.

Restart or account-runtime shutdown interrupts unfinished handoffs. They are never automatically replayed. An uncertain write is marked interrupted because retrying might duplicate a task already accepted by the provider. Review the receiving terminal before preparing another handoff.

The native coordinator owns preview validation, entitlement checks, queueing, delivery, and persistence. The frontend uses `client.handoffs`; it never sends a handoff through a raw terminal write. Commands are `handoff_preview`, `handoff_send`, `handoff_list`, `handoff_cancel`, `handoff_complete`, and `handoff_return`.

## Verification and rollback

Focused coverage includes IPC envelopes, preview integrity, one-shot delivery, provider readiness, permission prompts, human typeahead, process replacement, concurrent delivery, explicit findings, return previews, and restart interruption. Browser coverage exercises the real dialog against the test-only memory transport; native delivery tests use deterministic provider adapters without paid inference.

For rollback after migration, disable the handoff entry and new delivery in a corrective commit and ship a newer internal build. Retain migration 0022, its registration, and existing records so the database stays compatible; a wholesale revert of the migration is not a safe downgrade. Do not run an older binary against a newer schema or remove user-recorded findings to downgrade it. Packaging and updater verification remain required on Windows and macOS.
