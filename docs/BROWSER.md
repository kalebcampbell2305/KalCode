# Browser surface

KalCode Browser is a real native child webview inside a Code Mode pane. React renders the trusted
toolbar and reserves the pane rectangle; Tauri creates an isolated WebView2 child for the remote
page. KalCode does not render remote sites in an iframe.

## Trust boundary

- Only the trusted `main` webview is named in the Tauri capability. Browser child labels are
  `browser-<page-lease>-<UUID>` and receive no KalCode IPC permissions. The native generation in
  the label prevents a delayed command from addressing a replacement child after a trusted reload.
- Native commands also reject every invoker whose webview label is not `main`.
- Navigation accepts credential-free `http://` and `https://` URLs only. `file:`, `data:`,
  `javascript:`, `blob:`, `about:`, custom schemes, embedded usernames/passwords, control
  characters, and oversized URLs fail closed in both TypeScript and Rust.
- Popups and downloads are denied. The system-browser button is a separate trusted toolbar action
  and validates its URL natively.
- The opener plugin's link-injection behavior is disabled, so remote documents do not receive an
  opener helper script.
- Browser cookies and site storage use a browser data directory per canonical workspace. The
  manager creates and verifies ordinary directories and rejects symlink/reparse-point ancestors.
- Runtime URLs can appear in the address bar, but workspace layout persistence removes query
  strings and fragments because OAuth codes and other secrets commonly appear there.
- Page titles and URLs are exposed only to the trusted toolbar. They are never logged.

## Lifecycle

The pane sends logical screen bounds to native on mount, through `ResizeObserver`, and after DOM
layout mutations that can move a pane without resizing it; native owns position, size, visibility,
and focus. A single shared `MutationObserver` hides all affected child
webviews while the document is hidden or a dialog, alert dialog, menu, or listbox is open. This is
required because a native child otherwise paints above React portals.

The native runtime rotates an opaque page lease when the trusted main webview starts loading. The
trusted page obtains that lease through a bootstrap command, and every renderer-originated Browser
command requires it. Native children are addressed with that generation in their labels, while
attach also rechecks after asynchronous native work. A delayed command from an older page lifecycle
therefore cannot navigate, focus, close, rebind, or reveal a current Browser child. Visibility updates also carry a monotonic version,
so a delayed show cannot overtake a newer trusted overlay hide. A child starts hidden at an off-screen
one-pixel bound, registers its native focus hook, and only then moves into the pane. Hide errors are
surfaced and trigger a fail-closed close attempt. Focus-hook
registration errors fail attach rather than silently creating a pane whose KalVoice destination
could be wrong.

Switching tabs or routes hides the child. Closing the Browser content closes its native child;
reopening creates a new child with the same browser identity and workspace profile. Application
main-view reload and application shutdown close the tracked browser registry. A record is removed
only after native close succeeds; a failed close remains tracked and retryable. An attach that races
with close observes the close marker and disposes its just-created child. The native manager bounds
retained browser views to eight.

On Windows, WebView2 `GotFocus` is registered through Tauri's platform handle. It emits only the
browser UUID to the trusted main webview and only while the child is marked visible. Code Mode then
updates its canonical focused pane, which is also KalVoice's destination.

## Supported controls

The toolbar supports address navigation, Back, Forward, Reload, Stop, system-browser open, URL
copy, and Fit/Desktop/Laptop/Tablet/Mobile/Custom viewport widths. Page title, current URL, loading
state, and responsive bounds come from native state. Multiple Browser panes can share one workspace
profile while retaining independent history and stable pane identities.

Tauri does not expose a portable child-webview screenshot or console API. KalCode therefore does
not claim screenshots, console inspection, or a rebuilt DevTools surface in this release.

## Verification

- `browserModel.test.ts` proves URL policy, secret-free persistence, stable browser identity, and
  responsive width bounds.
- `browserVisibility.test.ts` proves route, disconnected-host, and trusted-modal hiding.
- `browser_policy.rs` proves the native URL, UUID, and geometry boundary.
- Native unit tests prove exclusive browser reservations, retryable failed closes, attach/close
  race cleanup, stale-show rejection, title sanitization, and unsafe-profile rejection.
- `tests/e2e/browser.spec.ts` runs the compiled desktop app against a loopback fixture and proves
  remote IPC denial, navigation/history/reload/stop, modal hiding, position-only pane movement,
  two split Browser panes, native focus propagation, responsive sizing, popup/download denial,
  unsafe redirect rejection, main-view reload, restart restoration, query/fragment omission, and
  persistent cookie isolation between real workspaces.

The E2E fixture binds only to `127.0.0.1` and makes no provider or internet calls.
