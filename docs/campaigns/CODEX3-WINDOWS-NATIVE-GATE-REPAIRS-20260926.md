# Windows native gate repairs

Branch: `codex3/locator-clippy-repair`; base: `b03f933`.

## Reproduction and scope

The frozen b03f933 full workspace run compiled and reached 1,549 passed / 7 existing ignored before failing both Gemini managed integration tests: their Windows fixture still supplied unguarded profiles to production code requiring native guardian authority. Four recovered fixture files now use the existing native guarded setup on Windows and macOS, preserving nonnative fallback and every assertion. No production authentication or guardian admission was weakened.

Strict Clippy then exposed recovered production/test lint issues: a shadowed locator date, manual Result propagation after Mac-only cleanup side effects, nested resource-sampler join error handling, and fallible integration fixture helpers calling expect outside test functions. Repairs preserve behavior, propagate helper failures to the test boundary, and use identical UUID constants without parsing. No lint is suppressed in this packet.

## Verification

- Managed provider suites: 48 passed (Gemini 2, interactive Claude 10, interactive CLI 15, pipeline 21); 2 existing tests intentionally ignore real provider installs/quota.
- Guardian unit tests: 23 passed; guardian contract integration: 6 passed; Windows guardian supervisor: 8 passed (including hard-kill custody and process-drain proofs).
- Fake provider version fixture: 2 passed; locator recency regression: 1 passed.
- Resource Governor full crate: 81 passed.
- Strict all-target Clippy passes for providers, locator, and resources, with keep-going and warnings denied. Workspace Rust formatting and whitespace checks pass.

Independent Mac worker reviewed the native fixture cfg changes, unchanged Mac marker-block failure semantics, and helper Result/UUID changes with no blocking finding. Full workspace and desktop-host gates must run after integration with the separately owned account/desktop repairs. These results are local Windows verification, not release signing or publication.

Merge the Windows fixture commit followed by the lint repair commit. Production change impact is behavior-preserving Rust cleanup; native test fixtures now exercise mandatory production custody on both supported platforms.
