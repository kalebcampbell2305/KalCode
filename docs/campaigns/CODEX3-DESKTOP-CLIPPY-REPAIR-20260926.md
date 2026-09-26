# Desktop native host Clippy repair

Base: `13e3f77`; branch: `codex3/desktop-clippy-repair`.

## Changes

- AdmissionSession owns a nonoptional provider session as its first field. Rust declaration-order field destruction still drops that session before the lifecycle reference; the process-owned event sink continues retaining its capacity reservation until actual process exit. Removes a redundant Option and production panic without releasing capacity early.
- WINTRUST_DATA and CERT_CHAIN_PARA use struct initializers with identical fields, union pointer, revocation/cache/algorithm flags, timeout, and zero-default remainder. No signature, publisher, or revocation policy is relaxed.
- Three narrow argument-count allowances preserve the established flat Tauri IPC mapping and explicit authority/dependency bindings. Existing neighboring commands use the same scoped convention; no unsafe unwrap lint is suppressed.
- Account command tests move below production items without changing test content. Signed installer test fixtures propagate missing SDK/IO errors to their test callers.
- Browser focus event symbols/import are Windows-only, matching their sole implementation and removing physical-Mac compilation warnings. No Mac focus behavior is added by this packet.

## Evidence

- Full Windows desktop library tests: **185 passed**, including resource admission lifecycle/drop retention, account metering, signed provisioning, and native updater signature/revocation policy tests.
- Strict desktop production-library Clippy: **passes**, warnings denied.
- Repeated all-target Clippy after this repair reports only **15 existing unwrap helper findings in kalvoice_provisioning_tests.rs**. The account worker owns that separate fixture cleanup; this document does not claim all-target Clippy green.
- Offline frozen pnpm install reapplied the new cmdk patch after updating to the final base; real desktop production frontend build succeeds. Its bundle-size warnings remain informational.
- Rust formatting and whitespace checks pass.

Parent independently reviewed provider drop-order and Windows verification structure changes without a blocking finding. Integrate this packet with the provisioning fixture follow-up before the final full-workspace/native E2E gate. No signing, deployment, or publication occurred.
