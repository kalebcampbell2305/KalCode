# kalcoded.com

Status: built and tested in Z0 · Canonical origin: **https://kalcoded.com**

## Stack

- **Astro** static output (`apps/website/src`), no client framework; three small scripts
  (theme, mobile navigation, forms).
- **Cloudflare Worker with static assets** (`apps/website/worker`), `run_worker_first: true`,
  so every response passes through the Worker for redirects and security headers.
- **D1** database `kalcode-web` for the early-access list (`migrations/`).
- **Workers Rate Limiting** binding `EARLY_ACCESS_LIMITER` (5 requests / 60 s per IP per action).
- **Resend** (REST API, no SDK) delivers the double opt-in emails from `KalCode <hello@kalcoded.com>`,
  replies to `kalcodebuilds@gmail.com` (`EMAIL_FROM` / `EMAIL_REPLY_TO` in `src/lib/site.ts`).
- **Cron trigger** `17 * * * *` (hourly): deletes expired links and unconfirmed sign-ups.
- Custom domains `kalcoded.com` and `www.kalcoded.com` (Worker routes with `custom_domain`).

## Pages and design system (redesign, 2026-09-24)

| Route | What it is |
| --- | --- |
| `/` | Hero (the KalCode mascot on the animated energy stream, "KalCode", the positioning line, one supporting line, data-driven call to action) → provider bar with honest adapter status → product sections composed from `src/components/stage/*` → local-first facts → plan strip → closing section with the early-access form. |
| `/product` | Reference: the app window preview, then providers, threads, permissions, KalVoice, local-first, and a "what is built today" table. |
| `/kalvoice` | Dictation and command mode, the KalVoice demo, KalVoice Requests per plan, privacy. |
| `/pricing` | One comparison table built from `@kalcode/protocol/plans` (never hardcoded), an "every plan includes" line, FAQ accordion. |
| `/download` | Build status per OS from the release manifest, the early-access form, what to expect. |
| `/updates` | Product news and release communication. `/changelog` permanently redirects here, and historic release anchors remain valid. |
| `/docs/*`, `/security`, `/privacy`, `/terms` | Content pages; docs carry a one-line "Describes the design" chip. |
| `/games/kal-university` | KAL University ("Build your future."), "A KalCode Game" (see "Games" below). |

Rules the pages follow:

- **Truth labels are part of the design.** Every product preview carries "Product preview · sample
  data" (or its TRUTH status) as a chip; planned surfaces are labelled Planned where shown alone.
- **Downloads are data-driven.** `src/data/releases.json` (written by the release tooling; types in
  `src/data/releases.d.ts`) is read only through `src/lib/releases.ts`. With `latest: null` no page
  shows a download link: the primary call to action is "Join early access" and `/download` lists
  each OS with the manifest's reason. With a published Windows build, the call to action becomes
  "Download for Windows" and `/download` shows version, size, SHA-256 and the SmartScreen note for
  unsigned previews. A malformed manifest fails the build.
- **Release authority changes explicitly.** `RELEASE_CATALOG_ENABLED` defaults to `false`, so the
  existing verified preview continues to use the legacy integrity-checked R2 manifest and object
  routes while the immutable D1 catalog is empty. Only exact `true` switches all manifest, updater
  and artifact selection to D1. In that state missing pointers, descriptor mismatches and catalog
  outages fail closed; the Worker never falls back to mutable legacy pointers.
- **One early-access form per page**, only on `/` (closing section) and `/download`; other pages
  link to `/download#early-access`.
- **Type:** Lexend Exa 600 for display, Lexend Deca for text, JetBrains Mono only for technical
  labels and truth chips. Content column 80 rem, product stage 105 rem; the root font size steps up
  at 1800 px and 2200 px so ultrawide screens get larger type rather than empty margins.
- **Themes:** light and dark are both complete. The home header and hero form a night band in
  both themes (the hero mascot is glow art); everything below follows the theme. The theme toggle
  lives in the footer.
- **Structured data:** home carries JSON-LD (Organization, WebSite, SoftwareApplication with offers
  from the plan catalog, `sameAs` from `SOCIAL`). It is a non-executing data block, so the CSP
  needs no change; the unit test for inline scripts ignores it.
- **Composition slots:** `StageSlot` renders `src/components/stage/<Name>.astro` when it exists and
  a quiet window frame otherwise; `HeroOrbSlot` renders `src/components/hero/HeroOrb.astro` or the
  static mascot.

## Round 3: the cinematic world (2026-09-24)

- **World pages** (`/`, `/product`, `/kalvoice`, `/pricing`, `/download`, `/updates`, 404) are always dark:
  `Base world` sets `data-theme="dark"` on `<body>`. Reading pages (docs and legal) follow
  the visitor's theme, and only they show the theme toggle. Space imagery is never drawn on light
  surfaces (backdrops and planets are hidden in the light theme).
- **Environments:** `Backdrop.astro` renders the hero work's `SpaceBackdrop` (nebula, deep,
  orbital, gravity, horizon, planet, void, vault; derived from the owner's artwork or procedural)
  with a CSS fallback in `styles/world.css`. The home hero is `HeroWorld` (via `HeroOrbSlot`);
  the page sets `--hero-orb-max`, `--hero-orb-center-y` and the text-safe band variables.
- **Composition:** eyebrow pill → two-line headline → one or two sentences → link; product demos
  in fine blue-lit frames (`.frame`), alternating sides, with a full-width dashboard moment.
  Home sections render only when their demo exists (`lib/stage.ts`). "CODE THE FUTURE" sits
  under the KALCODE wordmark in the hero.
- **Buttons** (`site.css`): `.button--primary` is a white physical surface with a blue-to-gold
  halo outside it (halo `::before` z -2, surface and sweep `::after` z -1), lift/sweep on hover,
  compression on press, a solid focus outline, and no sweep with reduced motion.
  `.button--secondary` is a dark surface with a fine light edge. Sizes `--lg` (caps), `--sm`.
- **Nav:** sticky, transparent over the first viewport; a dark surface, blur and a light line
  once scrolled (`nav.ts` sets `data-scrolled`); lit active state; full-width mobile sheet.
- **Type roles:** display and headline in Lexend Deca 700 (`--font-display`); UI labels in Lexend
  Giga caps; product text in JetBrains Mono.
- **Download CTA:** always "Download KalCode": the installer URL when the manifest has a Windows
  build (other systems are routed to `/download` by `download-route.ts`), the honest download
  page and a "No public build yet" status otherwise.
- **Performance:** below-the-fold world sections use `content-visibility: auto`; the world plate
  and the wordmark are preloaded. Full-page screenshots must force `content-visibility: visible`
  (with CSP bypassed in the capture browser), or off-screen sections appear empty.

## Games

`/games/kal-university` presents KAL University, a separate single-player game (tagline "Build your
future."), as "A KalCode Game".
It is a world page reached from the footer's Games column; the header navigation and `/pricing`
stay KalCode-only. Rules:

- **Separate from KalCode.** No KalCode plan, account, billing, checkout or early-access form appears
  on the page; release news points to the existing X account in `SOCIAL`.
- **Truthful state.** While no game build is published, the Windows and macOS download controls are
  disabled "Coming soon" buttons, the planned standalone price is shown as a $9.99 USD one-time
  purchase with no subscription, and the story arc tags each chapter as "In the
  development build" or "Planned". Features beyond the current build (a laptop to work anywhere on
  campus, fictional AI tools and an AI company, a fictional stock market and IPO, regions inspired by
  California, Florida and New York) sit together under "Where it's headed", each tagged Planned.
- **Real captures only.** `public/assets/games/kal-university/*` are frames from the game's real
  development build (1920×1080 PNG converted with sharp to AVIF and WebP at 960 and 1920 widths),
  each captioned "In-game capture · development build" and given a descriptive alt. Never a mock-up,
  and never a frame that shows retired KalCode branding.
- **Structured data.** The page's JSON-LD adds a `VideoGame` node and names it as the page's `about`
  (no offers until the game is for sale).

## Behaviour

| Request | Response |
| --- | --- |
| `www.kalcoded.com/*` | 301 → `https://kalcoded.com/*` (path and query kept) |
| Plain HTTP at the edge (`cf-visitor` scheme `http`) | 301 → HTTPS |
| `/changelog` or `/changelog/` | 301 → `/updates` (query kept; browsers retain historic fragment anchors) |
| `POST /api/early-access` `{email, source, website}` | Stores a pending row and emails a confirmation link (a confirmed address gets an "already on the list" email instead). 200 with the same body for new, pending, confirmed, throttled and honeypot submissions; 502 `email_failed` if the email could not be sent (nothing kept); 503 `email_unavailable` when the daily email budget is spent |
| `POST /api/early-access/remove` `{email}` | Emails a removal link only if the address is on the list; 200 with the same body either way (502/503 as above) |
| `POST /api/early-access/confirm` `{token}` | 200 confirmed; 410 `invalid_link` for a used, expired or unknown link; 400 for a malformed one. GET → 405 |
| `POST /api/early-access/remove/confirm` `{token}` | 200 and the row and all its links are deleted permanently; 410/400 as above |
| `GET /early-access/confirm?token=…`, `GET /early-access/remove?token=…` | Static pages (noindex, `Referrer-Policy: no-referrer` meta) with one button that POSTs the code. Opening the page changes nothing, so link scanners and mail previews cannot confirm or remove |
| Everything else | Static asset, or the styled 404 page |

HTML responses carry `Cache-Control: … no-transform`, so the Cloudflare proxy never rewrites
pages — in particular it cannot inject the Web Analytics beacon, which is enabled at the zone
level but would contradict the site's no-analytics promise.

All responses carry: CSP with a SHA-256 hash for the single inline theme script, HSTS,
`X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and
`frame-ancestors 'none'`. Hashed `/_astro/*` assets are immutable-cached.

Privacy: the public marketing and early-access pages set no cookies and run no analytics. The
private `/account` page uses one HttpOnly, Secure, SameSite=Lax host session cookie issued by
`api.kalcoded.com`; scripts cannot read it. D1 stores the email, timestamp, source
page, consent version, confirmation status and time, per-address throttle counters and the
SHA-256 of each live link (docs/DATA_MODEL.md §3). Workers invocation logs are disabled so client
IPs and user agents are not retained by us; the Worker's own logs never contain emails or links.

## Account and billing

`/account` is a `noindex` authenticated surface backed by the separate account API at the fixed
origin `https://api.kalcoded.com`. Passwordless sign-in sends a high-entropy, single-use link to
the supplied address. Its proof stays in the URL fragment, is removed before the API call, and
never reaches website/CDN request logs. Responses are account-enumeration neutral. The website never receives or
stores a bearer token: the API sets a secure host cookie after link verification, and every
credentialed write must come from the exact production website origin.

After sign-in, the page reads server-authoritative account, entitlement and usage state. A new
account must explicitly activate Free, or wait for a verified active/trialing Stripe webhook after
Checkout, before protected entitlement and usage routes unlock. Paid buttons submit only a public
tier plus an idempotent request id; customer, Price, quantity and return URLs are server owned.
Checkout and subscription management open on Stripe-hosted pages. Account deletion requires a
fresh email proof and is refused while billing or a Checkout reservation is active. See
`docs/BILLING.md` §9–10 for contracts, external setup and the threat model.

## Early access and email (double opt-in)

Flow (`worker/lib/early-access.ts`, store in `worker/lib/store.ts`, templates in
`worker/lib/emails.ts`, transports in `worker/lib/mailer.ts`):

1. **Join.** Validate and rate-limit as before; purge expired data; insert a `pending` row (an
   existing unconfirmed row keeps its status and takes the current `CONSENT_VERSION`); reserve
   the per-address throttle (1 email per 10 min, 5 per UTC day) and one email from the site-wide
   daily budget (`EMAIL_DAILY_LIMIT`, default 90, inside Resend's free 100/day); store the hashes
   of a fresh confirmation code and removal code (72 h); send "Confirm your KalCode early-access
   email". A confirmed address gets "You're already on the KalCode early-access list" with a
   removal link instead, so the response and timing do not reveal membership. A throttled request
   sends nothing and answers the same 200.
2. **Confirm.** The link opens `/early-access/confirm?token=…`; the button POSTs the code; the
   store deletes the link (`DELETE … RETURNING`) and, if it had not expired, marks the row
   `confirmed` and deletes its other confirmation links.
3. **Remove.** The privacy page form emails "Confirm removal from the KalCode early-access list"
   only to a listed address (same 200 either way). Its link, and the removal link in every
   confirmation email, opens `/early-access/remove?token=…`; the POST deletes the row and every
   link permanently.
4. **Failure.** If the send fails (provider error, timeout after 8 s, missing key), everything the
   attempt wrote is undone (links, throttle slot, budget slot, and the row if this request created
   it), the log records the kind of email, transport, reason and HTTP status only, and the
   visitor sees "We couldn't send the email right now, so nothing was saved. Try again in a few
   minutes." Provider error text never reaches the client or the logs.
5. **Cleanup.** Every form request and the hourly cron delete expired links and `pending` rows
   older than 72 h with no live confirmation link. `legacy_unconfirmed` rows are never deleted or
   emailed automatically.

Residual, accepted: when email sending is failing (or the daily budget is spent), a removal
request for a listed address answers 502/503 while an unlisted one answers 200; an attacker
cannot cause provider failures, and the per-IP rate limit bounds probing.

### Transports (`EMAIL_TRANSPORT`)

| Value | Where | Behaviour |
| --- | --- | --- |
| `resend` | production (`wrangler.jsonc` vars) | `POST https://api.resend.com/emails` with `Authorization: Bearer $RESEND_API_KEY`, JSON `from`, `reply_to`, `to`, `subject`, `text`, `html`, an `Idempotency-Key`, 8 s timeout. Links always use `https://kalcoded.com`. |
| `capture` | Playwright | POSTs the message to `EMAIL_CAPTURE_URL`, which must be a loopback `http://` URL (the suite's mail sink, `tests/e2e/mail-sink.mjs`). |

The account API reuses this same Resend authority through the website Worker's internal named
`AccountMailEntrypoint` RPC service binding. It is not an HTTP route. The method accepts only a
validated recipient, a `signin` or `delete` purpose, and a one-time proof; it renders fixed
templates and claims a proof hash plus the shared daily D1 budget before sending. Provider
timeouts remain charged and cannot replay the proof because the provider may already have
accepted the message.
| `log` | local `pnpm preview` | Prints the message, links included, to the wrangler console (recipient redacted). |

`capture` and `log` also need `EMAIL_LINK_ORIGIN`, a loopback origin such as
`http://127.0.0.1:8787`, and refuse to send without it, so a misconfigured deployment fails
visibly instead of silently. Unknown values fail the same way. The emails have no images, no
remote resources and no tracking; open and click tracking must stay off for the kalcoded.com
domain in Resend (they are off unless a tracking subdomain is configured).

`RESEND_API_KEY` is a Worker secret (sending-only, restricted to kalcoded.com). It is never in
`wrangler.jsonc`, the repository, client bundles or logs. For local work copy
`apps/website/.dev.vars.example` to `.dev.vars` (git-ignored): it selects the `log` transport.
Only put a key in `.dev.vars` to test real delivery, and then only send to your own address or
`delivered@resend.dev`.

### Addresses that joined before double opt-in

Migration 0002 marks them `legacy_unconfirmed`. They stay on the list, are not emailed and are
not deleted until the owner decides to ask them once:

```bash
node tooling/admin/request-legacy-confirmation.mjs --remote              # dry run: counts, redacted, changes nothing (exit 2)
RESEND_API_KEY=… node tooling/admin/request-legacy-confirmation.mjs --remote --limit 20 --confirm
```

Each selected address gets "Confirm your KalCode early-access email" (the legacy wording), becomes
`pending`, and is deleted by the cleanup if not confirmed within 72 h. The tool respects the
per-address throttle and the daily budget, undoes a failed send and stops, and never prints
full addresses or the key. `--local [--persist-to <dir>] --transport log` rehearses it on a local
database.

## Commands (in `apps/website`)

```bash
pnpm dev                 # Astro dev server (UI only; API not available)
pnpm db:migrate:local    # create or update the local D1 schema (after every new migration)
cp .dev.vars.example .dev.vars   # once: emails go to the wrangler console (log transport)
pnpm build && pnpm preview   # full site on the real Worker + local D1 at :8787
pnpm typecheck && pnpm test  # astro check + worker tsc; Vitest unit tests
pnpm test:e2e            # Playwright against wrangler dev with isolated local D1
```

The E2E suite starts a mail sink on `KALCODE_E2E_MAIL_PORT` (default: E2E port + 1) and runs the
Worker with `EMAIL_TRANSPORT=capture`, so it never calls Resend.

Parallel runs in one checkout: `KALCODE_E2E_PORT`, `KALCODE_E2E_MAIL_PORT`, `KALCODE_E2E_PERSIST` (D1 state folder),
`KALCODE_E2E_OUT_DIR` (build folder served with `wrangler dev --assets`),
`KALCODE_E2E_INSPECTOR_PORT` and `KALCODE_E2E_SKIP_BUILD=1` (serve an existing build). Unit tests
that inspect built HTML read `KALCODE_DIST` (default `dist`).

## Deployment

Production: Worker `kalcode-website`, D1 `kalcode-web` (`f7b3e324-c093-4231-b768-2a4a930d2744`),
custom domains `kalcoded.com` and `www.kalcoded.com`. First deployed 2026-09-24.
Contact published on the site: `CONTACT_EMAIL` in `src/lib/site.ts`.

Keep `RELEASE_CATALOG_ENABLED=false` until signed-release publishing has uploaded and verified every
content-addressed descriptor and artifact, committed the immutable version row and initialized the
exact Stable pointer. While the flag is `false`, certify the release only through its public
version-specific immutable routes; the mutable Stable routes still use the legacy authority and are
not proof of the D1 catalog. Deploying W with the flag set to `true` is the final atomic authority
transition. After that deployment, the normal idempotent publisher from clean N must probe the
public Stable manifest, installer and updater feed through the D1 authority. Before the first
authoritative signed release, rollback may restore `false` to preserve the verified preview. After
the transition, rollback must preserve catalog authority. Never toggle the flag to `false`
automatically or in response to catalog errors, because that would silently downgrade release
authority to mutable legacy objects.

For the first cutover, B is the exact signed-artifact build commit, N is B or its clean
`docs/releases/`-only publisher descendant, and W is final main with the generated
`src/data/releases.json` plus `RELEASE_CATALOG_ENABLED=true`. Artifact and final schema-v2 QA
records remain bound to B. Before W, certify artifacts through their immutable version-specific
routes. An exact-candidate `--bootstrap-authority` retry may finish the local manifest after a
post-pointer crash or formatter failure only from a fresh clean checkout at exact N with the
complete, byte-identical ignored release directory and frozen publication. Preserve or copy any
external updater-QA receipt separately at its governed external path, and inventory both evidence
sets. Provision the same locked dependencies and preserve the failed checkout untouched; never
weaken the clean-tree gate or discard unrelated work. The joined D1 pointer/version row must match
every authority field, and resume revalidates local and remote bytes without replacing or updating
that pointer. After W is deployed, the normal publisher from clean N must independently prove the
mutable Stable download and updater routes and regenerate a manifest byte-equal to W. Keep this
pre-cutover and post-cutover evidence distinct, and preserve `RELEASE_CATALOG_ENABLED=true` with D1
authority in every post-cutover rollback.

```bash
wrangler d1 create kalcode-web                      # once; put the id in wrangler.jsonc
wrangler secret put RESEND_API_KEY                  # once; sending-only key for kalcoded.com
wrangler d1 migrations apply kalcode-web --remote   # before deploying code that needs a migration
pnpm build && wrangler deploy
```

Migrations are expand-only and applied before the deploy: 0002 adds columns with defaults and
new tables, so the previous Worker keeps working in between (its inserts become
`legacy_unconfirmed`).

Wrangler authenticates with the owner's Cloudflare login; no credentials are stored in the
repository.
