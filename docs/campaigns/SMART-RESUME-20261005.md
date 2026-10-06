# Smart Resume implementation evidence

Starting integration: `9b115298f73d39814547e9bb1867dda2c7ad5c67`.
Task branch: `feat/smart-resume-continuity`.
Release label remains `0.1.9`; production delivery requires the shared merge train and a newer signed internal build on Windows and macOS.

## Requirement mapping

| Requirement | Implementation and proof |
| --- | --- |
| Restore real desk and focus | Existing native workspace/layout authorities; write-ahead layout recovery; controller persistence tests; isolated native restart spec |
| Keep drafts | Account/workspace/thread-scoped draft store; unsent/failed-send/remount/edit-during-send/storage-failure tests |
| Keep account availability | Existing provider-native credentials and cached asynchronous account validation retained; account restart coverage reused |
| One-click manual recovery | Settings preference, startup settlement and DeskRecovery; rendered preference/reload/Continue tests |
| Never revive closed or finished work | Canonical shutdown-vs-stop classification, saved-layout eligibility, stop-before-close; native and UI regression tests |
| No duplicate provider process | Transactional resume claim plus live-session mutex recheck; deterministic concurrent-resume and stop-vs-resume tests |
| Fresh New Agent and honest unsupported resume | Existing fresh-create path; context-only fresh fallback; different IDs with retained task name/directory and original history |
| Large-workspace responsiveness | Pane shell first; focused heavy body first; two bodies/frame; four bounded info reads; stale generations stop queued work |
| Browser failure and URL continuity | Existing Browser retry retained; independent failed-layout recovery; immediate serialized native URL checkpoint |
| Recent locations, pins, widgets | Validated bounded account-scoped navigation history; existing canonical pin/widget stores retained |
| Equivalent platforms | Shared React/Rust implementation; native Windows harness plus separate release-platform verification |

## Confirmed defects repaired during review

Review reproduced stale recovery banners after successful resume, false resumable labels on historical sessions, incorrect startup Back history, silent draft persistence failures, loss of Custom-session directory/task context, stale metadata queues continuing after supersession, and Browser URL changes waiting for the generic layout debounce. Each has regression coverage. The suspected account-bootstrap preference race was rejected: ConnectedAccountGate prevents the shell from mounting before authority/runtime readiness.

Independent reviewer found no remaining blocker in the final TypeScript/UI scope. Native and release verification remain separate facts.

## Local validation receipts

- Desktop and protocol TypeScript checks: pass.
- Repository `biome ci .`: pass; 11 existing website warnings and one existing informational lint diagnostic remain outside this change.
- Root recovery/pane/context focused run: 4 files, 38 tests passed before the added context-source test; context-source regression then failed as intended and passed after implementation.
- Root latest status/pane/hydration run: 7 files, 93 tests passed.
- Root layout controller checkpoint run: 18 tests passed.
- Root draft/navigation/startup run: 5 files, 37 tests passed.
- Independent continuity review: 13 files, 151 tests passed; worker neighbor coverage includes drafts 48, navigation 28, locator 68.
- Root native resume integration tests: 7 passed; independent stop-vs-resume race reproof: 1 passed.
- Native context-source tests: 3 passed; fresh identity test: 1 passed; restart classification test: 1 passed. Neighboring create, pause/resume and resource-admission tests passed.
- Rendered recovery suite: 5 passed, including Settings persistence, manual continuation, unsupported resume, failed-load retry, and actual Custom fresh-session launch. Accessibility check found no serious/critical violations on the recovery surface. Screenshots were visually inspected.
- Updated Close/Dock flows: 3 targeted rendered tests passed.
- `cargo fmt --all -- --check` and `git diff --check`: pass.

The counts above are receipts for distinct commands, not an aggregate unique-test count. Test fixtures use isolated fake providers; no paid provider call or owner credential mutation was required. Native restart, merge, signed packages, updater availability and production receipt are not claimed by these offline receipts.

## Compatibility and rollback

No database migration or credential-store change. Protocol additions have defaults for older payloads. Local records are versioned. Drafts contain user-entered plaintext in the local account-scoped WebView profile; they are not an encrypted credential vault. A crash before a native transaction commits can still lose that transaction; URL updates no longer wait for the layout debounce.

Rollback uses a normal revert on the current integration head, preserving subsequent work and existing native databases. Production is unchanged until publication. The original working checkout, owner processes and owner credentials were left untouched.
