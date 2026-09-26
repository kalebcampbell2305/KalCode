# Windows release recovery evidence — 2026-09-25

## Scope and authority

- Worktree: `.worktrees/sec-harden`
- Branch: `sec/providers-harden`
- Verified starting commit: `35c99cb43699813c8aba58e1fead6a5cd536076b`
- Owned paths: `tooling/release/**`, `tooling/updater-signer/**`, and `.github/workflows/windows-release-verify.yml`
- Release actions deliberately excluded from this isolated verification lane: credential discovery, product signing, candidate upload, publication, deployment, commit, and push.

The pre-existing release implementation was preserved. The earlier read-only session's 14 `EPERM` fixture failures did not reproduce after writable access was restored: the first fresh release-only run passed 71 of 71 tests.

## Confirmed defects repaired

1. **Partial publication retry changed immutable descriptor identity.** `publish.mjs` generated a new `publishedAt` on every process run, which changed both descriptor hashes and prevented a later process from reusing objects uploaded before an interruption. Remote and authority-bootstrap publication now persists a closed, non-secret `publication.json` state immediately before the first upload. A retry validates that state against the exact build and reuses its timestamp. Dry runs and local simulations do not establish remote publication state.
2. **Final application signature evidence was optimistic.** The build record set the application timestamp and bundle-verification fields from the requested signing mode. The release build now re-probes the final `kalcode.exe` and bundled installer, requires both Authenticode signatures to be valid and timestamped, and records the measured application evidence. Unsigned local simulations also reject unexpectedly signed build outputs.
3. **Clean-machine updater verification accepted a weaker trusted-comment timestamp.** The Rust verifier previously required only a `timestamp:` field, while the independent JavaScript publisher required a canonical positive numeric epoch. The Rust verifier now enforces the same timestamp grammar plus the exact artifact filename and version.
4. **The provider guardian was absent from the Windows release authority.** The desktop resolves `kalcode-provider-guardian.exe` only as a sibling of `kalcode.exe`, but the release build neither built nor bundled that binary. The release builder now compiles the exact production bin into the same release target, requires it to begin unsigned, signs and verifies it against the pinned timestamped Artifact Signing identity before Tauri bundles it, maps it to the Windows resource root beside the application, and records only its SHA-256 and redacted signature facts. Clean-machine verification measures the installed helper's exact hash, signature, timestamp, and signer during no-shortcut, default, and update passes. Publication and updater-manifest gates reject missing or incomplete guardian evidence. Unsigned dev simulation records an unsigned guardian and remains ineligible for publication.
5. **Clean-machine verification trusted any single Artifact Signing subscriber identity.** The verifier measured that one subscriber OID existed, but did not require the configured KalCode publisher OID. A differently signed candidate could therefore satisfy the mutable build-record boolean and same-signer checks. Verification now compares the measured installer identity exactly with the pinned publisher OID; application and guardian same-signer checks then bind every installed executable to that measured authority. A deterministic regression rejects a single foreign subscriber OID.

Each correction received a deterministic regression that failed for the intended missing behavior before the implementation changed.

## Verification evidence

Fresh commands run from `.worktrees/sec-harden`:

- `node --test tooling/release/*.test.mjs` — **80 passed, 0 failed, 0 skipped**.
- `cargo build --locked --release -p kalcode-providers --bin kalcode-provider-guardian -j 2` — passed in the optimized profile with no warnings; the local checkpoint artifact was a fresh non-empty regular file and remained explicitly `NotSigned`, so it is not publishable evidence.
- `cargo test --release --manifest-path tooling/updater-signer/Cargo.toml --locked` — **6 passed, 0 failed** in the optimized profile.
- `cargo clippy --manifest-path tooling/updater-signer/Cargo.toml --locked --all-targets -- -D warnings` — passed with no warnings.
- `cargo fmt --manifest-path tooling/updater-signer/Cargo.toml -- --check` — passed.
- `pnpm exec biome check tooling/release` — 25 files checked, no diagnostics after formatting.
- `git diff --check -- tooling/release tooling/updater-signer .github/workflows/windows-release-verify.yml docs/campaigns/RELEASE-RESUME-20260925.md` — passed.
- Node syntax verification covered all 24 release `.mjs` modules after the corrections.

The updater-signer tests use a disposable temporary DPAPI store and artifact. They do not read or mutate the real updater signing store.

## Security and release review

- SignTool output remains redacted and subprocess windows remain hidden.
- The tracked updater public key is public material; private updater key material remains Windows current-user DPAPI protected and outside the application runtime.
- Public publication remains fail closed on exact build, stable channel, valid timestamped Authenticode, durable publisher OID, version-bound updater signature, clean-machine install/upgrade/uninstall evidence, immutable R2 readback, and the monotonic D1 pointer.
- Public publication additionally requires the canonical provider guardian, its exact build hash, valid timestamped publisher-bound signature, and matching installed evidence in every clean-machine pass.
- The GitHub verification workflow remains manual, private-draft based, least privilege (`contents: read`), action-SHA pinned, and contains no signing credentials.
- No secret values, certificate subjects, thumbprints, tokens, private keys, or credential fingerprints were printed or added to evidence.

## Honest remaining gates

This lane proves the release tooling and disposable updater signer. It does not certify a product candidate. After the integration writer produces a clean committed candidate, release completion still requires:

1. a real stable-channel production build from that exact clean commit;
2. Azure Artifact Signing and updater signing of the actual installer;
3. the private clean-machine Windows workflow for install, update-mode rehearsal, signature verification, and uninstall;
4. candidate publication, D1/R2 readback, website deployment, and production endpoint verification under the owner's already-approved release authority.

Those actions were not simulated and are not labeled complete here. External-effect count: **0**. Paid-provider call count: **0**. Product signing count: **0**. Publication/deployment count: **0**. Secrets or private files staged: **0 observed in this lane**.

## Smallest independent website increment

The smallest production-safe website increment in the preserved work is the R2 download representation-integrity repair. Isolate only these existing hunks from the mixed website worktree:

- `apps/website/worker/downloads.ts`: require a strong exact `If-Range` ETag; after `head` and `get`, require the streamed object's ETag and size to match the metadata used to construct the response, otherwise cancel the body and return `503`.
- `apps/website/tests/unit/downloads.test.ts`: the two tests under `download representation integrity`.

This increment has no schema, configuration, account, protocol, release-catalog, updater, static-page, or manifest dependency. Current-tree assessment evidence:

- `pnpm --filter @kalcode/website exec vitest run tests/unit/downloads.test.ts -t "download representation integrity"` — **2 passed**.
- Release/download neighboring tests (`downloads.test.ts`, `downloads-r2.test.ts`, `release-catalog.test.ts`, `updater-descriptor.test.ts`) — **64 passed**.
- `pnpm --filter @kalcode/website typecheck` — 118 files, 0 errors, 0 warnings, 0 hints.
- `pnpm --filter @kalcode/website build` — 18 static pages, exit 0.

The D1 release-authority Worker is not safe as the first independent deployment. The currently published `0.1.1` manifest describes an unsigned preview, no staged release candidate exists in this worktree, and the new Worker intentionally has no mutable-R2 fallback. Deploying it before migration `0003_release_publication_pointers.sql` and an exact signed-candidate bootstrap would withdraw the live download routes. Treat that authority cutover as a later atomic migration/bootstrap/deploy increment.

## Rollback

The release corrections remain uncommitted in the canonical worktree for the integration writer to audit with the rest of the preserved campaign. File-level rollback is the audited diff from starting commit `35c99cb43699813c8aba58e1fead6a5cd536076b`; no destructive reset, stash, merge, tag, commit, or push was performed by this lane.

## Download-integrity production increment

The isolated download representation-integrity repair was committed as `46b8526fbc44dbe72fd7f416cf156601da030e07` with rollback tag `rollback/download-integrity-20260925`. The reviewed worker-only deployment preserved the existing static assets and promoted Cloudflare Worker version `efc54336-db57-467f-a826-8b442827d2ed` to 100% production traffic. A fresh `wrangler deployments status --json` probe reported that exact version at 100% with deployment annotation tied to the exact commit.

Fresh read-only production probes against `https://kalcoded.com` proved:

- `HEAD /download/windows-x64` returned `200`, version `0.1.1`, `Accept-Ranges: bytes`, a strong ETag, and the expected 4,383,539-byte object length.
- `Range: bytes=0-15` with the exact strong `If-Range` validator returned `206`, exactly 16 bytes, and `Content-Range: bytes 0-15/4383539`.
- The same range with a weak form of that validator returned `200`, the complete 4,383,539-byte representation, and no `Content-Range` header.
- All 139 files from the previously deployed static build were fetched from production with the expected status and were byte-identical: 17 HTML routes, including the explicit 404 probe, plus 122 static assets. This proves the worker-only release did not replace or regress the intentionally preserved production asset set.

No mutation was used for these verification probes. The deployment was the single external effect in this increment; the verification added zero external effects and made zero paid-provider calls.

## Account and billing production-readiness audit

The production account/billing rollout was inspected without mutating Cloudflare or Stripe. The existing `kalcode-api` deployment serves version `e64c8d21-0f6a-48a5-b680-176a4e982ecb` at 100%, but it is intentionally unreachable: `workers_dev` is disabled, no route or custom domain is declared, and `api.kalcoded.com` does not resolve. Its deployed bindings are limited to D1, the authentication rate-limit secret, the entitlement signing secret, and the retired-public-key variable. The GitHub OAuth values, Stripe values, three Stripe Price ids, and `ACCOUNT_MAILER` binding are not present in the live version.

Remote D1 reported no pending migrations against the complete `0001` through `0005` migration set. A dry-run bundle of the pending API source succeeded at 115.18 KiB (24.58 KiB gzip) and resolved the intended `ACCOUNT_MAILER` service binding to `kalcode-website#AccountMailEntrypoint`. The current production website version does not yet expose that named entrypoint, so the website Worker must be upgraded first with its static assets preserved and reverified.

Stripe CLI 1.52.0 was authenticated only to the non-live sandbox. Live-mode catalog access was unavailable, so no claim is made about production catalog, webhook, or portal state. The sandbox contained active Pro, MAX, and MAX 2X products; Pro and MAX had the expected monthly prices, while MAX 2X had no Price. It had no webhook endpoint and no customer-portal configuration. Because the application requires three distinct Price ids, billing remains correctly disabled in that state.

No credential value, credential prefix, customer record, payment data, or private database content was read into evidence. This audit created no Stripe customer, Checkout session, subscription, charge, webhook, portal configuration, message, deployment, or DNS change. Production rollout remains blocked on live-mode Stripe access and catalog verification, the live portal and webhook configuration, deployable Cloudflare secrets and variables, the website mail RPC entrypoint, GitHub OAuth registration if that sign-in method ships, and the `api.kalcoded.com` custom domain.
