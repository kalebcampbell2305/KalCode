# Locator privacy repair — 2026-09-25

Starting commit: `3ca2eb507c7f80010ce651b264021674916d9a30`.
Repair branch: `sec/providers-harden`.
Recovery reference: `takeover-20260925-before-hardening`.

## Behavior

Message search remains opt-in. Enabling it reindexes existing workspace threads.
Disabling it updates the preference and removes indexed message bodies in one transaction,
before the command returns. Incremental and rebuild writes recheck the current preference
inside their write transaction, so an older worker snapshot cannot restore opted-out text.

Removing a workspace makes its indexed results and reopen targets unavailable immediately
to new requests, even while the indexing worker is busy. The worker subsequently removes
all derived workspace, thread, activity and terminal rows. Restart reconciliation also
rejects source-retained threads whose workspace is absent.

The authoritative Z3 thread/message history remains intact, as migration 0003 requires.
Removal from KalCode does not delete repository files. Index deletion is logical SQLite/FTS
deletion; it is not physical secure erasure of database pages. A search already in progress
may observe its earlier snapshot; a search begun after removal returns consults current
workspace authority. Session-only and persistent indexes have the same visibility gate.

## Evidence

- Regression tests were first observed failing for missing opt-in reindexing, delayed
  opt-out, stale-worker restoration, and retained workspace-derived rows.
- Independent review found a further queued-cleanup visibility gap. New deterministic
  tests hold the sole worker, delete the workspace, and search/open before releasing it.
  Both persistent and session-only tests failed before the visibility repair.
- `cargo test -p kalcode-locator`: 58 passed, 0 failed. The existing release-only performance
  test remains explicitly ignored in this debug command.
- Strict locator Clippy and scoped rustfmt/diff checks passed.
- Real desktop E2E (`locator-privacy.spec.ts`): 1 passed (15.2 seconds). The test uses actual IPC to enable
  message search, observes an existing message match, opts out, verifies immediate absence,
  restarts the application with the same temporary data, and verifies absence again.
- Workspace verification: format, strict Clippy, all TypeScript checks, 1,258 Rust tests
  and 810 JavaScript/tooling tests passed. Eleven existing Rust ignores and four existing
  website skips remain explicit. The initial branding gate rejected a private-project name
  in takeover notes; that reference was removed and all four final policy checks passed.
- All data was synthetic in temporary stores. No production store, provider inference,
  authentication file, repository file, or external account was changed.

No schema migration or contract change is needed. The index is a rebuildable projection;
canonical sources and migration history are unchanged. If rollback is needed, use a
reviewed revert on the current branch, preserving later work. Reverting this repair
reintroduces the privacy defects and is not a release-safe downgrade.

This repair does not certify the remaining provider hardening or authorize installation,
publication, or deployment. Those gates remain open in `CODEX-TAKEOVER.md`.
