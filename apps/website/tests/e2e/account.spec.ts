import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("Account", () => {
  test("holds new paid purchases until the release is enabled", async ({ page }) => {
    await page.goto("/account");
    const purchases = page.locator("[data-checkout-tier]");
    await expect(purchases).toHaveCount(3);
    for (const purchase of await purchases.all()) await expect(purchase).toBeDisabled();
    await expect(page.locator("[data-billing-portal]")).toBeEnabled();
  });
  test("is a noindex passwordless account surface with truthful account boundaries", async ({ page }) => {
    const response = await page.goto("/account");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle("Account — KalCode");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "Your KalCode account" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "One account. No password to remember." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Microsoft" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Email my sign-in link/ })).toBeVisible();
    await expect(page.locator("main")).toContainText("Local Dictation");
    await expect(page.locator("main")).toContainText("Unlimited on every plan");
    await expect(page.locator("main")).toContainText("Handled by your connected provider");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test("fits desktop and mobile viewports", async ({ page }) => {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/account");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        `${width}px viewport`,
      ).toBeLessThanOrEqual(0);
      await expect(page.getByRole("button", { name: /Email my sign-in link/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue with Microsoft" })).toBeVisible();
    }
  });

  test("shows OWNER as unlimited private access without billing actions", async ({ page }) => {
    let billingRequests = 0;
    await page.route("https://api.kalcoded.com/**", async (route) => {
      const request = route.request();
      const origin = request.headers().origin ?? "";
      const headers = {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "content-type",
      };
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers });
        return;
      }
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/v1/billing/")) billingRequests += 1;
      const body =
        path === "/v1/account"
          ? { ok: true, account: { email: "owner@example.com", activatedAt: "2026-09-26T00:00:00.000Z" } }
          : path === "/v1/entitlement"
            ? { ok: true, entitlement: { tier: "owner" } }
            : path === "/v1/kalvoice/usage"
              ? { ok: true, usage: { used: 7, allowance: null, resetsAt: "2026-10-01T00:00:00.000Z" } }
              : { ok: false, error: "unexpected_test_route" };
      await route.fulfill({
        status: body.ok ? 200 : 404,
        contentType: "application/json",
        headers,
        body: JSON.stringify(body),
      });
    });

    await page.goto("/account");
    await expect(page.locator("[data-account-plan]")).toHaveText("OWNER");
    await expect(page.locator("[data-account-usage]")).toContainText("Unlimited");
    await expect(page.locator("[data-owner-access]")).toContainText("No subscription payment is required");
    await expect(page.locator("[data-owner-access]")).toBeVisible();
    await expect(page.locator("[data-billing-portal]")).toBeHidden();
    await expect(page.locator("[data-account-upgrades]")).toBeHidden();
    await expect(page.locator("[data-checkout-closed]")).toBeHidden();
    await expect(page.locator("[data-activate-free]")).toBeHidden();
    expect(billingRequests).toBe(0);
  });

  test("does not claim payment from an unconfirmed checkout query flag", async ({ page }) => {
    await page.route("https://api.kalcoded.com/**", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "unauthenticated" }),
      }),
    );
    await page.addInitScript(() => {
      window.setTimeout = ((handler: TimerHandler) => {
        queueMicrotask(() => {
          if (typeof handler === "function") handler();
        });
        return 1;
      }) as typeof window.setTimeout;
    });

    await page.goto("/account?checkout=success");
    await expect(page.locator("[data-account-status]")).toHaveText(
      "Your paid plan is not active yet. If checkout completed, Stripe may still be confirming it. Refresh in a moment.",
    );
    await expect(page.locator("main")).not.toContainText("Payment received");
  });

  test("uses ephemeral PKCE for Google and accepts only a cookie completion response", async ({ page }) => {
    const state = "s".repeat(43);
    const nonce = "n".repeat(43);
    let signedIn = false;
    let startBody: { client?: string; codeChallenge?: string } | null = null;
    let completeBody: { state?: string; code?: string; codeVerifier?: string; nonce?: string } | null = null;

    await page.route("https://api.kalcoded.com/**", async (route) => {
      const request = route.request();
      const origin = request.headers().origin ?? "";
      const cors = {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "content-type",
      };
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      const path = new URL(request.url()).pathname;
      if (path === "/v1/auth/google/start") {
        startBody = request.postDataJSON() as typeof startBody;
        const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authorizeUrl.search = new URLSearchParams({
          client_id: "test-client.apps.googleusercontent.com",
          redirect_uri: "https://api.kalcoded.com/v1/auth/google/callback",
          response_type: "code",
          scope: "openid email",
          state,
          nonce,
          code_challenge: startBody?.codeChallenge ?? "",
          code_challenge_method: "S256",
        }).toString();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: cors,
          body: JSON.stringify({
            ok: true,
            authorizeUrl: authorizeUrl.toString(),
            nonce,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          }),
        });
        return;
      }
      if (path === "/v1/auth/google/complete") {
        completeBody = request.postDataJSON() as typeof completeBody;
        signedIn = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { ...cors, "set-cookie": "__Host-kalcode_session=opaque; Path=/; HttpOnly; Secure; SameSite=Lax" },
          body: JSON.stringify({
            ok: true,
            status: "signed_in",
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          }),
        });
        return;
      }
      if (path === "/v1/account" && signedIn) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: cors,
          body: JSON.stringify({ ok: true, account: { email: "person@example.com", activatedAt: null } }),
        });
        return;
      }
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        headers: cors,
        body: JSON.stringify({ ok: false, error: "unauthenticated" }),
      });
    });
    await page.route("https://accounts.google.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Google sign in</title>" }),
    );

    await page.goto("/account");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.waitForURL("https://accounts.google.com/**");
    expect(startBody).toMatchObject({ client: "website", codeChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });

    await page.goto(`/account#socialProvider=google&socialCode=one-use-code&socialState=${state}`);
    await expect(page.locator("[data-account-status]")).toHaveText("Signed in.");
    expect(completeBody).toMatchObject({ state, code: "one-use-code", nonce });
    expect(
      createHash("sha256")
        .update(completeBody?.codeVerifier ?? "")
        .digest("base64url"),
    ).toBe(startBody?.codeChallenge);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), `kalcode:oidc:${state}`)).toBeNull();
    expect(await page.evaluate(() => Object.values(sessionStorage).some((value) => value.includes("kcs_")))).toBe(
      false,
    );
  });

  test("clears only the owned pending flow when callback fields are duplicated", async ({ page }) => {
    const state = "d".repeat(43);
    let completionCalls = 0;
    await page.route("https://api.kalcoded.com/**", async (route) => {
      const request = route.request();
      const origin = request.headers().origin ?? "";
      const headers = {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "content-type",
      };
      if (request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers });
        return;
      }
      if (new URL(request.url()).pathname.endsWith("/complete")) completionCalls += 1;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        headers,
        body: JSON.stringify({ ok: false, error: "unauthenticated" }),
      });
    });

    await page.goto("/account");
    await page.evaluate((flowState) => {
      sessionStorage.setItem(
        `kalcode:oidc:${flowState}`,
        JSON.stringify({
          provider: "google",
          codeVerifier: "v".repeat(43),
          nonce: "n".repeat(43),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        }),
      );
      sessionStorage.setItem("unrelated", "preserve-me");
    }, state);
    await page.goto(
      `/account?callback=test#socialProvider=google&socialProvider=microsoft&socialCode=one&socialCode=two&socialState=${state}`,
    );

    await expect(page.locator("[data-account-status]")).toHaveText(
      "Social sign-in could not be completed. Start again.",
    );
    expect(await page.evaluate((key) => sessionStorage.getItem(key), `kalcode:oidc:${state}`)).toBeNull();
    expect(await page.evaluate(() => sessionStorage.getItem("unrelated"))).toBe("preserve-me");
    expect(completionCalls).toBe(0);
    expect(new URL(page.url()).hash).toBe("");
  });
});
