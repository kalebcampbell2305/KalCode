# Universal Context Drop and Context Firewall
Status: **planned — not built.** Nothing described here exists in KalCode yet. Plan and
acceptance criteria: `docs/campaigns/ADVANCED.md`; proposed types, events, IPC and tables:
`docs/CONTRACTS_ADVANCED.md` (PROPOSED, pending lead approval).

System code **CTX / FW** · Phase **P0 (library) · P2 (UI)**

Typed context packages that the user previews and edits before anything is sent to a provider,
and the firewall every KalCode-originated provider send passes through.

## Context packages

Items: file, file range, selection, terminal excerpt, diff, event range, memory record, thread
excerpt, text. Files are referenced by native-issued handles, never by paths from the WebView.
The preview shows every item, its size, its firewall verdict and redactions; any item can be
removed. The content hash at send time must match the preview. Translation adapts the package to
what the target provider accepts.

## Context Firewall

Runs before every KalCode-originated provider send: context drops, handoff capsules, memory,
automation prompts, delegation prompts and KalVoice reasoning. User-typed prompts get a
warn-and-confirm on secret patterns. It blocks or redacts secrets (the shared redactor plus
detectors), ignored paths (`.gitignore`, workspace "never share" globs, built-in sensitive names),
items outside the mission scope or the workspace, and binaries. *Secret* sensitivity can never be
overridden; *confidential* needs per-item confirmation. Every decision is logged.

## Honest limit

The firewall governs what KalCode sends. A provider reading files with its own tools is
governed by the Trust Kernel and the provider mapping; "never share" globs are also offered as
Trust Kernel deny rules for reads.
