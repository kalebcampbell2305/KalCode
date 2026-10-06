# Smart Resume and desk continuity

KalCode restores its existing workspace, layout and provider-session authorities. It never treats process IDs as durable sessions, replays terminal commands, resends drafts or creates a second credential cache.

## Returning to the desk

Settings → Continue where I left off controls automatic restoration per KalCode account. Automatic restoration opens the saved Code desk after workspace hydration. When disabled, Activity offers **Continue where I left off**. User navigation during startup wins.

Canonical workspace/layout stores preserve stable panes, tab order, geometry, terminal names, Browser locations and widgets. The existing focused-pane preference restores focus. Provider identities appear before runtime metadata. Heavy pane bodies hydrate progressively: focused content first, then two visible panes per animation frame. Hidden mounted panes retain identity. Provider-info reads are bounded to four concurrent requests; superseded queues stop claiming work.

Layout mutations write a bounded local recovery journal before the debounced native write. It excludes Browser URLs and clears only after its exact native write succeeds. Failed layout reads leave the saved authority untouched and expose **Retry restore**. Native Browser state owns URLs and its existing retry path.

Unsent Thread and New Thread drafts are scoped to the KalCode account, workspace and thread in the local application profile. Restore never sends. Successful send clears only the submitted text, preserving edits made during send. Draft storage is bounded; unavailable storage and oversize/corrupt records are surfaced. This is user-content persistence, not provider credential storage.

Recent navigation retains at most 200 validated entries per account, including stable target IDs. Raw Browser URLs and runtime handles are excluded. Existing pinned/favorite and workspace stores remain authoritative. Back navigation preserves real visits without inserting a transient startup visit during automatic Code restoration.

## Session truth and ownership

| Saved state | Restart behavior |
| --- | --- |
| Open coding pane interrupted by application exit, with native resume support and a stored provider session | Eligible for bounded automatic resume; native facts are rechecked before launch |
| Intentionally stopped or closed coding session | Remains ended; never automatically resumed |
| Completed/failed session or ended local command | Preserved as history; commands are never replayed |
| Provider cannot resume the conversation | Historical state with **Start fresh session**, preserving task name and working directory; original thread stays in history |
| Custom configuration cannot be copied directly | Existing launcher chooses fresh settings; native context-source lookup carries only task name and working directory |
| Missing/degraded Browser or service | Independent recovery UI; other panes stay usable |

`ThreadSummary.restartRecoverable` is an additive fact stamped by the native provider-pane owner from durable interactive identity and canonical app-shutdown/crash activity. It is independent of `resumable`. The shared thread runtime atomically claims the persisted resume state and rechecks it under the live-session mutex before launch. Concurrent recovery cannot overwrite a live session; Stop wins over stale queued resume.

Recovery orchestration permits two concurrent background launches and deduplicates attempts for the current runtime client. Failed automatic attempts require explicit retry. This schedules startup recovery; it does not cap user-requested agents or deny startup for high CPU. **New agent** always creates a fresh thread/provider session.

Closing a pane stops its owned live session through the canonical stop path before removing the pane. Cancel preserves it. Docking/hiding remains the explicit way to keep work running without displaying it.

Provider accounts retain provider-native authentication persistence and existing secure storage. Cached account UI appears immediately; safe passive validation runs asynchronously. A failed check is not sign-out. Continuity copies no provider credentials.

## Verification, compatibility and rollback

Focused coverage lives in recovery, layout, hydration, provider-pane, draft, navigation/startup and Rust thread-runtime tests. `tests/ui/smart-resume.spec.ts` covers rendered recovery, accessibility, fresh fallback and failed-layout retry. `tests/e2e/smart-resume.spec.ts` exercises isolated native restart with managed fake providers and a local Browser fixture; it does not use owner credentials or paid inference.

Shared UI/runtime behavior applies to Windows and macOS. The WebView2 restart harness is Windows-specific; macOS release/package proof is separate. Fake-provider tests are not live-provider certification.

There is no database migration. Protocol fields are additive, and automatic recovery stays disabled for a session when the recovery fact is absent. Local records are versioned. Rollback is a normal revert of the feature commit on the current integration head, preserving workspace/session databases and later work. Old builds ignore the new local records and optional recovery fact.
