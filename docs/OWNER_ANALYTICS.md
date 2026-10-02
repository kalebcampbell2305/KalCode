# Owner analytics dashboard

A private KalCode command center for the owner: downloads, update delivery, version adoption,
platform split, recent activity, paid subscribers, MRR, ARR and cash collected.

- Page: `https://kalcoded.com/owner/analytics` (`apps/website/src/pages/owner/analytics.astro`).
  Not linked anywhere, excluded from the sitemap, `noindex` (meta and `X-Robots-Tag`), `no-store`.
  The page holds no data; it is a shell that fetches the two endpoints below.
- Data: `GET https://api.kalcoded.com/v1/insights/distribution` and `/v1/insights/revenue`
  (`apps/api/worker/lib/insights.ts`), both `?range=24h|7d|30d|90d|all&tz=<getTimezoneOffset()>`;
  revenue also takes `fresh=1` (the Refresh button) to bypass its 60-second Stripe cache.

## Access

Both endpoints are `access: "owner"` in `apps/api/worker/lib/router.ts` (`requireOwner`):

1. The caller must present a server-issued session (the website's `__Host-kalcode_session`
   cookie, or a desktop bearer token). No session → 401.
2. The tier comes only from `resolveEntitlement`: an active, unrevoked `owner` grant with source
   `grant` (operator-only; see `docs/BILLING.md` §3). Any other account → 403. Request headers,
   query parameters and bodies are never consulted for identity or tier.
3. A browser `Origin` other than `https://kalcoded.com` → 403; CORS credentials are allowed only
   for that origin.

Hiding the URL is not the control: the page is public HTML, the data is not. The route paths
avoid `owner|admin|grant` on purpose; `tests/unit/router.test.ts` forbids such paths so no
elevation endpoint can ever exist. The website Worker's `DistributionStatsEntrypoint` is an
internal named RPC entrypoint with no HTTP route, reachable only through the API's
`DISTRIBUTION_STATS` service binding.

## What is collected (distribution)

Counted server-side by the website Worker (`apps/website/worker/distribution.ts`) from requests it
already serves, after the response is chosen, through `waitUntil`:

| Event | Request | Stored |
|---|---|---|
| `download` | full GET of an installer by a browser (`Mozilla/5.0 (`, crawlers/headless excluded) | time, platform, arch, installer version |
| `update_check` | GET of `/releases/updater/stable.json` with User-Agent exactly `KalCode/<version>` | UTC day, client version |
| `update_download` | full GET of a stable updater artifact by `KalCode/<version>` | time, platform, arch, target version, client version |

Never stored: IP address, the User-Agent string, cookies, request headers, any device or
installation identifier, or location. HEAD, 304, resumed ranges and failures never count.
`distribution_daily` keeps per-day counters; `distribution_events` (the activity feed) keeps 90
days (hourly cron). The KalCode app sends no telemetry; "installs" are not measured on the device.
The install signal is **first desktop sign-in** per account, read from `account_sessions`.

Version adoption = share of stable update checks by client version over the last two UTC days. Each
running copy checks at launch and every six hours, so the share approximates running copies.

## Revenue

Source of truth: Stripe live mode, read with the API's existing live-only secret key. The key never
leaves the Worker. Nothing is estimated; if Stripe is unavailable the revenue section says so.

- **MRR** = sum over `active` subscriptions on KalCode catalog Prices (`billing-plans.ts`) of
  `unit_amount × quantity` normalized to one month (yearly ÷ 12), minus active recurring discounts
  (one-time coupons ignored). `past_due`, `trialing`, `incomplete*`, `unpaid` and `canceled` never
  count. A subscription scheduled to cancel counts until its paid period ends.
- **ARR** = MRR × 12.
- **Cash collected** = succeeded live charges minus refunds issued in the owner's calendar month.
- **Movement**: new paid subscriptions and cancellations from Stripe; upgrades/downgrades from the
  immutable billing grant history (`entitlement_grants`, one subscription, tier change).
- **Trends**: `owner_metric_snapshots` (API D1) stores one aggregate row per UTC day, written on
  each fresh revenue load and by the daily cron (`55 23 * * *`). History begins at the first
  snapshot (2026-10-02).

## Deploy

```bash
cd apps/website && wrangler d1 migrations apply kalcode-web --remote && pnpm build && wrangler deploy
cd apps/api && wrangler d1 migrations apply kalcode-api --remote && wrangler deploy
```

Deploy the website first: the API's service binding names its `DistributionStatsEntrypoint`.
