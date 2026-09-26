# Signed candidate / resumable notarization handoff

Scope: explicit build-only stage before the owner notarization credential boundary, while preserving
the default complete pipeline and existing publisher gates. Base: c800aea755a1198c31cd64e219f160b42323c5f1.

Implementation: a distinct non-publishable candidate contract; signing-only environment validation;
mounted app/helper/signature/architecture/entitlement/build-info verification; immutable signed DMG;
digest-and-record-bound checkpoint with immediate Apple job persistence; exclusive invocation lock;
retry of the same job; disposable stapling copy; full Apple/staple/Gatekeeper verification before
exclusive atomic final artifact promotion and build/verify evidence. Unknown submission outcomes,
candidate mutation, different source/channel/team, and unrelated existing artifacts fail closed.
No publisher eligibility requirements were relaxed.

Verification: eight new tests first failed (unsupported options, absent candidate validator/resume
module). After implementation and additional interruption/tampering/candidate verification cases,
the seven release test files passed 74 tests, zero failures on Windows. Scoped Biome check and
git diff --check passed. Installed Mac notarytool wait --help independently confirmed the supported
wait, keychain-profile, timeout and JSON output arguments. No Apple submission, signing, install,
physical Gatekeeper proof or publication was performed by this packet.

Native recovery follow-up: canonical TMPDIR rerun on the isolated physical Mac passed 203 provider
library tests (one intentional ignore), two codex_account_binding and two fake_provider_versions.
The broader run then stopped at two gemini_managed_policy tests with missing guardian configuration.
This is not a full native suite pass. Separate native fixture/review work remains in progress.

Merge after cbe58da and c800aea. Before production use, execute the candidate stage on the final
clean integrated commit, then supply the owner-managed notary profile and resume. Final publication
still requires all applicable physical install, upgrade, provider and platform QA evidence.

Operational limits: an interruption before saving Apple's returned job ID requires explicit job
reconciliation; SIGKILL can leave the empty exclusive lock for operator inspection/removal. These
conditions block resubmission rather than guessing. Candidate metadata is local build evidence,
not a cryptographically authenticated remote attestation; retain it with the protected release
workspace and trusted signing identity.
