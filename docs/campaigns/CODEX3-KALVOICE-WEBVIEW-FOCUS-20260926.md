# KalVoice main-webview focus boundary

Branch `codex3/kalvoice-webview-focus`, base `32b94ba`. Scope: frontend focus tracking,
headless regression and a precise native Mac QA boundary. No provider routing/fallback,
permission or captured-session identity changes.

Trace findings:

- `browser_commands.rs::bind_native_focus` registers WebView2 GotFocus on Windows; its
  non-Windows implementation returns success without registering a native focus observer.
- `BrowserPane` consumes that native event by requesting canvas focus. `CodeCanvas` calls
  `focusPane(paneId, false)`; this alone neither focuses a DOM element nor clears a KalVoice target.
- `KalVoiceProvider` previously tracked only document `focusin` and `focusout`. A delayed
  focusout callback resolved `document.activeElement` without checking `document.hasFocus()`.
- A native keyboard listening signal calls `DictationSessions.open`, which snapshots the last
  focus-tracked target. Provider sinks remain registered while their panes live. Liveness and
  provider-readiness checks do not invalidate a target merely because focus moved elsewhere;
  that is intentional for a recording already in progress.
- Native `follow_focus` watches the top-level Tauri window, not the individual WKWebView's first
  responder. It cannot establish whether a child-webview transition clears the frontend target.

The new test reproduces stale targeting in the real frontend when the main-webview blur event
is delivered while its active element remains the old field. It also sends a later focusout,
covering the microtask that could otherwise revive that field. The low-confidence word
`dashboard` was inserted into the old field before the fix; with no dictation target it instead
uses the existing local command route. The test changes neither routing logic nor provider fallback.

The repair listens for window blur/focus, clears only the next capture's focus target on blur,
and re-resolves it on focus. All tracking checks document focus before resolving activeElement.
An already frozen pending capture or opened dictation session retains its exact original target.
Both new event listeners are removed on cleanup.

Evidence limitations: headless Chromium reports each automated page as focused, so an attempt
to generate genuine window loss by opening a second page did not reproduce platform behavior.
The committed tests explicitly model the blur/focus signal and hasFocus boundary, and run the
real React provider, dictation sessions, routing and insertion against the in-memory transport.
They are deterministic frontend protocol proofs, **not physical WKWebView focus proofs**.

Verification: the new blur-before-capture case failed before the production change; all three
new cases pass after it. Nine focused browser tests pass, including existing immutable target,
orb pointer-down capture, closed target, raw-terminal non-execution, unverified provider and
provider-native permission guards. Another 31 KalVoice/pane browser tests pass, including both
axe themes, missed-release behavior and no-provider-fallback policy. TypeScript, scoped Biome
and diff checks pass. The full desktop unit suite passes 102 files / 881 tests with the
existing jsdom canvas diagnostic; command exit is 0.

Required native Mac gate, using the final built application:

1. Record artifact version/hash and macOS version. Open a local raw terminal and a native Browser
   child side by side. Use a local test page with a harmless text field; no provider credentials
   or external service calls are needed for the focus check.
2. Focus the terminal, then click directly inside the native browser content (not its toolbar or
   DOM placeholder). Record only focus event names, document.hasFocus, active-element type/pane
   and the captured target pane ID; do not log transcripts or page/credential contents.
3. Start a new push-to-talk capture in the native browser. Confirm the old terminal is not the
   highlighted capture target and receives no dictated text. A low-confidence local surface
   name can confirm the no-target command path without executing a shell command.
4. Repeat through keyboard focus traversal, browser content/iframe focus, app deactivate/reactivate
   and returning to the terminal. Confirm newly focused targets restore correctly.
5. Separately begin capture in the terminal before switching to the native browser. Verify the
   already captured terminal destination remains immutable, and dictated raw text never presses
   Enter. Repeat the widget pointer-down path.

If native WKWebView changes focus without an observable main-webview blur/focus or suitable
document focus event, this frontend repair cannot establish native focus safety. Capture that
event sequence before designing a native hook. Mac canvas selection/highlighting is also a
separate unresolved native behavior because the native focus hook is currently a no-op.
