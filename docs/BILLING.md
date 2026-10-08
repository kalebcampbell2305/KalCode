# KalCode Billing, Entitlements and KalVoice Requests

Status: production account API and live monthly/yearly Stripe billing are active.
The owner directive dated 2026-10-04 in `AGENTS.md` supersedes historical pricing and metering rules.
This document is the reference for what an account may use, who decides it, and how that decision
reaches the desktop app. Prices and plan limits live in one place:
`packages/protocol/src/plans.ts`.

## 1. Plans and business rules

| Plan | Monthly | Yearly | KalVoice Requests / monthly cycle | Public |
| --- | --- | --- | --- | --- |
| **Free** | $0 | $0 | 25 | yes |
| **Pro** | $10 / month | $100 / year | 150 | yes |
| **MAX** | $25 / month | $250 / year | 500 | yes |
| **MAX 2X** | $50 / month | $500 / year | 1,000 | yes |
| **OWNER** | $0, forever | — | unlimited | **no** — private, never listed, never purchasable |

Signed plan limits (`LIMITS` in `packages/protocol/src/entitlements.ts`; `null` = no KalCode-side
limit). Every entitlement document carries the canonical numeric limits for a restricted tier:

| Limit | Free | Pro | MAX | MAX 2X | OWNER |
| --- | --- | --- | --- | --- | --- |
| `kalvoiceRequestsPerMonth` | 25 | 150 | 500 | 1,000 | unlimited |
| `openTerminals` | unlimited | unlimited | unlimited | unlimited | unlimited |
| `parallelAgents` | unlimited | unlimited | unlimited | unlimited | unlimited |
| `workspaces` | unlimited | unlimited | unlimited | unlimited | unlimited |
| `providerAccounts` | 2 | 6 | 12 | unlimited | unlimited |
| `brainstormsPerMonth` | 3 | unlimited | unlimited | unlimited | unlimited |
| `launchRecipes` | 1 | 10 | unlimited | unlimited | unlimited |
| `externalIntegrations` | 1 | 5 | 25 | unlimited | unlimited |
| `operationsHistoryDays` | recent 10 Runs | 30 | 365 | maximum | maximum |
| `queuedTasks` | 3 | unlimited | unlimited | unlimited | unlimited |

The billing interval changes only how often Stripe charges. Monthly and yearly Prices for a plan
resolve to the same tier and the same limits; KalVoice Request allowances reset monthly on both
(§7).

Rules (owner decisions, encoded in `plans.ts` and enforced by the code below):

- **Bring your own provider.** Model inference runs on the user's own Claude Code / Codex /
  Gemini CLI account. KalCode never pays for, resells or meters provider usage.
- **Zero company AI cost.** No KalCode service calls a hosted AI or speech API, and KalCode holds
  no company AI keys. Guarded by `tooling/check-zero-cost.mjs` and
  `apps/api/tests/unit/source-invariants.test.ts` (no outbound requests from the API at all, no AI
  bindings, no AI SDKs).
- **Never paywalled, on every plan:** connecting providers, every permission mode (Plan, Approve,
  Auto, Bypass, Custom), and local KalVoice dictation (on-device, never metered).
- Plans differ by **KalVoice Requests**, the plan limits above (open terminals, parallel agents,
  workspaces, provider accounts) and KalCode features (persistent agents, multi-agent workflows,
  automations, advanced missions) — never by safety controls.
- The user-facing unit is **KalVoice Requests**, never "tokens". Provider model tokens are not
  KalVoice Requests and are never counted anywhere.

## 2. The entitlement model

An **entitlement** is the server's answer to "what may this account use right now". It is
computed only by the API from trusted backend state and delivered to the desktop as a signed
document. The model is shared by TypeScript (`packages/protocol/src/entitlements.ts`) and Rust
(`crates/entitlements`, `kalcode_entitlements`).

```ts
type EntitlementTier = "free" | "pro" | "max" | "max2x" | "owner";

interface Entitlement {           // signed document payload (JWS, typ kalcode-entitlement.v1)
  version: 1;
  accountId: string;
  tier: EntitlementTier;
  unrestricted: boolean;          // true exactly when tier === "owner"
  features: string[];             // granted features (restricted tiers only)
  limits: Record<string, number | null>; // null = unlimited (restricted tiers only)
  issuedAt: number;               // Unix seconds
  expiresAt: number;              // Unix seconds — DOCUMENT validity (offline grace), not a subscription end
  keyId: string;                  // Ed25519 key that signed it (= header kid)
}
```

Evaluation (`hasFeature` / `limitFor` in TS, `has_feature` / `limit` in Rust):

- `unrestricted === true` → **every** feature is granted and **every** limit is unlimited, by
  construction. Nothing is enumerated for OWNER, so a feature or limit added in any future version
  is covered automatically — there is no list to forget to update.
- Otherwise a feature is granted only if the document lists it, and a limit is its documented
  value. An unknown feature is `false` and an unmentioned limit is `0` (fail closed).
- Public-tier grants are derived from `plans.ts` by `tierGrants(tier)`; the server puts them into
  every document it signs, so the client never needs its own copy of the catalog.

Both implementations reject the same documents: wrong version, unknown tier, `unrestricted` not
matching `tier === "owner"`, malformed lists, `expiresAt <= issuedAt`, a claimed lifetime above
14 days, a `keyId` differing from the header. The shared vectors pin this (§12).

## 3. The OWNER tier

OWNER is a private, server-authoritative entitlement for the KalCode owner's own account:

- **Non-billable:** it is never attached to a subscription; the database refuses OWNER from the
  billing source (`CHECK owner_requires_operator_grant`).
- **Never expires:** an OWNER grant cannot carry an end date (`CHECK owner_never_expires`) and
  resolution ignores time for it. (The *signed document* that carries it still expires after
  7 days and is re-issued — that is a freshness proof, not an expiry of the entitlement.)
- **Not purchasable:** it is not in `PLANS`; the website renders `PLANS`; tests assert OWNER never
  appears in the public catalog; no API endpoint, checkout or webhook can produce it.
- **All current and future functionality, no charges, no plan restrictions:** `unrestricted`
  (§2), unlimited KalVoice Requests (the ledger never denies OWNER, §7).
- **No frontend check, no email bypass:** no code compares an email address or account id to a
  constant; the desktop only honours a document signed by the API; the grant is a row in D1 that
  only a trusted operator with Cloudflare credentials to the production database can write.
- **Atomic activation:** the valid operator grant activates the verified account in the same D1
  statement. Deleted accounts are refused by a database trigger and cannot regain authority.

## 4. Server-side resolution and the API

`apps/api` (`@kalcode/api`) is a Cloudflare Worker with a D1 database (`kalcode-api`). Schema:
`apps/api/migrations/` and `docs/DATA_MODEL.md` §4.

`resolveEntitlement(accountId)`: among grants that are not revoked and not expired —
an active OWNER operator grant, else the highest active public paid grant (billing or operator),
else Free. Free is the absence of grants.

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `GET /v1/entitlement` | authenticated account | the caller's signed entitlement `{ token, entitlement }` |
| `GET /v1/entitlement/keys` | public | published Ed25519 verification keys (current + retired), by `kid` |
| `GET /v1/kalvoice/usage` | authenticated account | the caller's cycle usage + signed usage receipt |
| `POST /v1/kalvoice/requests` | authenticated account | count one KalVoice Request (idempotent) + signed receipt |

There is **no** endpoint that grants, changes or revokes a tier (pinned by
`tests/unit/router.test.ts`). The Worker's only database write is inserting the caller's own
KalVoice Request rows (pinned by `tests/unit/source-invariants.test.ts`).

**Authentication.** Account routes run behind `authenticate(request)` (`worker/lib/auth.ts`).
The production authenticator accepts only unexpired, unrevoked server-issued sessions whose bearer
token hashes to a D1 record. Passwordless email is the primary session-creation path; GitHub OAuth
is optional. Until the account Worker is configured and deployed, `SIGN_IN_UNAVAILABLE` rejects
every request. Tests use
`tests/support/test-auth.ts`, which is never imported by the Worker entry point. The account id
always comes from the authenticator — never from a request body, query or header the client
controls.

Other controls: JSON-only bodies ≤ 1 KiB with strict field validation, `Origin`-bearing (browser)
writes refused, restrictive security headers, no CORS, generic error bodies, structured logs
without tokens, keys, emails or account ids.

## 5. Grants and revocations (operator tools)

OWNER is granted and revoked only with the trusted operator tools in `tooling/admin/`. They run
`wrangler d1 execute` with the **operator's own Cloudflare credentials** — backend access no
KalCode client, website visitor or API caller has.

```bash
# Dry run (changes nothing, exit code 2), then the real grant:
node tooling/admin/grant-owner.mjs --email <verified account email> --reason "KalCode owner" --remote
node tooling/admin/grant-owner.mjs --email <verified account email> --reason "KalCode owner" --remote --confirm

node tooling/admin/revoke-owner.mjs --account <account id> --reason "<why>" --remote --confirm
```

- Target by `--account <id>` or `--email <address>`; the email must belong to an existing account
  (accounts exist only after sign-in verified the address). No email is hardcoded anywhere.
- Exactly one of `--local` (development database; `--persist-to <dir>` for an isolated copy) or
  `--remote` (production) is required; `--confirm` is required to write; `--reason` is required;
  `--operator` (default `operator:<OS user>`) is recorded as `granted_by` / `revoked_by`.
- Inputs are validated against strict patterns before being placed in SQL literals; no shell is
  involved in running wrangler.
- Idempotent: granting an account that already holds OWNER changes nothing.
- The database writes the `audit_log` row **in the same statement** as the grant or revocation
  (triggers), so no path can change an entitlement without an audit record. Grants are never
  edited or deleted; revocation is final (grant again to restore). `audit_log` is append-only.

## 6. Signing keys

Entitlement documents and usage receipts are compact JWS (RFC 7515) signed with **Ed25519**
(RFC 8037, WebCrypto in the Worker). The signature covers the exact transmitted bytes of
`base64url(header).base64url(payload)`; the header's `typ` (`kalcode-entitlement.v1` or
`kalcode-usage.v1`) is signed too, so one kind can never be replayed as the other.

- **Private key:** only in the Worker secret `ENTITLEMENT_SIGNING_KEY` (an Ed25519 private JWK
  with a `kid`). It is never in the repository, in `vars`, on disk, or in logs. On load the Worker
  checks that `x` really is the public half of `d`. Without the secret, signed endpoints answer
  503 — never an unsigned document.
- **Public keys:** published at `GET /v1/entitlement/keys`; the desktop trusts only keys
  **compiled into the binary** (`crates/entitlements/src/keys.rs`), never keys fetched at runtime.
  The first production public key (`k2026-09-25`) was pinned on 2026-09-25 after the private
  key was piped directly into the `kalcode-api` Worker secret. Secret-name verification passed;
  authenticated server-token verification by the installed desktop remains a release gate.
- **Create the production key** (Z13, at first deploy; nothing is written to disk):

  ```bash
  node tooling/admin/gen-signing-key.mjs --kid k2026-10 --stdout \
    | pnpm --filter @kalcode/api exec wrangler secret put ENTITLEMENT_SIGNING_KEY
  ```

  The public key and the exact `keys.rs` line are printed to stderr.
- **Local development:** `pnpm --filter @kalcode/api keys:dev` writes a throwaway key to the
  git-ignored `apps/api/.dev.vars`. Tests generate ephemeral keys per run.
- **Rotation:** (1) generate the new key; (2) add its public key to `keys.rs` and ship that
  desktop release; (3) once the release is the minimum supported version, switch the secret and
  move the old public key into `ENTITLEMENT_PREVIOUS_PUBLIC_KEYS` (published, still verifiable);
  (4) after every document signed by the old key has expired (≤ 14 days), remove it from both.
  A compromised key requires a desktop update removing that pin and server-side minimum-version
  enforcement. Old offline binaries cannot remotely revoke an embedded key; do not claim that
  rotating the Worker secret alone makes those binaries reject forged documents.
- **Key-loss recovery:** the first private key exists only in the Worker secret and is not
  retrievable. Loss requires generating a unique replacement key, distributing its public pin
  in a verified desktop update, then switching API signing. Existing signed documents remain
  bounded by their expiry; no unsigned entitlement fallback is permitted. A separately secured
  recovery-key ceremony and end-to-end rotation exercise remain release-readiness work.

## 7. KalVoice Requests and the usage ledger

**What counts.** One top-level request to the KalVoice assistant = 1 KalVoice Request, however
many internal steps it takes ("open four Codex threads" = 1). Dictation is never counted. Provider
model tokens are never counted. The ledger stores only an opaque client request id and a
timestamp — never request text, transcripts, audio or provider output.

**Cycles.** Allowances reset every monthly cycle, counted from an anchor (UTC):

- when an active **paid subscription** (billing grant) decides the tier → the subscription's start
  (`granted_at` of that billing grant; Z13 sets it to Stripe's billing-cycle anchor). This holds
  for **yearly** subscriptions too: the grant runs to Stripe's `current_period_end` a year out,
  but KalVoice cycles still reset every month from the anchor;
- otherwise — **Free**, OWNER, operator paid-tier grants → the **account's creation time**.

Cycle *k* runs from anchor + *k* months to anchor + *k*+1 months; a day that does not exist in a
month is clamped to its last day (anchor Jan 31 → Feb 28/29 → Mar 31 → Apr 30), always computed
from the anchor so it never drifts (`apps/api/worker/lib/period.ts`). Usage is counted by the time
each request was recorded, so a tier change mid-cycle never erases or duplicates requests; a new
subscription starts a new cycle at its start.

**Recording (`POST /v1/kalvoice/requests`).** Body `{ "requestId": "<8–128 of A-Z a-z 0-9 _ ->",
"mode": "online" | "offline" }`. Response `{ allowed, outcome, usage: { used, allowance,
periodStart, resetsAt }, receipt }` (`usage` matches the `KalVoiceUsage` contract).

- *At most once* per `(account, requestId)`: retries return `outcome: "duplicate"` and never
  count twice (a `UNIQUE` constraint, not application logic).
- `online` (default): recorded only while the cycle's allowance remains; otherwise
  `allowed: false, outcome: "denied"` and nothing is recorded. The allowance check and the insert
  are one SQL statement, so concurrent requests cannot both take the last unit (tested with
  concurrent calls against D1).
- **OWNER is never denied** (unlimited allowance); its usage is still recorded for display.
- `offline`: reports a request the desktop already served offline (below). It is always recorded
  (idempotently) and flagged `over_allowance` if it landed beyond the allowance.

**Receipts.** Every usage response carries a signed receipt (`typ kalcode-usage.v1`) with
`accountId, tier, used, allowance, periodStart, resetsAt, issuedAt, expiresAt, keyId`. It is valid
for 72 hours or until the cycle resets, whichever is sooner (verifiers reject claims beyond 7
days). The desktop can show "41 / 150 used; 109 remaining; renews October 10" from it.

**Offline allowance and reconciliation** (`EffectiveEntitlement::kalvoice_decision` in Rust):

1. OWNER (unrestricted) and unlimited allowances: always allowed.
2. With a verified receipt for the signed-in account: allowed while
   `receipt.used + unsynced < min(receipt.allowance, entitlement allowance)`, where `unsynced` is
   the number of requests served on this device since that receipt was issued.
3. Without a valid receipt (never synced, receipt expired, not signed in): the device's
   provisional count for its cycle is checked against the entitlement's allowance (Free's 25
   when there is no valid entitlement document).
4. Each request served offline keeps its client request id; when the device is online again it
   reports them with `mode: "offline"`. Idempotency makes replays safe to repeat; the fresh
   receipt replaces the local count.

Bound: an unmodified client can exceed its allowance only by requests it served while it could not
reach the ledger, and those are recorded and visible. KalVoice runs on the user's device with the
user's own provider, so a modified client could skip reporting entirely — metering is product
gating, not cost protection (KalCode has no AI cost to protect).

## 8. Desktop verification and offline grace

`crates/entitlements` (`kalcode_entitlements`) is the desktop's canonical verifier. The Z13 native
account runtime owns secure token custody, refresh and this verifier call; a release remains
fail-closed until that runtime is integrated and the production public key is pinned.

- `Verifier::verify(token, now)`: strict base64url, `alg = EdDSA`, `typ = kalcode-entitlement.v1`,
  known `kid`, `ed25519-dalek` `verify_strict` (rejects malleable signatures and weak keys),
  document validation, then time (5-minute skew tolerance on `issuedAt`, hard stop at
  `expiresAt`). Error codes match the TypeScript verifier exactly.
- `effective_entitlement(cached, now)`: returns the verified entitlement only if the document is
  valid **and issued to the signed-in account**; otherwise Free, with the reason
  (`NoDocument`, `Rejected(error)`, `WrongAccount`). A copied document does not make another
  account OWNER.
- **Offline grace is bounded by the document:** the API issues 7-day documents (sooner for a paid
  grant that ends earlier: period end plus the 72-hour renewal grace); verifiers refuse any document claiming more than 14 days. After it
  expires the device runs on Free until it can fetch a fresh document. This applies to OWNER as
  well, so a revocation reaches every device within 7 days.

## 9. Z13 account and billing implementation

| Z13 piece | Plugs into | Notes |
| --- | --- | --- |
| Passwordless sign-in | `worker/lib/email-auth.ts`, `account-mailer.ts`, `account-store.ts` | A random, single-use email link verifies the address. Website sign-in returns an HttpOnly, Secure, SameSite=Lax host cookie. Desktop sign-in also requires a one-time poll token and S256 PKCE verifier, so an intercepted email link cannot create a desktop session. Attempts expire after ten minutes. Responses do not reveal whether an account exists. Only token hashes are stored. |
| Optional GitHub OAuth | `worker/lib/auth-routes.ts`, `github-oauth.ts`, `account-store.ts` | System-browser OAuth with state and S256 PKCE. A wrong verifier cannot consume the one-use challenge. Only a primary verified GitHub email creates an account; identity authority is GitHub's stable numeric subject, never email matching. This is an optional alternative provider-bound path and never auto-links an existing passwordless account by matching email. It is not a production prerequisite. |
| Session and account lifecycle | `worker/lib/auth.ts`, `email-auth.ts`, `account-store.ts` | Random 30-day sessions are stored only as SHA-256 hashes and are revocable. Refresh atomically rotates a desktop token and revokes the old token. Logout revokes the current session. Account deletion needs a fresh email proof, refuses active billing or a pending Checkout, redacts the address, revokes every session, and prevents delayed webhooks from restoring access. |
| Activation gate | `worker/lib/router.ts`, `account-store.ts` | A newly verified account must explicitly activate Free or receive an active/trialing paid subscription webhook before entitlement and usage routes unlock. Checkout success alone never unlocks a paid tier. |
| Website account flow | `apps/website/src/pages/account.astro` | Uses the API's secure host cookie, never browser token storage. Shows plan and usage, activates Free, opens Stripe-hosted Checkout/Portal, signs out, and starts verified account deletion. The private page is `noindex`. |
| Desktop account flow | `crates/entitlements` + native account IPC | Desktop tokens remain in the OS credential store. The native layer fetches `/v1/entitlement` and `/v1/kalvoice/usage`, verifies and caches signed documents, calls `effective_entitlement` / `kalvoice_decision`, and exposes only non-secret account state to the WebView. |
| Stripe price catalog | `worker/lib/billing-plans.ts` | Fail-closed mapping between six configured Stripe Price ids (monthly and yearly for each of Pro/MAX/MAX 2X) and their tier and interval. Every id maps back to its tier, so a yearly subscription grants exactly what the monthly one does. Any missing, malformed or duplicate id (including a monthly id reused as yearly) disables resolution. Free and OWNER have no price. |
| Stripe checkout and portal | `worker/lib/billing-routes.ts`, `stripe.ts` | `POST /v1/billing/checkout` takes `{ tier, requestId, interval? }`. Authenticated callers select only Pro/MAX/MAX 2X; `interval` is optional and must be exactly `"month"` or `"year"` (absent = `"month"`), anything else is a 400 before any billing effect. Customer, Price (chosen from the catalog by tier and interval), quantity and fixed return URLs are server-owned. The interval is part of the reservation's request hash (monthly keeps its original hash), so a live checkout reserved for one interval is never reused for the other: a request for the other interval gets `409 checkout_in_progress` until the reservation expires. A stable D1 idempotency key prevents duplicate customers after retries. After Stripe creates a session, a D1 compare-and-set binds its id to the exact still-authorized intent; if the account became subscribed, OWNER, deleted or otherwise lost the fence, the API expires the remote session and returns no URL. Replacing an expired reservation clears every prior session handle before reuse. An OWNER grant is refused while a finalized, unexpired public Checkout is still usable. Portal and Checkout use Stripe-hosted pages; Free and OWNER cannot be purchased. |
| Stripe webhook | `worker/lib/billing-routes.ts`, `billing-store.ts` | Reads the untouched bounded request body, verifies Stripe's timestamped HMAC, deduplicates event ids, and retrieves the current subscription because event delivery is unordered. Exactly one known Price at quantity one is required. D1 applies the current snapshot only under an unexpired versioned fencing lease; active/trialing grants are inserted or renewed with `expires_at` = Stripe's current period end plus a 72-hour renewal grace (`BILLING_GRANT_RENEWAL_GRACE_MS`), so a renewal webhook that lands after period end never drops a paying account to Free; every other status (canceled, past_due, unpaid, …) revokes immediately. Before subscription activation removes a finalized Checkout intent, its session id is committed to a durable invalidation outbox. The event stays unfinished until Stripe reports that session terminal and the outbox row is atomically completed, so crashes and ambiguous responses retry cleanup. A stale worker cannot overwrite a newer snapshot. |
| Deployment | `apps/api/wrangler.jsonc` | `wrangler d1 create kalcode-api` (real `database_id`), `wrangler d1 migrations apply kalcode-api --remote`, signing key (§6), public key into `keys.rs`, route (e.g. `api.kalcoded.com`), deploy. |
| Account deletion | `worker/lib/email-auth.ts`, `account-store.ts` | A fresh one-time email proof authorizes soft deletion. Immutable grants and audit history remain for integrity, while the email is replaced with a non-identifying tombstone and all sessions are revoked. |

Migration `0005_accounts_billing.sql` marks accounts that existed before the plan-choice gate as
activated at their original creation time, preserving upgrade access. Accounts created after the
migration begin unactivated. A trusted OWNER grant atomically activates its account.

### External setup still required before LIVE

Code presence is **IMPLEMENTED**, not CONFIGURED or LIVE. Production remains fail-closed until the
owner provisions the following through the providers' supported dashboards/secret commands:

1. The API's `ACCOUNT_MAILER` service binding targets the website Worker's internal named
   `AccountMailEntrypoint`. It reuses the website's existing domain-restricted Resend secret and
   verified sender, and has no public HTTP route. The website D1 store enforces one durable claim
   per proof plus the shared daily email budget; ambiguous provider outcomes are not replayed or
   refunded.
   The verified sender is `KalCode <hello@kalcoded.com>` and account links always use
   `https://kalcoded.com/account`, independent of request headers.
2. A random Worker secret `AUTH_RATE_LIMIT_KEY` (at least 32 characters). It HMACs client network
   buckets; never put it in source or chat.
3. Stripe recurring USD Prices for Pro, MAX and MAX 2X, monthly and yearly. Their ids are the
   Worker vars (`apps/api/wrangler.jsonc`):

   | Var | Plan | Interval | Amount |
   | --- | --- | --- | --- |
   | `STRIPE_PRICE_PRO` | Pro | month | $10 |
   | `STRIPE_PRICE_MAX` | MAX | month | $25 |
   | `STRIPE_PRICE_MAX_2X` | MAX 2X | month | $50 |
   | `STRIPE_PRICE_PRO_YEARLY` | Pro | year | $100 |
   | `STRIPE_PRICE_MAX_YEARLY` | MAX | year | $250 |
   | `STRIPE_PRICE_MAX_2X_YEARLY` | MAX 2X | year | $500 |

   All six are required. A missing, malformed or duplicate value disables billing entirely.
4. Worker secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, plus a Stripe webhook endpoint
   at `https://api.kalcoded.com/v1/billing/webhook` for
   `customer.subscription.created`, `.updated`, and `.deleted`. Configure the Stripe customer
     portal in the same account.
5. The production D1 binding and `api.kalcoded.com` Worker route, remote migration application,
   entitlement signing secret/key pinning, deploy, and live passwordless sign-in,
   Checkout/Portal/webhook probes.
6. Desktop OS-secure session-token custody, bounded PKCE polling, cancellation/timeout UI and
   signed entitlement refresh. The server never returns a bearer token to the website account
   page.

An optional GitHub OAuth App may be configured later with callback URL exactly
`https://api.kalcoded.com/v1/auth/github/callback`, `GITHUB_OAUTH_CLIENT_ID`, and the Worker secret
`GITHUB_OAUTH_CLIENT_SECRET`. Passwordless email remains the primary sign-in path.

Do not enable purchase links until all six items and the clean-install/upgrade release gates pass.

New checkout is independently held closed by the API's `CHECKOUT_ENABLED` variable:
only the exact string `true` opens it. Its committed production default is `false`.
The website build uses the same strict rule for `PUBLIC_CHECKOUT_ENABLED`, defaulting
to disabled paid-plan buttons. Existing-customer portal access and signed webhook
processing remain available during a checkout hold. After release certification,
enable both flags in one verified deployment increment; rollback closes checkout
without interrupting existing subscription reconciliation.

The API accepts live restricted server keys as well as live standard secret keys;
publishable and sandbox keys are rejected. Restricted keys still require the
permissions used by the fixed Stripe client (customers, Checkout sessions,
billing portal sessions, and subscription reads). Key shape and secret presence
are configuration checks, not proof of authentication or sufficient permissions.

## 10. Threat model

| Threat | Control |
| --- | --- |
| A user edits the desktop app, its cache or its WebView to claim OWNER/Pro | The desktop only honours documents signed by a key compiled into the binary; anything else is Free. The WebView never decides entitlements. |
| A user forges or edits a signed document | Ed25519 `verify_strict` over the exact bytes; header and payload are both signed; vectors include tampered payloads and flipped signature bits. |
| A document is copied to another machine or account | `effective_entitlement` requires the document's `accountId` to equal the signed-in account; documents expire within 7 days. |
| An old document is replayed after revocation | Documents expire (≤ 7 days as issued, ≤ 14 days accepted); revocation is effective server-side immediately. |
| An API client asks for a higher tier | Checkout accepts only a public plan id and an optional `month`/`year` interval and resolves both through the server Price catalog; a client-supplied Price is rejected. Entitlement resolution never accepts a client tier, Price, customer or account id. |
| Login CSRF, intercepted link/callback or replay | Website sessions are set only by the fixed API origin in HttpOnly, Secure, SameSite=Lax cookies. Desktop email sign-in requires both the email proof and S256 PKCE verifier; the verifier is checked before atomic consume. Optional GitHub OAuth also uses 256-bit state and S256 PKCE. All attempts expire after ten minutes. |
| Account enumeration or email-link theft | Start and delete-start responses are neutral. Tokens are high entropy, stored only as SHA-256 hashes, single-use and short-lived. The email proof stays in a URL fragment, so website/CDN request logs never receive it. A desktop link alone cannot complete without its native-only PKCE verifier. |
| Account takeover by email reuse | Passwordless identity is created only after control of the mailbox is proven. Optional GitHub identities bind to a stable numeric subject, and matching email alone never links a second GitHub subject. Deleted accounts cannot authenticate or be silently restored. |
| Forged, duplicated or unordered billing callbacks | Raw-body Stripe signature verification with a five-minute tolerance, event-id idempotency, current-subscription retrieval, exact Price/quantity validation and a versioned D1 fencing lease. |
| Someone knows the owner's email address | Email is never an authority: no code compares emails; OWNER is a database grant tied to an account id created by verified sign-in. |
| A billing bug or a malicious webhook grants OWNER | `CHECK (tier <> 'owner' OR source = 'grant')` in the database, plus resolution ignores non-operator OWNER rows. |
| Silent entitlement changes | Triggers write `audit_log` in the same statement; grants cannot be edited or deleted; `audit_log` is append-only. |
| Signing key theft | Secret only in the Worker; not logged; rotation procedure (§6); desktop pins keys by `kid`. |
| Algorithm confusion (`alg: none`, HMAC) | Only `EdDSA` with the expected `typ` is accepted; keys are Ed25519 only. |
| Usage double counting / racing past the allowance | `UNIQUE (account_id, client_request_id)`; the allowance check and insert are one statement. |
| Usage data exposure | The ledger stores ids and timestamps only; no request text, transcripts or audio. |
| Company AI cost | The API's only outbound internet clients are optional GitHub identity and Stripe billing on fixed official HTTPS hosts. Account email uses the internal website Worker service binding, whose canonical Resend adapter is fixed to Resend's official HTTPS endpoint. Zero-cost guards continue to ban every AI and speech provider host, key and SDK. |

## 11. How the owner receives OWNER

Once Z13 has shipped sign-in and deployed the API (§9):

1. The owner signs in to KalCode with their email; sign-in verifies the address and creates their
   `accounts` row. (No account exists before this, so there is nothing to grant.)
2. From the repository, logged in to Cloudflare with their own credentials (`wrangler login`),
   the owner runs a dry run and reads the account it found:
   `node tooling/admin/grant-owner.mjs --email <their email> --reason "KalCode owner" --remote`
3. They run the same command with `--confirm`. The database records the OWNER grant and its audit
   row in one statement.
4. The next time the desktop app fetches `/v1/entitlement` (sign-in, app start, or within 7 days),
   it receives a signed document with `tier: "owner", unrestricted: true` and unlocks everything,
   including features added in later releases; KalVoice Requests are unlimited.
5. To remove it: `node tooling/admin/revoke-owner.mjs --email <email> --reason "<why>" --remote --confirm`.

## 12. Tests

| Area | Where |
| --- | --- |
| Evaluator, OWNER unrestricted by construction, never in `PLANS` | `packages/protocol/src/entitlements.test.ts`, `plans.test.ts` |
| Resolution precedence, document building | `apps/api/tests/unit/entitlement.test.ts` |
| WebCrypto Ed25519 sign/verify, tampering, headers, time | `apps/api/tests/unit/token.test.ts` |
| Route table (no tier-changing endpoint), 401 in production, KalVoice metering | `apps/api/tests/unit/router.test.ts` |
| Cycle arithmetic | `apps/api/tests/unit/period.test.ts` |
| Worker writes only the ledger; no hardcoded emails; zero AI cost | `apps/api/tests/unit/source-invariants.test.ts` |
| Database constraints and triggers (real local D1) | `apps/api/tests/integration/d1-schema.test.ts`, `d1-usage.test.ts` |
| Operator tools against local D1, audit rows | `apps/api/tests/integration/admin-tools.test.ts` |
| Real Workers runtime (`wrangler dev`): signing in workerd, 401, ledger | `apps/api/tests/integration/worker.test.ts` |
| Cross-language vectors (signed in TS, verified in Rust) + RFC 8032 known answers | `apps/api/tests/unit/vectors.test.ts`, `crates/entitlements/tests/vectors.rs` |
| Rust verifier, offline grace, account binding, KalVoice decisions | `crates/entitlements` (`cargo test -p kalcode-entitlements`) |

Regenerate the vectors after an intentional format or plan change:
`UPDATE_VECTORS=1 pnpm --filter @kalcode/api exec vitest run tests/unit/vectors.test.ts`, then
`pnpm exec biome format --write crates/entitlements/testdata` and the Rust tests. Each regeneration
uses fresh throwaway keys, so the whole file changes.

## 13. KalCode games (KAL University)

Owner direction "KAL University, Update 3" (2026-10-08): the game is **$9.99 USD on its own** (this
supersedes the earlier $5 proposal) or **included with Pro, MAX and MAX 2X**, and ownership lives in
the KalCode account. The owner approved the entitlement policy (KalGame `docs/ENTITLEMENTS.md`
E1-E13) on 2026-10-08. Status: **game billing is OFF in production** (`GAME_STRIPE_MODE` unset,
`GAME_CHECKOUT_ENABLED` `"false"`): no live Stripe objects exist and nothing is sold until the owner
publishes the game's terms and refund wording and gives the launch go-ahead. Test mode runs only
against a Stripe sandbox. KalCode prices are unchanged.

**One catalog.** `packages/protocol/src/games.ts` defines the game (`kal_university`, `standalonePriceCents: 999`,
`includedWithPlans`), the perk tiers (standalone < Pro < MAX < MAX 2X), the perk items, and the
signed license format. The website renders it, the API signs claimed perks into the license, and the
game applies exactly what the license lists.

**Ownership policy** (`worker/lib/game-routes.ts`, `game-store.ts`, migration `0012_game_entitlements.sql`):

| Event | Effect |
| --- | --- |
| Paid standalone Checkout (`mode=payment`, the game Price, quantity 1, USD, server-set account metadata) | Records the payment; grants lifetime ownership (`source standalone`). Non-US billing address with `GAME_US_ONLY` → full refund, nothing granted. |
| First `invoice.paid` with `amount_paid > 0`, a subscription invoice, a line on one of the six plan Prices, paid by a PaymentIntent, customer mapped to a live account | Records the payment; grants lifetime ownership (`source pro/max/max2x`). Trials and 100%-off invoices never qualify. |
| Cancel, downgrade, unpaid renewal | Nothing. Ownership is for life. |
| Full refund within `GAME_REFUND_REVOKE_DAYS` (default 30) | Payment → `refunded`; ownership revoked if no counting payment remains. |
| Full refund after the window | Payment → `refunded_late` (still counts). Partial refunds change nothing. |
| Refund marked `fraudulent`, or dispute closed `lost` | Payment → `fraud` / `dispute_lost` at any time; revoked if nothing else counts. |
| A later counting payment | Restores ownership. |
| OWNER operator account | Owns the game with MAX 2X perks while the grant is active (never stored as a payment). |

Payment status only moves to a stronger state and is always read fresh from Stripe (charges with
refunds, disputes), so events in any order converge. D1 triggers refuse ownership without a counting
payment, refuse revocation while one remains, refuse deletes, keep perk claims insert-only, and write
`audit_log` for every grant, revocation and restoration.

**Perks.** Claimed per account and item, once, whenever a license is issued or the Game Library is
viewed, for every tier at or below the account's current plan. Claims persist after cancellation; an
upgrade claims only the higher tiers' items; resubscribing claims nothing new. The license's perk
tier is the higher of the current plan and the highest claimed tier.

**Device sign-in and license.**

| Route | Who | Purpose |
| --- | --- | --- |
| `POST /v1/games/device/start` | the game (no `Origin`) | `{gameId, device?}` → device code (secret, hashed in D1), 8-letter user code, `https://kalcoded.com/games/activate`, 10-minute expiry, 5 s interval |
| `POST /v1/games/device/approve` | website session (`kalcoded.com` only) | binds the code to the owning account; 403 `not_owned` otherwise |
| `POST /v1/games/device/token` | the game | `authorization_pending` / `slow_down` / `expired_token` / `invalid_grant`, or once: the signed license + a refresh token (`kgr_…`, hashed, 180-day sliding) |
| `POST /v1/games/license/refresh` | the game (`Bearer kgr_…`) | a fresh license; 403 `not_owned` after a revocation; 401 after sign-out or account deletion |
| `POST /v1/games/license/sign-out` | the game | ends that install's session |
| `GET /v1/games/license/keys` | anyone | published game-license public keys |
| `GET /v1/games/library` | website session | ownership, perks (claimed), checkout state, download availability |
| `POST /v1/games/checkout` | website session | Stripe-hosted Checkout for the $9.99 purchase (409 if already owned; 503 while `GAME_CHECKOUT_ENABLED` is not `true`) |
| `POST /v1/games/downloads` | website session | a 10-minute signed link for an owner (20 per day) |
| `GET /v1/games/download?t=…` | the link holder | streams the build from R2 `GAME_BUILDS` with Range support |
| `POST /v1/games/webhook` | Stripe | its own endpoint and signing secret; events `invoice.paid`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.closed` |

The license is a compact JWS (`EdDSA`, `typ kalcode-game-license.v1`) signed with its **own** key
`GAME_LICENSE_SIGNING_KEY`, valid 30 days; the game refreshes it silently once it is a day old.
Payload: `version, gameId, subject` (SHA-256 of a domain-separated account id, never the id or
email), `source, perkTier, perks[{id,kind,ref,amountCents}], device` (optional install binding),
`issuedAt, expiresAt, keyId`. The game embeds the public key and verifies offline (KalGame
`Scripts/Runtime/Licensing`); `apps/api/tests/fixtures/game-license-vectors.json` pins both verifiers.

**Configuration** (`wrangler.jsonc` vars, Worker secrets):

| Name | Kind | Value |
| --- | --- | --- |
| `GAME_STRIPE_MODE` | var | unset (off) → `live` at launch (`test` only for a sandbox deployment) |
| `GAME_STRIPE_PRICE_KAL_UNIVERSITY` | var | the one-time $9.99 USD Price (999 cents; a completed session whose subtotal differs from the catalog grants nothing) |
| `GAME_CHECKOUT_ENABLED` | var | `"false"` until launch |
| `GAME_REFUND_REVOKE_DAYS`, `GAME_US_ONLY` | var | `"30"`, `"true"` (owner decisions E3, E6) |
| `GAME_TEST_PLAN_PRICES` | var | test mode only: sandbox Price → tier JSON |
| `GAME_LICENSE_SIGNING_KEY` | secret | `node tooling/admin/gen-game-license-key.mjs --kid g2026-10 \| pnpm --filter @kalcode/api exec wrangler secret put GAME_LICENSE_SIGNING_KEY` (prints only the public key and the Unity pin line) |
| `GAME_STRIPE_SECRET_KEY` | secret | restricted live key: Checkout Sessions write, Refunds write, Invoices read, Charges read, Disputes read |
| `GAME_STRIPE_WEBHOOK_SECRET` | secret | signing secret of the `/v1/games/webhook` endpoint |
| `GAME_DOWNLOAD_SIGNING_SECRET` | secret | 32+ random bytes |
| `GAME_BUILDS` | R2 binding | `campus-founder-builds`, with `kal_university/manifest.json` naming the current build per platform (`key, version, fileName, size, sha256`) |

Tests: `packages/protocol/src/games.test.ts`, `apps/api/tests/unit/game-license.test.ts`,
`apps/api/tests/integration/d1-games.test.ts` (real local D1: grants, trials, annual, refunds in and
out of the window, fraud, disputes, out-of-order events, idempotency, triggers, standalone + US-only,
perk claims, OWNER, device flow, license refresh/sign-out, signed downloads with ranges).

**Before game billing is switched on** (independent review, 2026-10-08; none affects the
off-by-default production deploy):

- **Backfill.** Subscription invoices paid before the game webhook exists are not recorded. Add an
  admin task that lists paid invoices (not events, which Stripe keeps only 30 days) and runs each
  through `recordInvoice` (decision E1).
- **Failed refunds.** `charge.refunded` fires when a refund is created; a refund that later fails
  leaves the payment `refunded`. Let a payment return to `paid` when Stripe shows the charge is no
  longer refunded, and subscribe to `charge.refund.updated`.
- **Transient webhook outcomes.** `unknown_customer` / `account_unavailable` are recorded as handled,
  so Stripe's retries are ignored. Do not record transient outcomes.
- **Duplicate purchase.** "Already owned" is checked when the Checkout Session is created, not when
  it completes; decide whether a second payment is refunded automatically.
- **Owner policy questions.** Whether a $0 trialing subscription earns perk claims (today any active
  billing grant does), and whether a *partial* refund marked `fraudulent` removes the payment (today
  only a full one does).
- **License subject.** An unkeyed SHA-256 of the account id; use an HMAC if unlinkability matters.
- **Restricted key permissions.** `GAME_STRIPE_SECRET_KEY` needs read access to Invoices (with
  `expand[]=payments`), Checkout Sessions, Charges (with refunds) and **Disputes**, and write access
  to Checkout Sessions and Refunds. A key without Disputes read makes every payment webhook fail
  with 500 (Stripe retries), as the unclaimed sandbox key showed.

**Sandbox test-mode run (2026-10-08, local API + `stripe listen` against the `kal-university-test`
sandbox, real Stripe payloads):** a $9.99 one-time sandbox Price; `POST /v1/games/checkout` created
a real Checkout Session, paid with the 4242 test card and a US address, and
`checkout.session.completed` recorded standalone ownership (`standalonePriceCents` 999); a second
checkout answered `already_owned`. A sandbox Pro subscription's `invoice.paid` recorded `pro`
ownership; a full refund 30 seconds later revoked it (`refund`); a new paid subscription invoice
restored it. The unclaimed sandbox key cannot read `/v1/disputes`, so that run used a local-only,
uncommitted stub for the dispute list; everything else ran unmodified.

Comped (operator) grants and the OWNER account add their tier's perks to the license only while the
grant is active and never store a claim; only a paid billing grant claims perks permanently (E7).
`/v1/games/license/refresh` is rate-limited per network before any per-token row is written, and a
`GAME_LICENSE_SIGNING_KEY` identical to `ENTITLEMENT_SIGNING_KEY` is refused.
