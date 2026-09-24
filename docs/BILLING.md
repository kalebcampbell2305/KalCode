# KalCode Billing, Entitlements and KalVoice Requests

Status: entitlement foundation built (branch `z13/owner-entitlement`); **local only**. Sign-in,
Stripe checkout and deployment of the API land in campaign Z13. Nothing here is deployed, and no
Cloudflare resource for the API exists yet.

This document is the reference for what an account may use, who decides it, and how that decision
reaches the desktop app. Prices and plan limits live in one place:
`packages/protocol/src/plans.ts`.

## 1. Plans and business rules

| Plan | Price | KalVoice Requests / cycle | Public |
| --- | --- | --- | --- |
| **Free** | $0 | 250 | yes |
| **Pro** | $10 / month | 2,500 | yes |
| **MAX** | $25 / month | 10,000 | yes |
| **OWNER** | $0, forever | unlimited | **no** — private, never listed, never purchasable |

Rules (owner decisions, encoded in `plans.ts` and enforced by the code below):

- **Bring your own provider.** Model inference runs on the user's own Claude Code / Codex /
  Gemini CLI account. KalCode never pays for, resells or meters provider usage.
- **Zero company AI cost.** No KalCode service calls a hosted AI or speech API, and KalCode holds
  no company AI keys. Guarded by `tooling/check-zero-cost.mjs` and
  `apps/api/tests/unit/source-invariants.test.ts` (no outbound requests from the API at all, no AI
  bindings, no AI SDKs).
- **Never paywalled, on every plan:** connecting providers, every permission mode (Plan, Approve,
  Auto, Bypass, Custom), and local KalVoice dictation (on-device, never metered).
- Plans differ by **KalVoice Requests** and KalCode features (concurrency, persistent agents,
  multi-agent workflows, automations, advanced missions) — never by safety controls.
- The user-facing unit is **KalVoice Requests**, never "tokens". Provider model tokens are not
  KalVoice Requests and are never counted anywhere.

## 2. The entitlement model

An **entitlement** is the server's answer to "what may this account use right now". It is
computed only by the API from trusted backend state and delivered to the desktop as a signed
document. The model is shared by TypeScript (`packages/protocol/src/entitlements.ts`) and Rust
(`crates/entitlements`, `kalcode_entitlements`).

```ts
type EntitlementTier = "free" | "pro" | "max" | "owner";

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
- Free/Pro/MAX grants are derived from `plans.ts` by `tierGrants(tier)`; the server puts them into
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

## 4. Server-side resolution and the API

`apps/api` (`@kalcode/api`) is a Cloudflare Worker with a D1 database (`kalcode-api`). Schema:
`apps/api/migrations/` and `docs/DATA_MODEL.md` §4.

`resolveEntitlement(accountId)`: among grants that are not revoked and not expired —
an active OWNER operator grant, else the highest active Pro/MAX grant (billing or operator),
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
Sign-in does not exist yet, so the only production authenticator, `SIGN_IN_UNAVAILABLE`, rejects
every request: in every deployed configuration these routes answer **401**. Tests use
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
  There is no production key yet: until one is generated, every document is rejected with
  `unknown_key` and the desktop runs on Free.
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
  A compromised key is handled the same way, immediately, accepting that older desktop builds
  fall back to Free until updated.

## 7. KalVoice Requests and the usage ledger

**What counts.** One top-level request to the KalVoice assistant = 1 KalVoice Request, however
many internal steps it takes ("open four Codex threads" = 1). Dictation is never counted. Provider
model tokens are never counted. The ledger stores only an opaque client request id and a
timestamp — never request text, transcripts, audio or provider output.

**Cycles.** Allowances reset every monthly cycle, counted from an anchor (UTC):

- when an active **paid subscription** (billing grant) decides the tier → the subscription's start
  (`granted_at` of that billing grant; Z13 sets it to Stripe's billing-cycle anchor);
- otherwise — **Free**, OWNER, operator Pro/MAX grants → the **account's creation time**.

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
days). The desktop shows "Used 412 of 2,500, resets …" from it.

**Offline allowance and reconciliation** (`EffectiveEntitlement::kalvoice_decision` in Rust):

1. OWNER (unrestricted) and unlimited allowances: always allowed.
2. With a verified receipt for the signed-in account: allowed while
   `receipt.used + unsynced < min(receipt.allowance, entitlement allowance)`, where `unsynced` is
   the number of requests served on this device since that receipt was issued.
3. Without a valid receipt (never synced, receipt expired, not signed in): the device's
   provisional count for its cycle is checked against the entitlement's allowance (Free's 250
   when there is no valid entitlement document).
4. Each request served offline keeps its client request id; when the device is online again it
   reports them with `mode: "offline"`. Idempotency makes replays safe to repeat; the fresh
   receipt replaces the local count.

Bound: an unmodified client can exceed its allowance only by requests it served while it could not
reach the ledger, and those are recorded and visible. KalVoice runs on the user's device with the
user's own provider, so a modified client could skip reporting entirely — metering is product
gating, not cost protection (KalCode has no AI cost to protect).

## 8. Desktop verification and offline grace

`crates/entitlements` (`kalcode_entitlements`) is the desktop's verifier. It is not wired into
the app yet (no account UI exists); Z13 integrates it.

- `Verifier::verify(token, now)`: strict base64url, `alg = EdDSA`, `typ = kalcode-entitlement.v1`,
  known `kid`, `ed25519-dalek` `verify_strict` (rejects malleable signatures and weak keys),
  document validation, then time (5-minute skew tolerance on `issuedAt`, hard stop at
  `expiresAt`). Error codes match the TypeScript verifier exactly.
- `effective_entitlement(cached, now)`: returns the verified entitlement only if the document is
  valid **and issued to the signed-in account**; otherwise Free, with the reason
  (`NoDocument`, `Rejected(error)`, `WrongAccount`). A copied document does not make another
  account OWNER.
- **Offline grace is bounded by the document:** the API issues 7-day documents (sooner for a paid
  period that ends earlier); verifiers refuse any document claiming more than 14 days. After it
  expires the device runs on Free until it can fetch a fresh document. This applies to OWNER as
  well, so a revocation reaches every device within 7 days.

## 9. What Z13 adds, and where it plugs in

| Z13 piece | Plugs into | Notes |
| --- | --- | --- |
| Sign-in (verified email / OAuth) | replace `SIGN_IN_UNAVAILABLE` in `worker/lib/env.ts` with a real `Authenticator` | Creates `accounts` rows only after the email is verified. Session credentials are bearer tokens (the API refuses browser `Origin` writes). Add per-account rate limiting. |
| Desktop account flow | `crates/entitlements` + new IPC | Fetch `/v1/entitlement` and `/v1/kalvoice/usage`, cache the tokens, call `effective_entitlement` / `kalvoice_decision`, show usage. |
| Stripe checkout | website + API | Checkout sessions for Pro/MAX only; OWNER has no price and no product. |
| Stripe webhook | new endpoint writing billing grants | Verifies the Stripe signature; inserts `source = 'billing'` Pro/MAX grants (the database rejects billing OWNER), updates `expires_at` on renewal (audited), revokes on cancellation. The only new write path to `entitlement_grants`; `source-invariants.test.ts` must be updated deliberately. |
| Deployment | `apps/api/wrangler.jsonc` | `wrangler d1 create kalcode-api` (real `database_id`), `wrangler d1 migrations apply kalcode-api --remote`, signing key (§6), public key into `keys.rs`, route (e.g. `api.kalcoded.com`), deploy. |
| Account deletion | schema | Grants and audit rows are immutable by design; deletion needs an explicit anonymization migration. |

## 10. Threat model

| Threat | Control |
| --- | --- |
| A user edits the desktop app, its cache or its WebView to claim OWNER/Pro | The desktop only honours documents signed by a key compiled into the binary; anything else is Free. The WebView never decides entitlements. |
| A user forges or edits a signed document | Ed25519 `verify_strict` over the exact bytes; header and payload are both signed; vectors include tampered payloads and flipped signature bits. |
| A document is copied to another machine or account | `effective_entitlement` requires the document's `accountId` to equal the signed-in account; documents expire within 7 days. |
| An old document is replayed after revocation | Documents expire (≤ 7 days as issued, ≤ 14 days accepted); revocation is effective server-side immediately. |
| An API client asks for a higher tier | No endpoint accepts a tier; request bodies/queries/headers never influence resolution; production answers 401 until sign-in exists. |
| Someone knows the owner's email address | Email is never an authority: no code compares emails; OWNER is a database grant tied to an account id created by verified sign-in. |
| A billing bug or a malicious webhook grants OWNER | `CHECK (tier <> 'owner' OR source = 'grant')` in the database, plus resolution ignores non-operator OWNER rows. |
| Silent entitlement changes | Triggers write `audit_log` in the same statement; grants cannot be edited or deleted; `audit_log` is append-only. |
| Signing key theft | Secret only in the Worker; not logged; rotation procedure (§6); desktop pins keys by `kid`. |
| Algorithm confusion (`alg: none`, HMAC) | Only `EdDSA` with the expected `typ` is accepted; keys are Ed25519 only. |
| Usage double counting / racing past the allowance | `UNIQUE (account_id, client_request_id)`; the allowance check and insert are one statement. |
| Usage data exposure | The ledger stores ids and timestamps only; no request text, transcripts or audio. |
| Company AI cost | The API makes no outbound calls at all; zero-cost guards in CI. |

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
