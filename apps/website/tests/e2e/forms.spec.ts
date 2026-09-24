import { expect, test } from "@playwright/test";
import { queryEarlyAccess, uniqueEmail, uniqueIp, useClientIp } from "./helpers";

const SIGNUP_SUCCESS = "You're on the list. We'll email you when there is a build to try.";
const REMOVE_SUCCESS = "If that address was on the early-access list, it has been removed.";

test.describe("early-access form", () => {
  test("joins, then shows the same message for a duplicate", async ({ page }) => {
    await useClientIp(page);
    const email = uniqueEmail("join");
    await page.goto("/download");
    const form = page.locator("form[data-api-form='signup']");
    const input = form.getByLabel("Email address");
    const status = form.getByRole("status");

    await input.fill(`  ${email.toUpperCase()} `);
    const button = form.getByRole("button", { name: "Join early access" });
    const [response] = await Promise.all([page.waitForResponse("**/api/early-access"), button.click()]);
    expect(response.status()).toBe(200);
    await expect(status).toHaveText(SIGNUP_SUCCESS);
    await expect(input).toHaveValue("");
    await expect(button).toBeEnabled();

    await input.fill(email);
    await button.click();
    await expect(status).toHaveText(SIGNUP_SUCCESS);

    const rows = queryEarlyAccess(email);
    expect(rows).toEqual([{ email, source: "/download", consent_version: "2026-09-24" }]);
  });

  test("shows a specific error for an invalid email and does not submit", async ({ page }) => {
    await useClientIp(page);
    await page.goto("/");
    const form = page.locator("form[data-api-form='signup']");
    const input = form.getByLabel("Email address");
    let requests = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/")) requests += 1;
    });

    await form.getByRole("button", { name: "Join early access" }).click();
    await expect(form.getByRole("status")).toHaveText("Enter your email address.");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toBeFocused();

    await input.fill("name@example");
    await form.getByRole("button", { name: "Join early access" }).click();
    await expect(form.getByRole("status")).toHaveText("Enter a complete email address, like name@example.com.");
    expect(requests).toBe(0);

    await input.fill("name@example.com");
    await expect(input).not.toHaveAttribute("aria-invalid", "true");
  });

  test("the server rejects an invalid email with 400", async ({ request }) => {
    const response = await request.post("/api/early-access", {
      data: { email: "nope@", source: "/" },
      headers: { "cf-connecting-ip": uniqueIp() },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "invalid_email" });
  });

  test("a filled honeypot gets the normal success response but is not stored", async ({ page }) => {
    await useClientIp(page);
    const email = uniqueEmail("bot");
    await page.goto("/pricing");
    const form = page.locator("form[data-api-form='signup']");
    await form.locator("input[name='website']").evaluate((input: HTMLInputElement) => {
      input.value = "https://spam.example";
    });
    await form.getByLabel("Email address").fill(email);
    await form.getByRole("button", { name: "Join early access" }).click();
    await expect(form.getByRole("status")).toHaveText(SIGNUP_SUCCESS);
    expect(queryEarlyAccess(email)).toEqual([]);
  });

  test("the honeypot is hidden from people and assistive technology", async ({ page }) => {
    // The trap is hidden only by site.css. If the stylesheet is not applied (for example the
    // E2E server's dist folder was rebuilt mid-run), the trap renders in the page flow; name that
    // cause instead of failing on an opaque boolean. See docs/TESTING.md, "Flaky tests".
    const stylesheetErrors: string[] = [];
    page.on("response", (response) => {
      if (response.request().resourceType() === "stylesheet" && !response.ok()) {
        stylesheetErrors.push(`${response.status()} ${response.url()}`);
      }
    });
    page.on("requestfailed", (request) => {
      if (request.resourceType() === "stylesheet") {
        stylesheetErrors.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`);
      }
    });
    await page.goto("/");
    expect(stylesheetErrors, "site stylesheet failed to load").toEqual([]);

    const trap = page.locator("form[data-api-form='signup'] input[name='website']");
    const container = page.locator(".form__trap");
    await expect(trap).toHaveAttribute("tabindex", "-1");
    await expect(container, "site.css must position the honeypot").toHaveCSS("position", "absolute");
    const box = await trap.boundingBox();
    // Hidden (no box) or entirely left of the viewport.
    if (box !== null) expect(box.x + box.width, `honeypot box ${JSON.stringify(box)}`).toBeLessThanOrEqual(0);
    await expect(container).toHaveAttribute("aria-hidden", "true");
  });

  test("API status codes: 405, 415, 413 and 429", async ({ request }) => {
    const ip = uniqueIp();
    const headers = { "cf-connecting-ip": ip };
    expect((await request.get("/api/early-access", { headers })).status()).toBe(405);
    const wrongType = await request.post("/api/early-access", {
      headers: { ...headers, "content-type": "text/plain" },
      data: "email=a@example.com",
    });
    expect(wrongType.status()).toBe(415);
    const tooBig = await request.post("/api/early-access", {
      headers,
      data: { email: "a@example.com", padding: "x".repeat(3000) },
    });
    expect(tooBig.status()).toBe(413);

    // The limit is 5 requests per 60 seconds per IP; the POSTs above used 2 of them.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await request.post("/api/early-access", {
        headers,
        data: { email: "nope", source: "/" },
      });
      statuses.push(response.status());
    }
    expect(statuses.slice(0, 3)).toEqual([400, 400, 400]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });
});

test.describe("removal form", () => {
  test("removes an address with the same message whether or not it existed", async ({ page, request }) => {
    const email = uniqueEmail("remove");
    const joined = await request.post("/api/early-access", {
      headers: { "cf-connecting-ip": uniqueIp() },
      data: { email, source: "/", website: "" },
    });
    expect(joined.status()).toBe(200);
    expect(queryEarlyAccess(email)).toHaveLength(1);

    await useClientIp(page);
    await page.goto("/privacy");
    const form = page.locator("form[data-api-form='remove']");
    const input = form.getByLabel("Email address to remove");
    const status = form.getByRole("status");

    await input.fill(email);
    await form.getByRole("button", { name: "Remove my email" }).click();
    await expect(status).toHaveText(REMOVE_SUCCESS);
    expect(queryEarlyAccess(email)).toEqual([]);

    await input.fill(uniqueEmail("never-joined"));
    await form.getByRole("button", { name: "Remove my email" }).click();
    await expect(status).toHaveText(REMOVE_SUCCESS);

    const a = await request.post("/api/early-access/remove", {
      headers: { "cf-connecting-ip": uniqueIp() },
      data: { email: uniqueEmail("absent") },
    });
    const b = await request.post("/api/early-access/remove", {
      headers: { "cf-connecting-ip": uniqueIp() },
      data: { email },
    });
    expect(a.status()).toBe(b.status());
    expect(await a.text()).toBe(await b.text());
  });
});
