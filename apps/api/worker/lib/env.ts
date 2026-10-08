/** Production wiring: bindings and secrets → handler dependencies. */

import {
  type AccountMailServiceBinding,
  isAccountMailServiceBinding,
  serviceBoundAccountMailer,
} from "./account-mailer";
import { d1AccountStore } from "./account-store";
import { SIGN_IN_UNAVAILABLE, sessionAuthenticator } from "./auth";
import { accountAuthService } from "./auth-routes";
import { type BillableTier, billingPriceCatalog } from "./billing-plans";
import { billingService } from "./billing-routes";
import { d1BillingStore } from "./billing-store";
import { emailAuthService } from "./email-auth";
import { type GameBilling, type GameBuildsBucket, gameService } from "./game-routes";
import { d1GameStore } from "./game-store";
import {
  type DistributionStatsBinding,
  type InsightsCache,
  insightsService,
  isDistributionStatsBinding,
} from "./insights";
import { importSigningKey, parsePreviousPublicKeys } from "./keys";
import { openIdAuthService } from "./openid-auth-routes";
import type { OpenIdClientConfig } from "./openid-connect";
import { d1OwnerMetricsStore } from "./owner-metrics-store";
import type { Deps } from "./router";
import { d1Store } from "./store";
import { type GameStripeMode, gameStripeClient, gameStripeKeyMatchesMode, stripeClient } from "./stripe";
import type { EntitlementSigningKey } from "./token";

export interface Env {
  /** Exact true blocks all requests before any dependency construction during schema recovery. */
  ACCOUNT_SCHEMA_MAINTENANCE?: string;
  DB: D1Database;
  /** Worker secret: Ed25519 private JWK with `kid`. Absent → entitlement endpoint answers 503. */
  ENTITLEMENT_SIGNING_KEY?: string;
  /** JSON array of retired public keys still published during rotation. */
  ENTITLEMENT_PREVIOUS_PUBLIC_KEYS?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OIDC_CLIENT_ID?: string;
  GOOGLE_OIDC_CLIENT_SECRET?: string;
  MICROSOFT_OIDC_CLIENT_ID?: string;
  MICROSOFT_OIDC_CLIENT_SECRET?: string;
  AUTH_RATE_LIMIT_KEY?: string;
  /** Internal named RPC entrypoint on the website Worker; never a public HTTP mail route. */
  ACCOUNT_MAILER?: AccountMailServiceBinding;
  /** Internal named RPC entrypoint on the website Worker: anonymous distribution counts. */
  DISTRIBUTION_STATS?: DistributionStatsBinding;
  STRIPE_SECRET_KEY?: string;
  /** Exact "true" only after signed release installation/upgrade gates pass. */
  CHECKOUT_ENABLED?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_MAX?: string;
  STRIPE_PRICE_MAX_2X?: string;
  STRIPE_PRICE_PRO_YEARLY?: string;
  STRIPE_PRICE_MAX_YEARLY?: string;
  STRIPE_PRICE_MAX_2X_YEARLY?: string;
  // KalCode games (docs/BILLING.md §13). Unset GAME_STRIPE_MODE keeps game billing off.
  /** Worker secret: Ed25519 private JWK with `kid` for game licenses. Never the entitlement key. */
  GAME_LICENSE_SIGNING_KEY?: string;
  GAME_LICENSE_PREVIOUS_PUBLIC_KEYS?: string;
  /** "live" or "test"; the key prefix and every event's livemode must match it. */
  GAME_STRIPE_MODE?: string;
  GAME_STRIPE_SECRET_KEY?: string;
  GAME_STRIPE_WEBHOOK_SECRET?: string;
  /** Active one-time USD Price for KAL University; its amount is verified against the game catalog before checkout. */
  GAME_STRIPE_PRICE_KAL_UNIVERSITY?: string;
  /** Test mode only: JSON object of sandbox subscription Price id → "pro" | "max" | "max2x". */
  GAME_TEST_PLAN_PRICES?: string;
  /** Exact "true" opens the standalone checkout. */
  GAME_CHECKOUT_ENABLED?: string;
  /** Days after payment within which a full refund revokes ownership (default 30). */
  GAME_REFUND_REVOKE_DAYS?: string;
  /** "false" lifts the US-only rule for the standalone purchase (default on). */
  GAME_US_ONLY?: string;
  /** Worker secret: HMAC key for short-lived game download links. */
  GAME_DOWNLOAD_SIGNING_SECRET?: string;
  /** Private R2 bucket with game builds and `<game>/manifest.json`. */
  GAME_BUILDS?: GameBuildsBucket;
}

// Imported once per isolate for each distinct secret value.
let cachedSecret: string | undefined;
let cachedKey: Promise<EntitlementSigningKey> | undefined;

function loadSigningKey(secret: string | undefined): Promise<EntitlementSigningKey | null> {
  if (!secret) {
    return Promise.resolve(null);
  }
  if (secret !== cachedSecret || !cachedKey) {
    cachedSecret = secret;
    cachedKey = importSigningKey(secret);
    // A bad secret must not be cached forever: drop it so a fixed secret is picked up.
    cachedKey.catch(() => {
      if (cachedSecret === secret) {
        cachedSecret = undefined;
        cachedKey = undefined;
      }
    });
  }
  return cachedKey;
}

// The game license key is cached separately: it is a different secret with a different purpose.
let cachedGameSecret: string | undefined;
let cachedGameKey: Promise<EntitlementSigningKey> | undefined;

function loadGameSigningKey(secret: string | undefined): Promise<EntitlementSigningKey | null> {
  if (!secret) return Promise.resolve(null);
  if (secret !== cachedGameSecret || !cachedGameKey) {
    cachedGameSecret = secret;
    cachedGameKey = importSigningKey(secret);
    cachedGameKey.catch(() => {
      if (cachedGameSecret === secret) {
        cachedGameSecret = undefined;
        cachedGameKey = undefined;
      }
    });
  }
  return cachedGameKey;
}

const PRICE_ID = /^price_[A-Za-z0-9_]+$/;

/** Sandbox subscription Prices for test mode; anything malformed disables game billing. */
export function parseTestPlanPrices(value: string | undefined): Record<string, BillableTier> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const out: Record<string, BillableTier> = {};
    for (const [price, tier] of Object.entries(parsed)) {
      if (!PRICE_ID.test(price) || (tier !== "pro" && tier !== "max" && tier !== "max2x")) return null;
      out[price] = tier;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Game billing, or null unless every piece is configured consistently for one mode. */
export function gameBillingFromEnv(
  env: Env,
  catalog: ReturnType<typeof billingPriceCatalog>,
  fetcher?: typeof fetch,
): GameBilling | null {
  const mode: GameStripeMode | null =
    env.GAME_STRIPE_MODE === "live" || env.GAME_STRIPE_MODE === "test" ? env.GAME_STRIPE_MODE : null;
  if (!mode) return null;
  const key = env.GAME_STRIPE_SECRET_KEY ?? "";
  if (!gameStripeKeyMatchesMode(key, mode)) return null;
  if (!/^whsec_[A-Za-z0-9_]+$/.test(env.GAME_STRIPE_WEBHOOK_SECRET ?? "")) return null;
  const planPrices = mode === "live" ? (catalog.ok ? catalog.tierForPrice : null) : parseTestPlanPrices(env.GAME_TEST_PLAN_PRICES);
  if (!planPrices) return null;
  const standalone = env.GAME_STRIPE_PRICE_KAL_UNIVERSITY ?? "";
  if (!PRICE_ID.test(standalone) || standalone in planPrices) return null;
  const days = Number(env.GAME_REFUND_REVOKE_DAYS ?? "30");
  return {
    stripe: gameStripeClient({ secretKey: key, mode, ...(fetcher ? { fetcher } : {}) }),
    webhookSecret: env.GAME_STRIPE_WEBHOOK_SECRET as string,
    standalonePrices: { kal_university: standalone },
    planPrices,
    checkoutEnabled: env.GAME_CHECKOUT_ENABLED === "true",
    refundRevokeDays: Number.isInteger(days) && days >= 0 && days <= 365 ? days : 30,
    usOnly: env.GAME_US_ONLY !== "false",
  };
}

// Owner revenue reads page through Stripe; keep the last lists for the isolate (the service itself
// is rebuilt per request). Keyed by the Stripe key so a rotated key or account never sees old data.
let insightsCacheKey: string | undefined;
let insightsCache: InsightsCache = { data: null };

function insightsCacheFor(stripeKey: string): InsightsCache {
  if (stripeKey !== insightsCacheKey) {
    insightsCacheKey = stripeKey;
    insightsCache = { data: null };
  }
  return insightsCache;
}

export function depsFromEnv(env: Env): Deps {
  const now = () => new Date();
  // Structured logs only. Never log tokens, keys, emails, subjects or account ids.
  // biome-ignore lint/suspicious/noConsole: console is the Workers structured-logging sink.
  const log: Deps["log"] = (entry) => console.log(JSON.stringify(entry));
  const accountStore = d1AccountStore(env.DB);
  const githubReady =
    /^[A-Za-z0-9_.-]{8,100}$/.test(env.GITHUB_OAUTH_CLIENT_ID ?? "") &&
    (env.GITHUB_OAUTH_CLIENT_SECRET?.length ?? 0) >= 20 &&
    (env.AUTH_RATE_LIMIT_KEY?.length ?? 0) >= 32;
  const accountAuth = githubReady
    ? accountAuthService({
        store: accountStore,
        github: {
          clientId: env.GITHUB_OAUTH_CLIENT_ID as string,
          clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET as string,
          callbackUrl: "https://api.kalcoded.com/v1/auth/github/callback",
        },
        rateLimitKey: env.AUTH_RATE_LIMIT_KEY as string,
        now,
      })
    : null;
  const openIdClients: Partial<Record<"google" | "microsoft", OpenIdClientConfig>> = {};
  if (
    /^[A-Za-z0-9_.-]{8,220}\.apps\.googleusercontent\.com$/.test(env.GOOGLE_OIDC_CLIENT_ID ?? "") &&
    (env.GOOGLE_OIDC_CLIENT_SECRET?.length ?? 0) >= 20
  ) {
    openIdClients.google = {
      provider: "google",
      clientId: env.GOOGLE_OIDC_CLIENT_ID as string,
      clientSecret: env.GOOGLE_OIDC_CLIENT_SECRET as string,
      callbackUrl: "https://api.kalcoded.com/v1/auth/google/callback",
    };
  }
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.MICROSOFT_OIDC_CLIENT_ID ?? "") &&
    (env.MICROSOFT_OIDC_CLIENT_SECRET?.length ?? 0) >= 20
  ) {
    openIdClients.microsoft = {
      provider: "microsoft",
      clientId: env.MICROSOFT_OIDC_CLIENT_ID as string,
      clientSecret: env.MICROSOFT_OIDC_CLIENT_SECRET as string,
      callbackUrl: "https://api.kalcoded.com/v1/auth/microsoft/callback",
    };
  }
  const openIdAuth =
    (env.AUTH_RATE_LIMIT_KEY?.length ?? 0) >= 32 && Object.keys(openIdClients).length > 0
      ? openIdAuthService({
          store: accountStore,
          clients: openIdClients,
          rateLimitKey: env.AUTH_RATE_LIMIT_KEY as string,
          now,
          log,
        })
      : null;
  const emailReady = isAccountMailServiceBinding(env.ACCOUNT_MAILER) && (env.AUTH_RATE_LIMIT_KEY?.length ?? 0) >= 32;
  const emailAuth = emailReady
    ? emailAuthService({
        store: accountStore,
        mailer: serviceBoundAccountMailer(env.ACCOUNT_MAILER as AccountMailServiceBinding),
        rateLimitKey: env.AUTH_RATE_LIMIT_KEY as string,
        now,
      })
    : null;
  const prices = billingPriceCatalog(env);
  const billingReady =
    prices.ok &&
    /^(?:sk|rk)_live_[A-Za-z0-9_]+$/.test(env.STRIPE_SECRET_KEY ?? "") &&
    /^whsec_[A-Za-z0-9_]+$/.test(env.STRIPE_WEBHOOK_SECRET ?? "");
  // Owner revenue reads live Stripe with the same live-only key as billing; never test mode.
  const liveStripe = /^(?:sk|rk)_live_[A-Za-z0-9_]+$/.test(env.STRIPE_SECRET_KEY ?? "");
  const insights = insightsService({
    store: d1OwnerMetricsStore(env.DB),
    distribution: isDistributionStatsBinding(env.DISTRIBUTION_STATS) ? env.DISTRIBUTION_STATS : null,
    stripe: liveStripe && prices.ok ? stripeClient({ secretKey: env.STRIPE_SECRET_KEY as string }) : null,
    catalog: prices.ok ? prices : null,
    now,
    log,
    cache: insightsCacheFor(env.STRIPE_SECRET_KEY ?? ""),
  });
  const entitlementStore = d1Store(env.DB);
  const games = gameService({
    store: d1GameStore(env.DB),
    entitlements: entitlementStore,
    signingKey: () => loadGameSigningKey(env.GAME_LICENSE_SIGNING_KEY),
    previousPublicKeys: () => parsePreviousPublicKeys(env.GAME_LICENSE_PREVIOUS_PUBLIC_KEYS),
    billing: gameBillingFromEnv(env, prices),
    builds: env.GAME_BUILDS ?? null,
    downloadSecret: (env.GAME_DOWNLOAD_SIGNING_SECRET?.length ?? 0) >= 32 ? (env.GAME_DOWNLOAD_SIGNING_SECRET as string) : null,
    rateLimitKey: (env.AUTH_RATE_LIMIT_KEY?.length ?? 0) >= 32 ? (env.AUTH_RATE_LIMIT_KEY as string) : null,
    now,
    log,
  });
  return {
    store: entitlementStore,
    accountStore,
    accountAuth,
    openIdAuth,
    emailAuth,
    auth: accountAuth || openIdAuth || emailAuth ? sessionAuthenticator(accountStore, now) : SIGN_IN_UNAVAILABLE,
    billing: billingReady
      ? billingService({
          checkoutEnabled: env.CHECKOUT_ENABLED === "true",
          store: d1BillingStore(env.DB),
          stripe: stripeClient({ secretKey: env.STRIPE_SECRET_KEY as string }),
          catalog: prices as Extract<typeof prices, { ok: true }>,
          webhookSecret: env.STRIPE_WEBHOOK_SECRET as string,
          now,
        })
      : null,
    insights,
    games,
    signingKey: () => loadSigningKey(env.ENTITLEMENT_SIGNING_KEY),
    previousPublicKeys: () => parsePreviousPublicKeys(env.ENTITLEMENT_PREVIOUS_PUBLIC_KEYS),
    now,
    log,
  };
}
