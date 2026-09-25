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

## Pages and design system (redesign, 2026-09-24)

| Route | What it is |
| --- | --- |
| `/` | Hero (animated KalCode symbol, "KalCode", the positioning line, one supporting line, data-driven call to action) → provider bar with honest adapter status → product sections composed from `src/components/stage/*` → local-first facts → plan strip → closing section with the early-access form. |
| `/product` | Reference: the app window preview, then providers, threads, permissions, KalVoice, local-first, and a "what is built today" table. |
| `/kalvoice` | Dictation and command mode, the KalVoice demo, KalVoice Requests per plan, privacy. |
| `/pricing` | One comparison table built from `@kalcode/protocol/plans` (never hardcoded), an "every plan includes" line, FAQ accordion. |
| `/download` | Build status per OS from the release manifest, the early-access form, what to expect. |
| `/docs/*`, `/changelog`, `/security`, `/privacy`, `/terms` | Content pages; docs carry a one-line "Describes the design" chip. |

Rules the pages follow:

- **Truth labels are part of the design.** Every product preview carries "Product preview · sample
  data" (or its TRUTH status) as a chip; planned surfaces are labelled Planned where shown alone.
- **Downloads are data-driven.** `src/data/releases.json` (written by the release tooling; types in
  `src/data/releases.d.ts`) is read only through `src/lib/releases.ts`. With `latest: null` no page
  shows a download link: the primary call to action is "Join early access" and `/download` lists
  each OS with the manifest's reason. With a published Windows build, the call to action becomes
  "Download for Windows" and `/download` shows version, size, SHA-256 and the SmartScreen note for
  unsigned previews. A malformed manifest fails the build.
- **One early-access form per page**, only on `/` (closing section) and `/download`; other pages
  link to `/download#early-access`.
- **Type:** Lexend Exa 600 for display, Lexend Deca for text, JetBrains Mono only for technical
  labels and truth chips. Content column 80 rem, product stage 105 rem; the root font size steps up
  at 1800 px and 2200 px so ultrawide screens get larger type rather than empty margins.
- **Themes:** light and dark are both complete. The home header and hero form a night band in
  both themes (the hero orb is glow art); everything below follows the theme. The theme toggle
  lives in the footer.
- **Structured data:** home carries JSON-LD (Organization, WebSite, SoftwareApplication with offers
  from the plan catalog, `sameAs` from `SOCIAL`). It is a non-executing data block, so the CSP
  needs no change; the unit test for inline scripts ignores it.
- **Composition slots:** `StageSlot` renders `src/components/stage/<Name>.astro` when it exists and
  a quiet window frame otherwise; `HeroOrbSlot` renders `src/components/hero/HeroOrb.astro` or the
  static globe.

## Round 3: the cinematic world (2026-09-24)

- **World pages** (`/`, `/product`, `/kalvoice`, `/pricing`, `/download`, 404) are always dark:
  `Base world` sets `data-theme="dark"` on `<body>`. Reading pages (docs, changelog, legal) follow
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

Parallel runs in one checkout: `KALCODE_E2E_PORT`, `KALCODE_E2E_PERSIST` (D1 state folder),
`KALCODE_E2E_OUT_DIR` (build folder served with `wrangler dev --assets`),
`KALCODE_E2E_INSPECTOR_PORT` and `KALCODE_E2E_SKIP_BUILD=1` (serve an existing build). Unit tests
that inspect built HTML read `KALCODE_DIST` (default `dist`).

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
