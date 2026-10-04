import { getPlan } from "@kalcode/protocol/plans";
import { expect, type Page, test } from "@playwright/test";

type Tier = "free" | "owner" | null;

async function installAccountNetworkFence(page: Page, tier: Tier) {
  const ownedOrigin = `http://127.0.0.1:${Number(process.env.KALCODE_E2E_PORT ?? 8788)}`;
  const apiPaths = new Set(["/v1/account", "/v1/entitlement", "/v1/kalvoice/usage", "/v1/billing/checkout"]);
  const billingRequests: Array<{ method: string; path: string; origin: string }> = [];
  const mutationRequests: Array<{ method: string; path: string }> = [];
  const checkoutBodies: unknown[] = [];
  const unexpectedRequests: string[] = [];

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === ownedOrigin && (request.method() === "GET" || request.method() === "HEAD")) {
      await route.continue();
      return;
    }
    if (request.method() === "GET" && url.href === "https://checkout.stripe.com/c/pay/cs_test_kalcode") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Stripe test checkout</title>",
      });
      return;
    }
    if (url.origin !== "https://api.kalcoded.com" || url.search !== "" || !apiPaths.has(url.pathname)) {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort();
      return;
    }

    const origin = request.headers().origin ?? "";
    const headers = {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }

    if (request.method() !== "GET") {
      mutationRequests.push({ method: request.method(), path: url.pathname });
    }
    if (url.pathname.startsWith("/v1/billing/")) {
      billingRequests.push({ method: request.method(), path: url.pathname, origin });
    }
    let status = 200;
    let body: unknown;
    if (url.pathname === "/v1/account" && request.method() === "GET") {
      if (tier === null) {
        status = 401;
        body = { ok: false, error: "unauthenticated" };
      } else {
        body = {
          ok: true,
          account: { email: `${tier}@example.com`, activatedAt: "2026-09-27T00:00:00.000Z" },
        };
      }
    } else if (url.pathname === "/v1/entitlement" && request.method() === "GET" && tier !== null) {
      body = { ok: true, entitlement: { tier } };
    } else if (url.pathname === "/v1/kalvoice/usage" && request.method() === "GET" && tier !== null) {
      body = {
        ok: true,
        usage: {
          used: tier === "owner" ? 7 : 3,
          allowance: tier === "owner" ? null : 25,
          resetsAt: "2026-10-01T00:00:00.000Z",
        },
      };
    } else if (url.pathname === "/v1/billing/checkout" && request.method() === "POST" && tier === "free") {
      checkoutBodies.push(request.postDataJSON());
      body = { ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_kalcode" };
    } else {
      status = 404;
      unexpectedRequests.push(`${request.method()} ${url.pathname}`);
      body = { ok: false, error: "unexpected_test_route" };
    }
    await route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });
  });

  return { billingRequests, checkoutBodies, mutationRequests, ownedOrigin, unexpectedRequests };
}

test.describe("Checkout-enabled account release gate", () => {
  test("enables paid plan actions for an authenticated Free account without contacting Stripe", async ({ page }) => {
    const observedFetches: Array<{ url: string; credentials: RequestCredentials | undefined }> = [];
    await page.exposeFunction(
      "__recordKalcodeFetch",
      (observed: { url: string; credentials: RequestCredentials | undefined }) => {
        observedFetches.push(observed);
      },
    );
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        await (
          window as typeof window & {
            __recordKalcodeFetch: (observed: {
              url: string;
              credentials: RequestCredentials | undefined;
            }) => Promise<void>;
          }
        ).__recordKalcodeFetch({ url: String(input), credentials: init?.credentials });
        return nativeFetch(input, init);
      };
    });
    const network = await installAccountNetworkFence(page, "free");
    await page.goto("/account");

    await expect(page.locator("[data-account-plan]")).toHaveText(getPlan("free").name);
    await expect(page.locator("[data-checkout-closed]")).toHaveCount(0);
    const purchases = page.locator("[data-checkout-tier]");
    await expect(purchases).toHaveCount(3);
    expect(
      await purchases.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-checkout-tier"))),
    ).toEqual(["pro", "max", "max2x"]);
    for (const purchase of await purchases.all()) {
      await expect(purchase).toBeVisible();
      await expect(purchase).toBeEnabled();
    }
    await expect(page.locator("[data-billing-portal]")).toBeVisible();
    await expect(page.locator("[data-activate-free]")).toBeHidden();

    await Promise.all([
      page.waitForURL("https://checkout.stripe.com/c/pay/cs_test_kalcode"),
      page.locator('[data-checkout-tier="pro"]').click(),
    ]);
    expect(network.billingRequests).toEqual([
      {
        method: "POST",
        path: "/v1/billing/checkout",
        origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
      },
    ]);
    expect(network.checkoutBodies).toEqual([
      { tier: "pro", interval: "month", requestId: expect.stringMatching(/^[a-f0-9]{32}$/u) },
    ]);
    expect(network.mutationRequests).toEqual([{ method: "POST", path: "/v1/billing/checkout" }]);
    const observedCheckout = observedFetches.find(({ url }) => url.endsWith("/v1/billing/checkout"));
    expect(observedCheckout).toEqual({
      url: "https://api.kalcoded.com/v1/billing/checkout",
      credentials: "include",
    });
    expect(network.unexpectedRequests).toEqual([]);
  });

  test("keeps OWNER nonbillable and hides every payment action", async ({ page }) => {
    const network = await installAccountNetworkFence(page, "owner");
    await page.goto("/account");

    await expect(page.locator("[data-account-plan]")).toHaveText("OWNER");
    await expect(page.locator("[data-owner-access]")).toContainText("No subscription payment is required");
    await expect(page.locator("[data-owner-access]")).toBeVisible();
    await expect(page.locator("[data-billing-portal]")).toBeHidden();
    await expect(page.locator("[data-account-upgrades]")).toBeHidden();
    await expect(page.locator("[data-activate-free]")).toBeHidden();
    await expect(page.locator("[data-checkout-closed]")).toHaveCount(0);
    expect(network.billingRequests).toEqual([]);
    expect(network.checkoutBodies).toEqual([]);
    expect(network.mutationRequests).toEqual([]);
    expect(network.unexpectedRequests).toEqual([]);
  });

  test("keeps payment actions inaccessible when the account is unauthenticated", async ({ page }) => {
    const network = await installAccountNetworkFence(page, null);
    await page.goto("/account");

    await expect(page.locator("[data-account-access]")).toBeVisible();
    await expect(page.locator("[data-account-summary]")).toBeHidden();
    await expect(page.locator("[data-account-upgrades]")).toBeHidden();
    await expect(page.locator("[data-billing-portal]")).toBeHidden();
    await expect(page.locator("[data-activate-free]")).toBeHidden();
    await expect(page.locator("[data-checkout-tier]")).toHaveCount(3);
    for (const purchase of await page.locator("[data-checkout-tier]").all()) {
      await expect(purchase).toBeHidden();
    }
    expect(network.billingRequests).toEqual([]);
    expect(network.checkoutBodies).toEqual([]);
    expect(network.mutationRequests).toEqual([]);
    expect(network.unexpectedRequests).toEqual([]);

    const unexpectedOwnedMutationWasBlocked = await page.evaluate(async () => {
      try {
        await fetch("/checkout-gate-must-block", { method: "POST" });
        return false;
      } catch {
        return true;
      }
    });
    expect(unexpectedOwnedMutationWasBlocked).toBe(true);
    expect(network.unexpectedRequests).toEqual([`POST ${network.ownedOrigin}/checkout-gate-must-block`]);

    let unexpectedHttpWasBlocked = false;
    try {
      await page.goto("http://untrusted.invalid/checkout-gate-must-block");
    } catch {
      unexpectedHttpWasBlocked = true;
    }
    expect(unexpectedHttpWasBlocked).toBe(true);
    expect(network.unexpectedRequests).toEqual([
      `POST ${network.ownedOrigin}/checkout-gate-must-block`,
      "GET http://untrusted.invalid/checkout-gate-must-block",
    ]);
  });
});
