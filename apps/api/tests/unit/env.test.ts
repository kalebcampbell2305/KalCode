import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGN_IN_UNAVAILABLE } from "../../worker/lib/auth";
import { depsFromEnv, type Env } from "../../worker/lib/env";

const DB = {} as D1Database;
const ACCOUNT_MAILER = { sendAccountEmail: async () => ({ outcome: "sent" as const }) };

describe("production auth and billing configuration", () => {
  it("keeps checkout closed unless the release flag is exactly true", async () => {
    for (const CHECKOUT_ENABLED of [undefined, "false", "TRUE", "1", " true "]) {
      const billing = depsFromEnv({
        DB,
        ...(CHECKOUT_ENABLED === undefined ? {} : { CHECKOUT_ENABLED }),
        STRIPE_SECRET_KEY: "sk_live_secret",
        STRIPE_WEBHOOK_SECRET: "whsec_secret",
        STRIPE_PRICE_PRO: "price_pro",
        STRIPE_PRICE_MAX: "price_max",
        STRIPE_PRICE_MAX_2X: "price_max2x",
        STRIPE_PRICE_PRO_YEARLY: "price_pro_year",
        STRIPE_PRICE_MAX_YEARLY: "price_max_year",
        STRIPE_PRICE_MAX_2X_YEARLY: "price_max2x_year",
      }).billing;
      expect(billing).not.toBeNull();
      if (!billing) throw new Error("billing dependencies must remain available");
      const response = await billing.checkout(
        new Request("https://api.kalcoded.com/v1/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tier: "pro", requestId: "release_flag_test" }),
        }),
        "account_release_test",
      );
      expect(response.status).toBe(503);
    }
  });
  it("fails closed when OAuth secrets or rate-limit authority are incomplete", () => {
    for (const env of [
      { DB },
      { DB, GITHUB_OAUTH_CLIENT_ID: "Iv1.client" },
      { DB, GITHUB_OAUTH_CLIENT_ID: "Iv1.client", GITHUB_OAUTH_CLIENT_SECRET: "s".repeat(24) },
    ] satisfies Env[]) {
      const deps = depsFromEnv(env);
      expect(deps.accountAuth).toBeNull();
      expect(deps.auth).toBe(SIGN_IN_UNAVAILABLE);
    }
  });

  it("enables session auth only when every OAuth security binding is present", () => {
    const deps = depsFromEnv({
      DB,
      GITHUB_OAUTH_CLIENT_ID: "Iv1.client",
      GITHUB_OAUTH_CLIENT_SECRET: "s".repeat(24),
      AUTH_RATE_LIMIT_KEY: "r".repeat(32),
    });
    expect(deps.accountAuth).not.toBeNull();
    expect(deps.auth).not.toBe(SIGN_IN_UNAVAILABLE);
  });

  it("configures Google and Microsoft independently and keeps missing providers unavailable", () => {
    const google = depsFromEnv({
      DB,
      GOOGLE_OIDC_CLIENT_ID: "1234567890-kalcode.apps.googleusercontent.com",
      GOOGLE_OIDC_CLIENT_SECRET: "g".repeat(24),
      AUTH_RATE_LIMIT_KEY: "r".repeat(32),
    });
    expect(google.openIdAuth).not.toBeNull();
    expect(google.accountAuth).toBeNull();
    expect(google.auth).not.toBe(SIGN_IN_UNAVAILABLE);

    const microsoft = depsFromEnv({
      DB,
      MICROSOFT_OIDC_CLIENT_ID: "00001111-aaaa-2222-bbbb-3333cccc4444",
      MICROSOFT_OIDC_CLIENT_SECRET: "m".repeat(24),
      AUTH_RATE_LIMIT_KEY: "r".repeat(32),
    });
    expect(microsoft.openIdAuth).not.toBeNull();
    expect(microsoft.auth).not.toBe(SIGN_IN_UNAVAILABLE);

    for (const incomplete of [
      { DB, GOOGLE_OIDC_CLIENT_ID: "1234567890-kalcode.apps.googleusercontent.com" },
      {
        DB,
        GOOGLE_OIDC_CLIENT_ID: "1234567890-kalcode.apps.googleusercontent.com",
        GOOGLE_OIDC_CLIENT_SECRET: "g".repeat(24),
      },
      {
        DB,
        MICROSOFT_OIDC_CLIENT_ID: "00001111-aaaa-2222-bbbb-3333cccc4444",
        MICROSOFT_OIDC_CLIENT_SECRET: "m".repeat(24),
      },
    ] satisfies Env[]) {
      expect(depsFromEnv(incomplete).openIdAuth).toBeNull();
      expect(depsFromEnv(incomplete).auth).toBe(SIGN_IN_UNAVAILABLE);
    }
  });

  it("enables passwordless email auth only with the internal mail service and rate-limit secret", () => {
    expect(depsFromEnv({ DB, ACCOUNT_MAILER, AUTH_RATE_LIMIT_KEY: "r".repeat(32) }).emailAuth).not.toBeNull();
    expect(depsFromEnv({ DB, ACCOUNT_MAILER }).emailAuth).toBeNull();
    expect(depsFromEnv({ DB, AUTH_RATE_LIMIT_KEY: "r".repeat(32) }).emailAuth).toBeNull();
  });

  it("enables billing only with secret, webhook secret and all six unique valid monthly and yearly Prices", () => {
    const complete = {
      DB,
      STRIPE_SECRET_KEY: "sk_live_secret",
      STRIPE_WEBHOOK_SECRET: "whsec_secret",
      STRIPE_PRICE_PRO: "price_pro",
      STRIPE_PRICE_MAX: "price_max",
      STRIPE_PRICE_MAX_2X: "price_max2x",
      STRIPE_PRICE_PRO_YEARLY: "price_pro_year",
      STRIPE_PRICE_MAX_YEARLY: "price_max_year",
      STRIPE_PRICE_MAX_2X_YEARLY: "price_max2x_year",
    } satisfies Env;
    expect(depsFromEnv(complete).billing).not.toBeNull();
    expect(depsFromEnv({ ...complete, STRIPE_SECRET_KEY: "rk_live_restricted" }).billing).not.toBeNull();
    const { STRIPE_PRICE_MAX_2X: _omitted, ...missingPrice } = complete;
    expect(depsFromEnv(missingPrice).billing).toBeNull();
    const { STRIPE_PRICE_PRO_YEARLY: _omittedYearly, ...missingYearlyPrice } = complete;
    expect(depsFromEnv(missingYearlyPrice).billing).toBeNull();
    expect(depsFromEnv({ ...complete, STRIPE_PRICE_MAX_YEARLY: complete.STRIPE_PRICE_MAX }).billing).toBeNull();
    expect(depsFromEnv({ ...complete, STRIPE_PRICE_MAX: complete.STRIPE_PRICE_PRO }).billing).toBeNull();
    expect(depsFromEnv({ ...complete, STRIPE_WEBHOOK_SECRET: "bad" }).billing).toBeNull();
    expect(depsFromEnv({ ...complete, STRIPE_SECRET_KEY: "sk_test_secret" }).billing).toBeNull();
    expect(depsFromEnv({ ...complete, STRIPE_SECRET_KEY: "rk_test_restricted" }).billing).toBeNull();
    expect(depsFromEnv({ ...complete, STRIPE_SECRET_KEY: "pk_live_publishable" }).billing).toBeNull();
  });
});

describe("owner revenue insights", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A D1 stand-in with no snapshots or grants; revenue only needs empty reads and writes. */
  const emptyDb = (): D1Database => {
    const statement = {
      bind: () => statement,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: {} }),
      first: async () => null,
    };
    return { prepare: () => statement } as unknown as D1Database;
  };

  const liveEnv = (STRIPE_SECRET_KEY: string): Env => ({
    DB: emptyDb(),
    STRIPE_SECRET_KEY,
    STRIPE_PRICE_PRO: "price_pro",
    STRIPE_PRICE_MAX: "price_max",
    STRIPE_PRICE_MAX_2X: "price_max2x",
    STRIPE_PRICE_PRO_YEARLY: "price_pro_year",
    STRIPE_PRICE_MAX_YEARLY: "price_max_year",
    STRIPE_PRICE_MAX_2X_YEARLY: "price_max2x_year",
  });

  it("reuses live Stripe data across requests within a minute, per Stripe key, unless fresh=1", async () => {
    const subscriptionCalls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/v1/subscriptions")) {
        subscriptionCalls.push(new Headers(init?.headers).get("authorization") ?? "");
      }
      return Response.json({ object: "list", data: [], has_more: false });
    });
    const revenue = async (env: Env, query = "") => {
      const insights = depsFromEnv(env).insights;
      if (!insights) throw new Error("insights must be configured");
      const response = await insights.revenue(new Request(`https://api.kalcoded.com/v1/insights/revenue${query}`));
      expect(response.status).toBe(200);
    };

    // Every request builds its own dependencies, exactly as the Worker's fetch handler does.
    await revenue(liveEnv("sk_live_insights_a"));
    await revenue(liveEnv("sk_live_insights_a"), "?range=30d");
    expect(subscriptionCalls).toEqual(["Bearer sk_live_insights_a"]);

    await revenue(liveEnv("sk_live_insights_b"));
    expect(subscriptionCalls).toEqual(["Bearer sk_live_insights_a", "Bearer sk_live_insights_b"]);

    await revenue(liveEnv("sk_live_insights_b"), "?fresh=1");
    expect(subscriptionCalls).toHaveLength(3);
  });
});
