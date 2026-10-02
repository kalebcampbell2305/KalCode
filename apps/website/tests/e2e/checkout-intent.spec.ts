import { type BillingInterval, formatInterval, formatPrice, getPlan, type PlanId } from "@kalcode/protocol/plans";
import { expect, type Page, test } from "@playwright/test";

/**
 * Pricing → CHECK OUT NOW → /account?plan=…&interval=… → sign in if needed → checkout, without
 * choosing the plan twice. The API is mocked at its fixed origin; Stripe is a stub page.
 */

const STRIPE = "https://checkout.stripe.com/c/pay/cs_test_intent";
const INTENT_KEY = "kalcode:checkout-intent";

type Account = { signedIn: boolean; activated: boolean; tier: string };

async function mockApi(page: Page, account: Account) {
  const calls = {
    checkout: [] as unknown[],
    activateFree: 0,
    paths: [] as string[],
  };
  await page.route("https://api.kalcoded.com/**", async (route) => {
    const request = route.request();
    const headers = {
      "access-control-allow-origin": request.headers().origin ?? "",
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const path = new URL(request.url()).pathname;
    calls.paths.push(`${request.method()} ${path}`);
    let status = 200;
    let body: unknown = { ok: false, error: "unexpected_test_route" };
    if (path === "/v1/auth/email/verify") {
      account.signedIn = true;
      body = { ok: true, status: "signed_in" };
    } else if (!account.signedIn) {
      status = 401;
      body = { ok: false, error: "unauthenticated" };
    } else if (path === "/v1/account") {
      body = {
        ok: true,
        account: { email: "person@example.com", activatedAt: account.activated ? "2026-09-30T00:00:00.000Z" : null },
      };
    } else if (path === "/v1/entitlement" && account.activated) {
      body = { ok: true, entitlement: { tier: account.tier } };
    } else if (path === "/v1/kalvoice/usage" && account.activated) {
      body = { ok: true, usage: { used: 3, allowance: 25, resetsAt: "2026-11-01T00:00:00.000Z" } };
    } else if (path === "/v1/account/activate-free") {
      calls.activateFree += 1;
      account.activated = true;
      account.tier = "free";
      body = { ok: true };
    } else if (path === "/v1/billing/checkout") {
      calls.checkout.push(request.postDataJSON());
      body = { ok: true, url: STRIPE };
    } else {
      status = 404;
    }
    await route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
  });
  await page.route(`${STRIPE}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Stripe test checkout</title>",
    }),
  );
  return calls;
}

const label = (plan: PlanId, interval: BillingInterval) =>
  `${getPlan(plan).name} · ${formatPrice(getPlan(plan), interval)}${formatInterval(interval)}`;

const storedIntent = (page: Page) => page.evaluate((key) => localStorage.getItem(key), INTENT_KEY);

test.describe("checkout intent", () => {
  test("signed out: names the chosen plan, keeps it for sign-in and cleans the URL", async ({ page }) => {
    const calls = await mockApi(page, { signedIn: false, activated: false, tier: "free" });
    await page.goto("/account?plan=max&interval=year");
    await expect(page.locator("[data-checkout-intent]")).toHaveText(
      `Sign in or create your account to continue to ${label("max", "year")}.`,
    );
    expect(new URL(page.url()).search).toBe("");
    expect(JSON.parse((await storedIntent(page)) ?? "{}")).toMatchObject({ plan: "max", interval: "year" });
    expect(calls.checkout).toEqual([]);
  });

  test("signed in on Free: starts checkout for the chosen plan and interval and goes to Stripe", async ({ page }) => {
    for (const [plan, interval] of [
      ["pro", "month"],
      ["max", "year"],
      ["max2x", "year"],
    ] as const) {
      const calls = await mockApi(page, { signedIn: true, activated: true, tier: "free" });
      await Promise.all([page.waitForURL(STRIPE), page.goto(`/account?plan=${plan}&interval=${interval}`)]);
      expect(calls.checkout).toEqual([{ tier: plan, interval, requestId: expect.stringMatching(/^[a-f0-9]{32}$/u) }]);
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.goto("about:blank");
    }
  });

  test("survives Google sign-in leaving the page and continues to checkout on return", async ({ page }) => {
    const state = "s".repeat(43);
    const nonce = "n".repeat(43);
    const account = { signedIn: false, activated: false, tier: "free" };
    const calls = await mockApi(page, account);
    // Layer the Google start/complete endpoints over the shared mock.
    await page.route("https://api.kalcoded.com/v1/auth/google/**", async (route) => {
      const request = route.request();
      const headers = {
        "access-control-allow-origin": request.headers().origin ?? "",
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "content-type",
      };
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers });
        return;
      }
      if (request.url().endsWith("/start")) {
        const { codeChallenge } = request.postDataJSON() as { codeChallenge: string };
        const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authorizeUrl.search = new URLSearchParams({
          client_id: "test-client.apps.googleusercontent.com",
          redirect_uri: "https://api.kalcoded.com/v1/auth/google/callback",
          response_type: "code",
          scope: "openid email",
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        }).toString();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers,
          body: JSON.stringify({
            ok: true,
            authorizeUrl: authorizeUrl.toString(),
            nonce,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          }),
        });
        return;
      }
      account.signedIn = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers,
        body: JSON.stringify({
          ok: true,
          status: "signed_in",
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      });
    });
    await page.route("https://accounts.google.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Google sign in</title>" }),
    );

    await page.goto("/account?plan=max&interval=year");
    await expect(page.locator("[data-checkout-intent]")).toContainText(label("max", "year"));
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.waitForURL("https://accounts.google.com/**");

    // The callback returns to /account with only the sign-in result; the plan comes from storage.
    await Promise.all([
      page.waitForURL(STRIPE),
      page.goto(`/account#socialProvider=google&socialCode=one-use-code&socialState=${state}`),
    ]);
    expect(calls.checkout).toEqual([
      { tier: "max", interval: "year", requestId: expect.stringMatching(/^[a-f0-9]{32}$/u) },
    ]);
  });

  test("survives an email link opened in a new tab of the same browser", async ({ context, page }) => {
    const account = { signedIn: false, activated: false, tier: "free" };
    await mockApi(page, account);
    await page.goto("/account?plan=pro&interval=year");
    await expect(page.locator("[data-checkout-intent]")).toContainText(label("pro", "year"));

    const linkTab = await context.newPage();
    const calls = await mockApi(linkTab, account);
    await Promise.all([linkTab.waitForURL(STRIPE), linkTab.goto(`/account#verify=${"t".repeat(43)}`)]);
    expect(calls.checkout).toEqual([
      { tier: "pro", interval: "year", requestId: expect.stringMatching(/^[a-f0-9]{32}$/u) },
    ]);
  });

  test("Free activates the account without any checkout", async ({ page }) => {
    const calls = await mockApi(page, { signedIn: true, activated: false, tier: "free" });
    await page.goto("/account?plan=free&interval=month");
    await expect(page.locator("[data-account-status]")).toHaveText("Free is active.");
    await expect(page.locator("[data-account-plan]")).toHaveText("FREE");
    expect(calls.activateFree).toBe(1);
    expect(calls.checkout).toEqual([]);
    expect(await storedIntent(page)).toBeNull();
  });

  test("a paid plan already active sends the visitor to Manage billing instead of checkout", async ({ page }) => {
    const calls = await mockApi(page, { signedIn: true, activated: true, tier: "pro" });
    await page.goto("/account?plan=max&interval=month");
    await expect(page.locator("[data-account-status]")).toHaveText(
      "You already have a paid plan. Use Manage billing to change your plan.",
    );
    expect(calls.checkout).toEqual([]);
    expect(await storedIntent(page)).toBeNull();
  });

  test("ignores invalid plan and interval values", async ({ page }) => {
    const calls = await mockApi(page, { signedIn: true, activated: true, tier: "free" });
    for (const query of ["plan=owner&interval=month", "plan=max&interval=week", "plan=max&plan=pro", "plan=MAX"]) {
      await page.goto(`/account?${query}`);
      await expect(page.locator("[data-account-plan]")).toHaveText("FREE");
      expect(await storedIntent(page), query).toBeNull();
    }
    expect(calls.checkout).toEqual([]);
    await expect(page.locator("[data-checkout-intent]")).toBeHidden();
  });

  test("account buttons check out with the selected interval", async ({ page }) => {
    const calls = await mockApi(page, { signedIn: true, activated: true, tier: "free" });
    await page.goto("/account");
    await page
      .getByRole("group", { name: "Billing period" })
      .getByRole("button", { name: /Yearly/ })
      .click();
    const max = page.locator('[data-checkout-tier="max"]');
    await expect(max).toHaveText(`MAX · ${formatPrice(getPlan("max"), "year")}${formatInterval("year")}`, {
      useInnerText: true,
    });
    await Promise.all([page.waitForURL(STRIPE), max.click()]);
    expect(calls.checkout).toEqual([
      { tier: "max", interval: "year", requestId: expect.stringMatching(/^[a-f0-9]{32}$/u) },
    ]);
  });

  test("shows KalVoice Requests remaining first, then used, a bar and the reset time from the API", async ({
    page,
  }) => {
    await mockApi(page, { signedIn: true, activated: true, tier: "free" });
    await page.goto("/account");
    await expect(page.locator("[data-account-usage]")).toHaveText("22 remaining");
    const resets = await page.evaluate(() =>
      new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date("2026-11-01T00:00:00.000Z")),
    );
    await expect(page.locator("[data-account-usage-detail]")).toHaveText(`3 of 25 used · Resets ${resets}`);
    await expect(page.getByRole("progressbar", { name: "KalVoice Requests used" })).toHaveAttribute(
      "aria-valuenow",
      "3",
    );
    await expect(page.locator("[data-account-upgrade-link]")).toHaveAttribute("href", "/pricing");
    await expect(page.locator("[data-account-upgrade-link]")).toBeVisible();
  });
});
