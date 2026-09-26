# KalVoice production local interpreter wiring

Scope: connect the existing local interpreter, signed component store, process guardian, and Resource Governor to the account-owned desktop runtime. There is no provider inference fallback. The existing deterministic command/dictation router is unchanged.

## Customer flow

- Settings → KalVoice → Review download fetches and verifies catalog metadata only. The dialog identifies runtime version, model version, and total download size.
- Download passes the exact catalog identity that was displayed. Missing consent, changed identity, expired/invalid metadata, or a rejected monotonic floor cannot begin artifact acquisition.
- The runtime and reasoning model are acquired separately from speech models. Cancellation retains resumable acquisition state. Shutdown seals new download registration before draining existing work.
- Startup and successful installation warm only installed, verified components. The local worker uses the canonical crash guardian, retained component leases, and a Resource Governor reservation that survives failed cleanup. Requests never download or launch a worker implicitly.
- Retry local startup retries installed components without requesting a catalog or redownloading. Missing or unavailable local interpretation is reported honestly; deterministic commands and unlimited local dictation retain their existing paths.

## Verification at handoff

- Two new production ownership/consent source regressions initially failed; all nine ownership checks now pass.
- `cargo test -p kalcode-kalvoice --lib -- --test-threads=1`: 234 passed, two existing ignored. Added three-provider × three-focus regression verifies local commands and unavailable interpretation never call a provider directory, including stored legacy provider preferences.
- Full desktop Vitest: 849 passed across 96 files. Four new consent UI tests cover exact quoted metadata, no acquisition before consent, cancellation, unavailable catalog, and installed-runtime retry without a download.
- Desktop TypeScript, scoped Biome, capability inventory (195 commands), diff checks, and Windows `cargo check -p kalcode-desktop --lib`: passed.
- New native desktop fixtures use synthetic signed catalogs, an in-memory credential store, acquisition mocks, and a mock resident worker. They cover quote/consent binding, invalid metadata, cancellation, shutdown registration fencing, missing components, and cleanup retry retaining capacity. Their execution is pending the independently owned browser test-contract repair: existing `browser_profile_authority` references are undefined and test calls pass three arguments to a two-argument `label` function. This is not physical microphone or installed-customer end-to-end proof.
- Independent review found unsupported-host fixture assumptions; these host-specific tests now run only on supported Windows x64 / macOS arm64 targets. No other blocking changed-scope lifecycle/consent finding was reported.

## Integration and remaining release proof

This branch includes dependency cherry-picks of component-store helper repair `635853f` and notification contract restoration `aef6d01`. Integrate the wiring commit alone after those repairs; avoid replaying their equivalent commits. Its KalVoiceProvider changes concern download/status only; preserve the parent's separately reviewed talk/dictation attribution changes when merging.

After the browser repair, run the focused native desktop KalVoice tests and broader integrated gates. The signed Windows runtime, model, and five speech artifacts must still complete the release owner's verified publisher flow and live download/install/cleanup QA. macOS requires its own approved curated signed runtime, notarization and physical-device verification; Windows artifacts must not be offered to it. This patch does not claim artifact publication or physical voice testing.

The existing production `ProvisionalEntitlement` still returns Free. A separate account-authoritative entitlement/usage adapter remains a release blocker; this packet deliberately preserves that independently queued scope.
