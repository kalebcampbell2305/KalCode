import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { EARLY_ACCESS_EMAIL, EMAIL_ACTION_PAGES, EMAIL_FROM, EMAIL_REPLY_TO } from "../../src/lib/site";
import {
  countLinks,
  d1Local,
  expireLinks,
  failNextEmails,
  linkIn,
  mailTo,
  queryEarlyAccess,
  uniqueEmail,
  uniqueIp,
  useClientIp,
} from "./helpers";

// Double opt-in end to end: the real Worker on local D1 with the capture transport, so every
// email lands in the local mail sink (tests/e2e/mail-sink.mjs), never in a real inbox.

const { confirmPath, removePath } = EARLY_ACCESS_EMAIL;
const CONFIRMED =
  "Your email is confirmed. You're on the KalCode early-access list, and we'll email you when there is a build to try.";
const REMOVED = "Your email has been removed from the early-access list. We won't email you again.";
const CONFIRM_INVALID =
  "This confirmation link is no longer valid. Links work once and expire after 72 hours. Join again to get a new one.";
const REMOVE_INVALID =
  "This removal link is no longer valid. Links work once and expire after 72 hours. Request a new one on the privacy page.";
const EMAIL_FAILED = "We couldn't send the email right now, so nothing was saved. Try again in a few minutes.";

async function joinWithForm(page: Page, email: string): Promise<void> {
  await useClientIp(page);
  await page.goto("/download");
  const form = page.locator("form[data-api-form='signup']");
  await form.getByLabel("Email address").fill(email);
  await form.getByRole("button", { name: "Join early access" }).click();
  await expect(form.getByRole("status")).toContainText("check your inbox");
}

/**
 * Collects console errors and page errors (CSP violations surface as console errors). The
 * browser's own "Failed to load resource" line for an API answer the page expects and handles
 * (410 for a used link) is not an error of the page.
 */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/^Failed to load resource: the server responded with a status of (400|410|502) /.test(message.text())) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test.describe("double opt-in", () => {
  test("join → email captured → confirm on the page with a POST → confirmed; the link then stops working", async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const email = uniqueEmail("confirm");
    await joinWithForm(page, email);
    expect(queryEarlyAccess(email)).toMatchObject([{ status: "pending" }]);

    const [message] = await mailTo(request, email);
    expect(message).toMatchObject({
      from: EMAIL_FROM,
      to: [email],
      reply_to: EMAIL_REPLY_TO,
      subject: "Confirm your KalCode early-access email",
    });
    expect(message?.html).not.toMatch(/<img|<script/i);
    const link = linkIn(message?.text ?? "", confirmPath);

    // A link scanner or preview fetches the page (and even the API) with GET: nothing changes.
    expect((await request.get(link)).status()).toBe(200);
    expect((await request.get(`/api/early-access/confirm?${link.split("?")[1]}`)).status()).toBe(405);
    expect(queryEarlyAccess(email)).toMatchObject([{ status: "pending" }]);

    await useClientIp(page);
    await page.goto(link);
    await expect(page).toHaveTitle(EMAIL_ACTION_PAGES.confirm.title);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
    expect(queryEarlyAccess(email)).toMatchObject([{ status: "pending" }]);
    const [post] = await Promise.all([
      page.waitForRequest((r) => r.url().endsWith("/api/early-access/confirm") && r.method() === "POST"),
      page.getByRole("button", { name: "Confirm my email" }).click(),
    ]);
    expect(post.postDataJSON()).toEqual({ token: link.split("token=")[1] });
    const status = page.getByRole("status");
    await expect(status).toHaveText(CONFIRMED);
    await expect(status).toBeFocused();
    await expect(page.getByRole("button", { name: "Confirm my email" })).toBeHidden();
    await expect(page.getByRole("link", { name: "Go to the home page" })).toBeVisible();
    expect(queryEarlyAccess(email)).toMatchObject([{ status: "confirmed" }]);

    // Reusing the link: a clear, styled message and a way forward.
    await page.goto(link);
    await page.getByRole("button", { name: "Confirm my email" }).click();
    await expect(status).toHaveText(CONFIRM_INVALID);
    await expect(page.getByRole("link", { name: "Join early access again" })).toHaveAttribute(
      "href",
      "/download#early-access",
    );
    expect(errors).toEqual([]);
  });

  test("an expired link and a forged one are refused; a page without a code says so", async ({ page, request }) => {
    const email = uniqueEmail("expired");
    await joinWithForm(page, email);
    const [message] = await mailTo(request, email);
    const link = linkIn(message?.text ?? "", confirmPath);
    expireLinks(email);

    await useClientIp(page);
    await page.goto(link);
    await page.getByRole("button", { name: "Confirm my email" }).click();
    await expect(page.getByRole("status")).toHaveText(CONFIRM_INVALID);
    expect(queryEarlyAccess(email)).toMatchObject([{ status: "pending" }]);

    await page.goto(`${confirmPath}?token=${"A".repeat(43)}`);
    await page.getByRole("button", { name: "Confirm my email" }).click();
    await expect(page.getByRole("status")).toHaveText(CONFIRM_INVALID);

    await page.goto(confirmPath);
    await expect(page.getByRole("status")).toHaveText(
      "This page opens from the link in your confirmation email. Open that link again, or join again to get a new one.",
    );
    await expect(page.getByRole("button", { name: "Confirm my email" })).toBeHidden();

    const malformed = await request.post("/api/early-access/confirm", {
      headers: { "cf-connecting-ip": uniqueIp() },
      data: { token: "not-a-code" },
    });
    expect(malformed.status()).toBe(400);
  });

  test("no enumeration: new, pending and confirmed addresses get the same response", async ({ page, request }) => {
    const confirmed = uniqueEmail("enum-confirmed");
    await joinWithForm(page, confirmed);
    const [message] = await mailTo(request, confirmed);
    const token = new URL(linkIn(message?.text ?? "", confirmPath), "http://x").searchParams.get("token");
    const ok = await request.post("/api/early-access/confirm", {
      headers: { "cf-connecting-ip": uniqueIp() },
      data: { token },
    });
    expect(ok.status()).toBe(200);
    const pending = uniqueEmail("enum-pending");
    await joinWithForm(page, pending);

    const responses = [];
    for (const email of [uniqueEmail("enum-new"), pending, confirmed]) {
      const response = await request.post("/api/early-access", {
        headers: { "cf-connecting-ip": uniqueIp() },
        data: { email, source: "/", website: "" },
      });
      responses.push({
        status: response.status(),
        body: await response.text(),
        type: response.headers()["content-type"],
      });
    }
    expect(new Set(responses.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  test("throttle: a second join within 10 minutes sends no second email", async ({ page, request }) => {
    const email = uniqueEmail("throttle");
    await joinWithForm(page, email);
    await joinWithForm(page, email);
    expect(await mailTo(request, email)).toHaveLength(1);
    expect(countLinks(email)).toBe(2);
  });

  test("removal: privacy form → removal email → confirm on the page → row and links deleted", async ({
    page,
    request,
  }) => {
    const errors = watchErrors(page);
    const email = uniqueEmail("removal");
    const joined = await request.post("/api/early-access", {
      headers: { "cf-connecting-ip": uniqueIp() },
      data: { email, source: "/", website: "" },
    });
    expect(joined.status()).toBe(200);
    // Pretend the confirmation email went out more than 10 minutes ago (past the throttle).
    d1Local(`UPDATE early_access SET last_email_at = '2000-01-01T00:00:00.000Z' WHERE email = '${email}'`);

    await useClientIp(page);
    await page.goto("/privacy");
    const form = page.locator("form[data-api-form='remove']");
    await form.getByLabel("Email address to remove").fill(email);
    await form.getByRole("button", { name: "Email me a removal link" }).click();
    await expect(form.getByRole("status")).toContainText("we've emailed it a link");
    expect(queryEarlyAccess(email)).toHaveLength(1);

    const messages = await mailTo(request, email);
    expect(messages.map((m) => m.subject)).toEqual([
      "Confirm your KalCode early-access email",
      "Confirm removal from the KalCode early-access list",
    ]);
    const link = linkIn(messages[1]?.text ?? "", removePath);
    await page.goto(link);
    await expect(page).toHaveTitle(EMAIL_ACTION_PAGES.remove.title);
    expect(queryEarlyAccess(email)).toHaveLength(1);
    await page.getByRole("button", { name: "Remove my email" }).click();
    await expect(page.getByRole("status")).toHaveText(REMOVED);
    expect(queryEarlyAccess(email)).toEqual([]);
    expect(countLinks(email)).toBe(0);

    await page.goto(link);
    await page.getByRole("button", { name: "Remove my email" }).click();
    await expect(page.getByRole("status")).toHaveText(REMOVE_INVALID);
    await expect(page.getByRole("link", { name: "Request a new removal link" })).toHaveAttribute(
      "href",
      "/privacy#remove",
    );
    expect(errors).toEqual([]);
  });

  test("the removal link in the confirmation email removes a pending sign-up", async ({ page, request }) => {
    const email = uniqueEmail("changed-mind");
    await joinWithForm(page, email);
    const [message] = await mailTo(request, email);
    await page.goto(linkIn(message?.text ?? "", removePath));
    await page.getByRole("button", { name: "Remove my email" }).click();
    await expect(page.getByRole("status")).toHaveText(REMOVED);
    expect(queryEarlyAccess(email)).toEqual([]);
  });

  test("when the email cannot be sent, the form says so, nothing is saved, and a retry works", async ({
    page,
    request,
  }) => {
    const email = uniqueEmail("send-fails");
    await failNextEmails(request, 1);
    await useClientIp(page);
    await page.goto("/download");
    const form = page.locator("form[data-api-form='signup']");
    await form.getByLabel("Email address").fill(email);
    const [response] = await Promise.all([
      page.waitForResponse("**/api/early-access"),
      form.getByRole("button", { name: "Join early access" }).click(),
    ]);
    expect(response.status()).toBe(502);
    await expect(form.getByRole("status")).toHaveText(EMAIL_FAILED);
    expect(queryEarlyAccess(email)).toEqual([]);
    expect(await mailTo(request, email)).toEqual([]);

    await form.getByRole("button", { name: "Join early access" }).click();
    await expect(form.getByRole("status")).toContainText("check your inbox");
    expect(await mailTo(request, email)).toHaveLength(1);
    expect(queryEarlyAccess(email)).toMatchObject([{ status: "pending" }]);

    // The API answer names no provider and carries none of its error text.
    await failNextEmails(request, 1);
    const api = await request.post("/api/early-access", {
      headers: { "cf-connecting-ip": uniqueIp() },
      data: { email: uniqueEmail("send-fails-api"), source: "/", website: "" },
    });
    expect(api.status()).toBe(502);
    const body = await api.text();
    expect(JSON.parse(body)).toEqual({ ok: false, error: "email_failed", message: EMAIL_FAILED });
    expect(body).not.toMatch(/simulated|provider|resend/i);
  });
});

for (const scheme of ["dark", "light"] as const) {
  test.describe(`email link pages: axe (${scheme} theme)`, () => {
    test.use({ colorScheme: scheme, reducedMotion: "reduce" });

    const check = async (page: Page) => {
      await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
      await page.evaluate(() => document.fonts.ready);
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      const blocking = results.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ id: v.id, targets: v.nodes.map((node) => node.target.join(" ")) }));
      expect(blocking).toEqual([]);
    };

    for (const action of ["confirm", "remove"] as const) {
      test(`${action}: ready, missing-link and invalid-link states`, async ({ page }) => {
        const errors = watchErrors(page);
        const path = EMAIL_ACTION_PAGES[action].path;
        await useClientIp(page);
        await page.goto(`${path}?token=${"B".repeat(43)}`);
        await check(page);
        await page
          .getByRole("button")
          .filter({ hasText: /my email/ })
          .click();
        await expect(page.getByRole("status")).toContainText("no longer valid");
        await check(page);
        await page.goto(path);
        await expect(page.getByRole("status")).toContainText("This page opens from the link");
        await check(page);
        expect(errors).toEqual([]);
      });
    }
  });
}
