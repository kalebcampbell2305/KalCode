# Web account and billing release packet — 2026-09-25

## Authority and snapshot

- Isolated branch: `feature/web-account-release-20260925`
- Worktree: `.worktrees/web-account-release-20260925`
- Starting and current HEAD: `46b8526fbc44dbe72fd7f416cf156601da030e07`
- Canonical harvest source: `.worktrees/sec-harden` at `35c99cb43699813c8aba58e1fead6a5cd536076b`, with the account, checkout-hold, and mail lanes frozen on 2026-09-25.
- This branch remains uncommitted. It has not been pushed, deployed, signed, or published by this lane.
- Scope is 133 material paths: 87 tracked paths with 1,936 insertions and 507 deletions, plus 46 new files totaling 395,265 bytes and 8,413 lines. The Git status records appended below represent every path; Git collapses the four new provider-brand files into one untracked directory record.

## Coherent dependency closure

The candidate contains the complete `apps/api` and `apps/website` account release surface, the required protocol plan/feature/usage contracts, provider brand assets used by the site, the owner-grant admin path, billing/data/security/website documentation, and the future release-manifest generator.

The first isolated full run exposed two missing dependencies and failed for the intended reasons:

- API: 219/221 passed. `tests/unit/vectors.test.ts` rejected the old shared Rust vector limits and missing `max2x` case.
- Website: 294 passed, 1 failed, 4 skipped. The site test expected future release notes under `/updates`, while `tooling/release/manifest.mjs` still generated `/changelog`.

The minimal repair added only `crates/entitlements/src/document.rs`, `src/effective.rs`, `testdata/vectors.json`, `tests/vectors.rs`, and the future generator change in `tooling/release/manifest.mjs`. The production public key in `crates/entitlements/src/keys.rs` is deliberately deferred to the desktop release and remains unchanged here. Existing release identity fields remain unchanged; `apps/website/src/data/releases.json` changes only the current release notes URL from the legacy route to `/updates`. `/changelog` permanently redirects to `/updates`, and browser E2E proves the release anchor is preserved.

Released migration `apps/api/migrations/0001_entitlements.sql` is byte-identical to the base. All app files matched the final canonical freeze before six safe Biome format/import corrections were applied in this isolated candidate.

## Security and behavior

- GitHub identity remains owned by provider subject. Every existing and concurrent-creation return path reconciles the current verified primary email, invalidates stale attempts, and revokes sessions after a credential change. A verified-email collision fails as an explicit linked-account conflict; there is no merge or takeover.
- Email proof tokens are random, stored as hashes, expire, and are single use. Mail admission uses domain-separated keyed identities. Sign-in traffic cannot consume deletion-purpose recipient or network capacity.
- Web sign-in is the `/account` page. There is no `/sign-in` route or redirect contract. Email proof links return to `/account#verify=...`; the browser removes the fragment before the API exchange. Native GitHub OAuth uses `/v1/auth/github/*` and the `kalcode://auth/github` callback.
- OWNER grants are rejected while any nonterminal billable subscription exists. The admin tool performs the same safe preflight and never cancels a subscription automatically.
- `CHECKOUT_ENABLED` and `PUBLIC_CHECKOUT_ENABLED` are strict opt-ins. The production candidate keeps API checkout false and builds the website with paid buttons disabled. Portal and webhook handling remain available.
- Stripe server-key parsing accepts only live secret or restricted live server keys and rejects publishable/test keys. Secret presence is CONFIGURED, not permission or checkout proof.
- The website account query does not claim a payment from `?checkout=success`; it asks the signed-in user to refresh confirmed account state.
- Account/deletion and marketing email share a 90/day ceiling. Marketing is capped at 60/day, marketing plus sign-in at 80/day, and the last 10/day remain available for deletion. Per-network and per-recipient caps are purpose-scoped.
- `RELEASE_CATALOG_ENABLED` is a strict authority transition. Absent, `false`, `TRUE`, and `1` preserve the existing integrity-checked preview manifest and installer. Only exact `true` selects immutable D1 publication, which continues to fail closed without any legacy fallback.

## Verification evidence

- Focused repaired closure: API 39/39; website 25/25.
- API full: 24 files, 221/221 tests, exit 0.
- Website full: 19 files, 295 passed and 4 intentional skips, 299 total, exit 0.
- Protocol: 5 files, 56/56; TypeScript typecheck exit 0.
- API TypeScript and test typechecks: exit 0.
- Website Astro/Worker typecheck: 118 files, 0 errors, 0 warnings, 0 hints.
- Website production build with checkout flag absent/false: 18 pages, exit 0.
- Website real local Worker/browser E2E on isolated ports 4527/4528 and isolated D1 persistence: 145 passed, 8 existing conditional stage skips, 153 total, exit 0 in 3.5 minutes.
- Rust entitlement crate: 18/18 unit and 7/7 shared-vector tests, exit 0.
- Release manifest validation: release 0.1.1, one platform, exit 0.
- Cargo format check: exit 0.
- Biome candidate-scope check: exit 0 after six safe format/import fixes; one optional-chain warning and six test readability suggestions remain nonblocking and preserve explicit fixture intent.
- Post-format focused reproof: API mail/environment 18/18; website mail/D1 65/65; both app typechecks exit 0.
- Adversarial D1 immutability regression: RED proved a conflicting `INSERT OR REPLACE` silently replaced an existing `(channel, version)` descriptor. Pending migration `0003` now has a `BEFORE INSERT` mismatch guard that permits an exact idempotent claim and aborts any changed field before conflict handling. Focused workerd/D1: 7/7; post-repair website full: 19 files, 300/300; website typecheck remains clean.
- Release-authority continuity regression: RED proved the candidate selected an empty D1 catalog and returned 404 for the deployed preview. The strict gate now proves four disabled spellings use the legacy manifest and exact `true` selects empty D1 and fails closed. Focused download unit: 42/42; final website full: 19 files, 301/301; production build: 18 pages; real local Worker/browser download E2E: 4/4.
- `git diff --check`: exit 0.
- Forbidden-file scan: 0 environment, credential, private-key, database, WAL/SHM, dependency, build, Wrangler-state, or browser-result files in the candidate path list.

Official Gitleaks v8.30.1 scanned the 132 material candidate files with bytes (the removed changelog page has none). It reported 41 detector matches. All are deliberate, bounded test material:

- `apps/api/tests/unit/env.test.ts` lines 72 and 78: synthetic positive/negative Stripe server-key format cases.
- `apps/api/tests/unit/vectors.test.ts` lines 101 and 108: RFC 8032 published test seeds.
- `apps/api/tests/integration/d1-auth-billing.test.ts` lines 1017 and 1026: synthetic lease-ownership tokens.
- `crates/entitlements/testdata/vectors.json`: public deterministic test verification keys and signed JWT test vectors. The TypeScript and Rust suites both verify them, including tamper, expiry, wrong-account, and future-field cases.

No value, fingerprint, prefix, suffix, or length was copied into this evidence. The base-history scan's 153 matches are the previously adjudicated secret detectors/redactors and the same public deterministic test vectors; there is no production credential finding.

## Migrations and compatibility

Apply only forward migrations and capture D1 backups before each database:

1. Website D1: existing `0001`–`0002`, then `0003_release_publication_pointers.sql`, `0004_account_mail_dispatch.sql`, and `0005_fair_email_admission.sql`.
2. API D1: preserve released `0001`–`0003`, then `0004_max_2x.sql`, `0005_accounts_billing.sql`, and `0006_owner_billing_exclusion.sql`.

The migrations are additive. Rollback restores Worker versions and leaves the expanded schema in place. Do not attempt destructive down-migrations. The website RPC must deploy before the API because the API's `ACCOUNT_MAILER` binding targets `kalcode-website` and `AccountMailEntrypoint`.

## Reviewed production deployment order

1. Independently review this exact diff, commit it, create a rollback tag, fast-forward integrate it, push, and rerun the proving suites from the integrated commit.
2. Capture current website/API Worker version IDs, route/config state, D1 migration lists, and D1 backups. Confirm the expected current website deployment before mutation.
3. Apply website D1 migrations. Build with `PUBLIC_CHECKOUT_ENABLED` absent/false and deploy with `RELEASE_CATALOG_ENABLED=false`. Deploy `kalcode-website` first and verify all public pages, legacy redirect/anchor behavior, download range/If-Range behavior, account noindex/truth text, mail RPC availability, and asset parity.
4. Apply API D1 migrations. Upload the API version privately first with `CHECKOUT_ENABLED=false`; capture its version ID and bindings/config before routing traffic.
5. Enable the production `api.kalcoded.com` route/custom domain only after the private upload and configuration review. Deploy that exact captured version at 100% and retain the previous version/config as rollback authority.
6. Verify CORS/origin denial, unauthenticated account responses, email start neutrality, expired/replayed proof denial, checkout 503 with no Stripe side effect, webhook signature denial, account deletion authorization, and website-to-API account flow. Do not send real mail during certification; use deterministic/local adapters unless the owner separately authorizes a bounded production message.
7. Read back `/v1/entitlement/keys` and require exact `{kid,x}` parity with the desktop `PRODUCTION_KEYS` public half before enabling a signed desktop account release. Never read or expose private signing material.
8. Keep purchases disabled until a signed desktop release passes clean install, upgrade, rollback, updater signature, and entitlement-key parity. Only then enable API checkout first and rebuild/deploy the website with `PUBLIC_CHECKOUT_ENABLED=true` last.
9. Signed-release publishing must upload and verify every content-addressed descriptor/artifact, commit the immutable D1 version, advance and publicly probe the stable pointer, and only then switch `RELEASE_CATALOG_ENABLED=true` as the final atomic authority step. Do not enable it automatically from this website increment.

Rollback: immediately restore both captured Worker versions/configs and keep checkout false. Database changes remain additive. Before the first signed authoritative publication, rollback may retain `RELEASE_CATALOG_ENABLED=false` to preserve the verified preview. After authority has switched, rollback must preserve `true`; never automatically downgrade to legacy objects because of a catalog error. If API routing is at fault, remove/restore the `api.kalcoded.com` route to the captured predeployment state. If website mail RPC is at fault, restore the website Worker before restoring the API so the binding never points at an incompatible entrypoint.

## Truth and residual gates

- Account/API/site implementation: IMPLEMENTED and locally VERIFIED.
- Stripe catalog, webhook, portal, and secret names: CONFIGURED. The server key's production permissions remain NOT_PROBED_THIS_PASS.
- Checkout: deliberately OFFLINE by strict release hold; this is the required production state for this increment.
- Legacy preview download path: locally VERIFIED and intended to remain LIVE for this deployment. Immutable D1 release authority: IMPLEMENTED and CONFIGURED but intentionally not ACTIVATED until signed stable publication is complete and probed.
- GitHub OAuth: implemented but remains NEEDS_OAUTH until the registered production client is configured and probed.
- Production email: configured but no real email was sent in this lane.
- API custom domain: not configured in source and must be enabled in the reviewed deployment transaction.
- Production public-key parity and signed desktop clean-install/upgrade gates: BLOCKED until the desktop release lane integrates the public key and proves the signed artifacts.
- Memory mutations: 0. Archive imports: 0. External messages: 0. Charges/subscriptions/customer mutations: 0. Paid-provider calls: 0. Production database mutations: 0. Secret/private-file staging count: 0.

## Exact candidate path list

The following is the explicit candidate list. `M`, `D`, and `??` are the current Git status classifications; nothing is staged.

```text
 M apps/api/tests/integration/admin-tools.test.ts
 M apps/api/tests/integration/d1-no-replace.test.ts
 M apps/api/tests/integration/d1-schema.test.ts
 M apps/api/tests/integration/worker.test.ts
 M apps/api/tests/support/dev-server.ts
 M apps/api/tests/support/wrangler.ts
 M apps/api/tests/unit/entitlement.test.ts
 M apps/api/tests/unit/keys.test.ts
 M apps/api/tests/unit/router.test.ts
 M apps/api/tests/unit/source-invariants.test.ts
 M apps/api/tests/unit/vectors.test.ts
 M apps/api/worker/lib/auth.ts
 M apps/api/worker/lib/entitlement.ts
 M apps/api/worker/lib/env.ts
 M apps/api/worker/lib/keys.ts
 M apps/api/worker/lib/period.ts
 M apps/api/worker/lib/router.ts
 M apps/api/worker/lib/store.ts
 M apps/api/wrangler.jsonc
 M apps/website/scripts/screenshots.mjs
 M apps/website/src/components/DownloadPlatforms.astro
 M apps/website/src/components/Footer.astro
 M apps/website/src/components/Header.astro
 M apps/website/src/components/ProviderGlyph.astro
 M apps/website/src/components/stage/WorkspaceStage.astro
 M apps/website/src/components/stage/icons.css
 M apps/website/src/components/stage/parts/Glyph.astro
 M apps/website/src/data/releases.d.ts
 M apps/website/src/data/releases.json
 M apps/website/src/layouts/Base.astro
 M apps/website/src/lib/site.ts
 D apps/website/src/pages/changelog.astro
 M apps/website/src/pages/docs/kalvoice.astro
 M apps/website/src/pages/download.astro
 M apps/website/src/pages/index.astro
 M apps/website/src/pages/kalvoice.astro
 M apps/website/src/pages/pricing.astro
 M apps/website/src/pages/product.astro
 M apps/website/src/styles/critical.css
 M apps/website/src/styles/site.css
 M apps/website/tests/e2e/download.spec.ts
 M apps/website/tests/e2e/helpers.ts
 M apps/website/tests/e2e/interaction.spec.ts
 M apps/website/tests/e2e/links.spec.ts
 M apps/website/tests/e2e/pages.spec.ts
 M apps/website/tests/e2e/pricing.spec.ts
 M apps/website/tests/e2e/stage-demos.spec.ts
 M apps/website/tests/e2e/stage-story.spec.ts
 M apps/website/tests/e2e/stage-voice.spec.ts
 M apps/website/tests/unit/download-render.test.ts
 M apps/website/tests/unit/downloads-r2.test.ts
 M apps/website/tests/unit/downloads.test.ts
 M apps/website/tests/unit/early-access.test.ts
 M apps/website/tests/unit/fakes.ts
 M apps/website/tests/unit/fixtures/releases.ts
 M apps/website/tests/unit/fixtures/wrangler.r2.jsonc
 M apps/website/tests/unit/release-manifest.test.ts
 M apps/website/tests/unit/router.test.ts
 M apps/website/tests/unit/site.test.ts
 M apps/website/tests/unit/store-d1.test.ts
 M apps/website/worker/downloads.ts
 M apps/website/worker/index.ts
 M apps/website/worker/lib/early-access.ts
 M apps/website/worker/lib/router.ts
 M apps/website/worker/lib/security.ts
 M apps/website/worker/lib/store.ts
 M apps/website/wrangler.jsonc
 M crates/entitlements/src/document.rs
 M crates/entitlements/src/effective.rs
 M crates/entitlements/testdata/vectors.json
 M crates/entitlements/tests/vectors.rs
 M docs/BILLING.md
 M docs/DATA_MODEL.md
 M docs/SECURITY.md
 M docs/WEBSITE.md
 M packages/protocol/src/entitlements.test.ts
 M packages/protocol/src/entitlements.ts
 M packages/protocol/src/features.test.ts
 M packages/protocol/src/features.ts
 M packages/protocol/src/plans.test.ts
 M packages/protocol/src/plans.ts
 M packages/protocol/src/usage-receipts.test.ts
 M packages/protocol/src/usage-receipts.ts
 M tooling/admin/grant-owner.mjs
 M tooling/admin/lib.mjs
 M tooling/admin/request-legacy-confirmation.mjs
 M tooling/release/manifest.mjs
?? apps/api/migrations/0004_max_2x.sql
?? apps/api/migrations/0005_accounts_billing.sql
?? apps/api/migrations/0006_owner_billing_exclusion.sql
?? apps/api/tests/integration/d1-account-migration.test.ts
?? apps/api/tests/integration/d1-auth-billing.test.ts
?? apps/api/tests/integration/d1-max2x-migration.test.ts
?? apps/api/tests/unit/account-mailer.test.ts
?? apps/api/tests/unit/auth-routes.test.ts
?? apps/api/tests/unit/billing-plans.test.ts
?? apps/api/tests/unit/billing-routes.test.ts
?? apps/api/tests/unit/crypto.test.ts
?? apps/api/tests/unit/email-auth.test.ts
?? apps/api/tests/unit/env.test.ts
?? apps/api/tests/unit/github-oauth.test.ts
?? apps/api/tests/unit/stripe.test.ts
?? apps/api/worker/lib/account-mailer.ts
?? apps/api/worker/lib/account-store.ts
?? apps/api/worker/lib/auth-routes.ts
?? apps/api/worker/lib/billing-plans.ts
?? apps/api/worker/lib/billing-routes.ts
?? apps/api/worker/lib/billing-store.ts
?? apps/api/worker/lib/crypto.ts
?? apps/api/worker/lib/email-auth.ts
?? apps/api/worker/lib/github-oauth.ts
?? apps/api/worker/lib/stripe.ts
?? apps/website/migrations/0003_release_publication_pointers.sql
?? apps/website/migrations/0004_account_mail_dispatch.sql
?? apps/website/migrations/0005_fair_email_admission.sql
?? apps/website/src/pages/account.astro
?? apps/website/src/pages/updates.astro
?? apps/website/tests/e2e/account.spec.ts
?? apps/website/tests/unit/account-mail-d1.test.ts
?? apps/website/tests/unit/account-mail-service.test.ts
?? apps/website/tests/unit/account.test.ts
?? apps/website/tests/unit/fixtures/updater-descriptor.ts
?? apps/website/tests/unit/release-catalog.test.ts
?? apps/website/tests/unit/updater-descriptor.test.ts
?? apps/website/worker/lib/account-mail-service.ts
?? apps/website/worker/release-catalog.ts
?? apps/website/worker/updater-descriptor.ts
?? docs/campaigns/ACCOUNT-AUTHORITY-RESUME-20260925.md
?? docs/campaigns/WEB-ACCOUNT-RELEASE-20260925.md
?? packages/ui/src/brand/providers/
```

## Lead integration preflight

- Lead independently reran the isolated API suite:221/221 and website suite after
  the catalog transition repair:301/301. No hidden/skipped unit tests in these runs.
- Candidate explicit audited inventory is133 paths; forbidden/private artifacts0.
- Current production website version:efc54336-db57-467f-a826-8b442827d2ed.
- Current private API version:b8a84aee-7b09-44e2-b353-da78ba0839ed.
- Fresh remote migration lists: website0003/0004/0005 pending; API0006 pending.
  API0004/0005 are already applied; do not replay them manually.
- Both D1 Time Travel bookmarks were captured without exporting production data.
- Name-only secret inspection confirms API signing/rate-limit/Stripe/webhook and
  website mail credentials are encrypted; values were not retrieved.
- Current public Windows preview HEAD succeeds200, version0.1.1, executable MIME.
  The catalog transition stays disabled during this website/account increment.
