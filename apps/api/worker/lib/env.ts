/** Production wiring: bindings and secrets → handler dependencies. */

import {
  type AccountMailServiceBinding,
  isAccountMailServiceBinding,
  serviceBoundAccountMailer,
} from "./account-mailer";
import { d1AccountStore } from "./account-store";
import { SIGN_IN_UNAVAILABLE, sessionAuthenticator } from "./auth";
import { accountAuthService } from "./auth-routes";
import { billingPriceCatalog } from "./billing-plans";
import { billingService } from "./billing-routes";
import { d1BillingStore } from "./billing-store";
import { emailAuthService } from "./email-auth";
import { importSigningKey, parsePreviousPublicKeys } from "./keys";
import { openIdAuthService } from "./openid-auth-routes";
import type { OpenIdClientConfig } from "./openid-connect";
import type { Deps } from "./router";
import { d1Store } from "./store";
import { stripeClient } from "./stripe";
import type { EntitlementSigningKey } from "./token";

export interface Env {
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
  STRIPE_SECRET_KEY?: string;
  /** Exact "true" only after signed release installation/upgrade gates pass. */
  CHECKOUT_ENABLED?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_MAX?: string;
  STRIPE_PRICE_MAX_2X?: string;
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

export function depsFromEnv(env: Env): Deps {
  const now = () => new Date();
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
  return {
    store: d1Store(env.DB),
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
    signingKey: () => loadSigningKey(env.ENTITLEMENT_SIGNING_KEY),
    previousPublicKeys: () => parsePreviousPublicKeys(env.ENTITLEMENT_PREVIOUS_PUBLIC_KEYS),
    now,
    // Structured logs only. Never log tokens, keys, emails or account ids.
    // biome-ignore lint/suspicious/noConsole: console is the Workers structured-logging sink.
    log: (entry) => console.log(JSON.stringify(entry)),
  };
}
