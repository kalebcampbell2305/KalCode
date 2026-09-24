# kalcoded.com

Status: built and tested in Z0 · Canonical origin: **https://kalcoded.com**

## Stack

- **Astro** static output (`apps/website/src`), no client framework; three small scripts
  (theme, mobile navigation, forms).
- **Cloudflare Worker with static assets** (`apps/website/worker`), `run_worker_first: true`,
  so every response passes through the Worker for redirects and security headers.
- **D1** database `kalcode-web` for the early-access list (`migrations/`).
- **Workers Rate Limiting** binding `EARLY_ACCESS_LIMITER` (5 requests / 60 s per IP per action).
- Custom domains `kalcoded.com` and `www.kalcoded.com` (Worker routes with `custom_domain`).

## Behaviour

| Request | Response |
| --- | --- |
| `www.kalcoded.com/*` | 301 → `https://kalcoded.com/*` (path and query kept) |
| Plain HTTP at the edge (`cf-visitor` scheme `http`) | 301 → HTTPS |
| `POST /api/early-access` `{email, source, website}` | 200 with the same body for new, duplicate and honeypot submissions |
| `POST /api/early-access/remove` `{email}` | 200 with the same body whether or not the address existed |
| Everything else | Static asset, or the styled 404 page |

HTML responses carry `Cache-Control: … no-transform`, so the Cloudflare proxy never rewrites
pages — in particular it cannot inject the Web Analytics beacon, which is enabled at the zone
level but would contradict the site's no-analytics promise.

All responses carry: CSP with a SHA-256 hash for the single inline theme script, HSTS,
`X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and
`frame-ancestors 'none'`. Hashed `/_astro/*` assets are immutable-cached.

Privacy: the site sets no cookies and runs no analytics. D1 stores email, timestamp, source page
and consent version only. Workers invocation logs are disabled so client IPs and user agents are
not retained by us; the Worker's own logs never contain emails.

## Commands (in `apps/website`)

```bash
pnpm dev                 # Astro dev server (UI only; API not available)
pnpm db:migrate:local    # once, to create the local D1 schema
pnpm build && pnpm preview   # full site on the real Worker + local D1 at :8787
pnpm typecheck && pnpm test  # astro check + worker tsc; Vitest unit tests
pnpm test:e2e            # Playwright against wrangler dev with isolated local D1
```

## Deployment

Production: Worker `kalcode-website`, D1 `kalcode-web` (`f7b3e324-c093-4231-b768-2a4a930d2744`),
custom domains `kalcoded.com` and `www.kalcoded.com`. First deployed 2026-09-24.
Contact published on the site: `CONTACT_EMAIL` in `src/lib/site.ts`.

```bash
wrangler d1 create kalcode-web                      # once; put the id in wrangler.jsonc
wrangler d1 migrations apply kalcode-web --remote
pnpm build && wrangler deploy
```

Wrangler authenticates with the owner's Cloudflare login; no credentials are stored in the
repository.
