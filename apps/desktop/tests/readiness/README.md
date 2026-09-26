# Owner-scoped runtime reproductions

This is a separate investigation suite, not a claim that the candidate passes every
release gate. The normal desktop suite remains unchanged. Run from repository root:

```text
pnpm --filter @kalcode/desktop exec vitest run --config tests/readiness/vitest.config.ts
```

The actual React components/providers run against deterministic mocked native calls
and an xterm writer whose completion can be delayed. No provider is launched.

- `workspace-race.test.tsx` failed before Lead 2's activation queue. It passes after
  `61bd14e` and `58d6ae6`. The scheduling probe allows the native mutations to complete
  out of order when callers dispatch concurrently; it also accepts serialization.
  This proves behavior under that controlled schedule, not that the synchronous
  Tauri command has been observed to reorder on a physical installation. Lead 2's
  separate `workspaceFocus.integration.test.tsx` also covers the real provider/caller
  composition under StrictMode; keep `9569e09` with the queue commits.
- Both cases in `terminal-replay.test.tsx` still fail: a delayed 64 KiB replay
  completion acknowledges attachment 17 after that attachment was detached. These
  direct writes bypass the already repaired OutputScheduler. The primary lead owns
  dirty TerminalView/PaneTerminal files; no competing production edits were made.

The terminal owner should check `disposed` and the attachment's captured `current`
generation before the direct replay callback changes `replaying` or acknowledges
bytes. Both components already retain those values. This must also fence callbacks
from a previous resync, not just unmount. It cannot cancel bytes already handed to
xterm. Re-run these probes after the owner's repair, alongside native attachment QA.

Initial terminal runs failed because the test environment lacked ResizeObserver;
after adding its no-op stub, both fail on the intended unexpected acknowledgement.
The failing assertions are retained, not skipped or inverted into passing tests.
