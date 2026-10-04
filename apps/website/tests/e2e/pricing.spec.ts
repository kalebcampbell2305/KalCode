import {
  CORE_LIMITS,
  formatCoreLimit,
  formatInterval,
  formatPrice,
  getPlanFeature,
  PLAN_FEATURES,
  PLANS,
  UNLIMITED_NOTE,
  yearlySavingsUsd,
} from "@kalcode/protocol/plans";
import { expect, test } from "@playwright/test";

const usd = (value: number) => `$${value.toLocaleString("en-US")}`;

test.describe("pricing", () => {
  test("shows every plan's monthly price, yearly price and savings from the catalog", async ({ page }) => {
    await page.goto("/pricing");
    const toggle = page.getByRole("group", { name: "Billing period" });
    const monthly = toggle.getByRole("button", { name: "Monthly" });
    const yearly = toggle.getByRole("button", { name: /Yearly/ });
    await expect(monthly).toHaveAttribute("aria-pressed", "true");
    await expect(yearly).toHaveAttribute("aria-pressed", "false");

    for (const plan of PLANS) {
      const card = page.locator(`.tier[data-plan="${plan.id}"]`);
      await expect(card.getByRole("heading", { level: 3 })).toHaveText(plan.name);
      await expect(card).toContainText(plan.stage);
      await expect(card).toContainText(plan.tagline);
      await expect(card.locator(".tier__price")).toHaveText(`${formatPrice(plan, "month")}${formatInterval("month")}`, {
        useInnerText: true,
      });
      const saving = yearlySavingsUsd(plan);
      if (saving > 0) {
        // Without choosing yearly, the yearly price and saving are still written beside the monthly one.
        await expect(card.locator(".tier__saving")).toHaveText(
          `or ${formatPrice(plan, "year")}${formatInterval("year")} · save ${usd(saving)}`,
          { useInnerText: true },
        );
      }
    }
    expect(PLANS.filter((plan) => plan.price.monthlyUsd > 0).map((plan) => usd(yearlySavingsUsd(plan)))).toEqual([
      "$20",
      "$50",
      "$100",
    ]);

    // Keyboard: focus Yearly and press Space.
    await yearly.focus();
    await page.keyboard.press("Space");
    await expect(yearly).toHaveAttribute("aria-pressed", "true");
    await expect(monthly).toHaveAttribute("aria-pressed", "false");
    for (const plan of PLANS) {
      const card = page.locator(`.tier[data-plan="${plan.id}"]`);
      await expect(card.locator(".tier__price")).toHaveText(`${formatPrice(plan, "year")}${formatInterval("year")}`, {
        useInnerText: true,
      });
      const saving = yearlySavingsUsd(plan);
      if (saving > 0)
        await expect(card.locator(".tier__saving")).toHaveText(`You save ${usd(saving)} a year`, {
          useInnerText: true,
        });
    }
    await monthly.click();
    await expect(page.locator(`.tier[data-plan="max"] .tier__price`)).toHaveText(
      `${formatPrice(PLANS[2], "month")}${formatInterval("month")}`,
      { useInnerText: true },
    );
  });

  test("works without JavaScript: monthly prices with the yearly price written out", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto("/pricing");
    await expect(page.getByRole("group", { name: "Billing period" })).toBeHidden();
    for (const plan of PLANS.filter((entry) => yearlySavingsUsd(entry) > 0)) {
      const card = page.locator(`.tier[data-plan="${plan.id}"]`);
      await expect(card.locator(".tier__price")).toHaveText(`${formatPrice(plan, "month")}${formatInterval("month")}`, {
        useInnerText: true,
      });
      await expect(card).toContainText(
        `or ${formatPrice(plan, "year")}${formatInterval("year")} · save ${usd(yearlySavingsUsd(plan))}`,
      );
      await expect(card.getByRole("link", { name: /CHECK OUT NOW/ })).toHaveAttribute(
        "href",
        `/account?plan=${plan.id}&interval=month`,
      );
    }
    await context.close();
  });

  test("CHECK OUT NOW carries the plan and the selected interval", async ({ page }) => {
    await page.goto("/pricing");
    const ctas = page.getByRole("link", { name: /^CHECK OUT NOW/ });
    await expect(ctas).toHaveCount(PLANS.length);
    for (const interval of ["month", "year"] as const) {
      await page
        .getByRole("group", { name: "Billing period" })
        .getByRole("button", { name: interval === "month" ? "Monthly" : /Yearly/ })
        .click();
      for (const plan of PLANS) {
        const cta = page
          .locator(`.tier[data-plan="${plan.id}"]`)
          .getByRole("link", { name: `CHECK OUT NOW with ${plan.name}`, exact: true });
        await expect(cta).toHaveText(/CHECK OUT NOW/);
        await expect(cta).toHaveAttribute("href", `/account?plan=${plan.id}&interval=${interval}`);
      }
    }
  });

  test("marks MOST POPULAR on MAX only and lists the five core limits on every card", async ({ page }) => {
    await page.goto("/pricing");
    const badges = page.locator(".tier__badge");
    await expect(badges).toHaveCount(PLANS.filter((plan) => plan.popular).length);
    expect(PLANS.filter((plan) => plan.popular).map((plan) => plan.id)).toEqual(["max"]);
    await expect(page.locator('.tier[data-plan="max"] .tier__badge')).toHaveText(/Most popular/i);
    for (const plan of PLANS) {
      const limits = page.locator(`.tier[data-plan="${plan.id}"] .tier__limits li[data-limit]`);
      await expect(limits).toHaveCount(CORE_LIMITS.length);
      for (const [index, limit] of CORE_LIMITS.entries()) {
        await expect(limits.nth(index)).toContainText(formatCoreLimit(plan.limits, limit));
      }
    }
    await expect(page.locator('.tier[data-plan="max2x"]')).toContainText("Maximum autonomy");
    await expect(page.locator("#unlimited-note")).toContainText(UNLIMITED_NOTE);
  });

  test("labels card features Available or Coming soon from each feature's status", async ({ page }) => {
    await page.goto("/pricing");
    for (const [index, plan] of PLANS.entries()) {
      const card = page.locator(`.tier[data-plan="${plan.id}"]`);
      if (index > 0) await expect(card).toContainText(`Everything in ${PLANS[index - 1].name}, plus`);
      const items = card.locator(".feat");
      await expect(items).toHaveCount(plan.cardFeatures.length);
      for (const id of plan.cardFeatures) {
        const feature = getPlanFeature(id);
        const item = items.filter({ hasText: feature.label });
        await expect(item).toHaveAttribute("data-status", feature.status);
        await expect(item).toContainText(feature.status === "available" ? "(available now)" : "(coming soon)");
      }
      const soon = plan.cardFeatures.filter((id) => getPlanFeature(id).status === "coming_soon").length;
      await expect(card.locator(".tier__soon-head")).toHaveCount(soon > 0 ? 1 : 0);
    }
  });

  test("expands a full comparison that scrolls inside itself on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/pricing");
    const table = page.getByRole("table");
    await expect(table).toBeHidden();
    const summary = page.locator("summary", { hasText: "Compare all features" });
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(table).toBeVisible();
    for (const limit of CORE_LIMITS) {
      const row = table.getByRole("row", { name: new RegExp(`^${limit.label}`) });
      await expect(row).toBeVisible();
    }
    for (const feature of PLAN_FEATURES) {
      const row = table.locator(`tr[data-feature="${feature.id}"]`);
      await expect(row).toHaveAttribute("data-status", feature.status);
      if (feature.status === "coming_soon") await expect(row.locator("th")).toContainText("Coming soon");
      else await expect(row.locator("th")).not.toContainText("Coming soon");
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
    const wrap = page.getByRole("region", { name: "Plan comparison" });
    expect(await wrap.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  });

  test("keeps local agents and terminals unlimited while pricing scale and autonomy", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.locator(".page-head")).toContainText("Unlimited local coding agents + terminals on every plan");
    for (const plan of PLANS) {
      const card = page.locator(`.tier[data-plan="${plan.id}"]`);
      await expect(card.locator('[data-limit="parallelAgents"]')).toContainText("Unlimited local agents");
      await expect(card.locator('[data-limit="openTerminals"]')).toContainText("Unlimited local terminals");
    }
    await expect(page.locator('#plan-max [data-limit="providerAccounts"]')).toContainText("12 accounts");
    await page.getByText("Compare all features", { exact: true }).click();
    const integrations = page.locator('[data-feature="external-integrations"]');
    for (const [index, value] of ["1", "5", "25", "Unlimited"].entries()) {
      await expect(integrations.locator("td").nth(index)).toHaveText(value);
    }
    const history = page.locator('[data-feature="operations-history"]');
    for (const value of ["Recent 10", "30 days", "1 year", "Maximum"]) await expect(history).toContainText(value);
  });

  test("the FAQ is a keyboard-operable accordion", async ({ page }) => {
    await page.goto("/pricing");
    const question = page.getByText("Does dictation count?");
    const answer = page.getByText("Dictation and voice into terminals run on your device");
    await expect(answer).toBeHidden();
    await question.focus();
    await page.keyboard.press("Enter");
    await expect(answer).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(answer).toBeHidden();
  });

  test("never lists a private tier and opens paid plans account-first", async ({ page }) => {
    await page.goto("/pricing");
    const main = page.locator("main");
    await expect(main).not.toContainText("OWNER");
    await expect(main).toContainText("Paid plans are open");
    await expect(main).not.toContainText("nothing is for sale today");
    for (const plan of PLANS) {
      await expect(main.getByRole("link", { name: `CHECK OUT NOW with ${plan.name}`, exact: true })).toHaveAttribute(
        "href",
        /^\/account\?/,
      );
    }
  });

  test("uses KalVoice Requests and keeps dictation and connected-provider inference outside the meter", async ({
    page,
  }) => {
    await page.goto("/pricing");
    const main = page.locator("main");
    await expect(main).not.toContainText(/\btokens?\b/i);
    await expect(main).toContainText("Unlimited on-device dictation");
    await expect(main).toContainText("your usage is billed by each provider");
  });

  test("fits desktop and phone widths with no sideways scroll", async ({ page }, testInfo) => {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
      [320, 640],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/pricing");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        `${width}px`,
      ).toBeLessThanOrEqual(0);
      await page.screenshot({ path: testInfo.outputPath(`pricing-${width}.png`), fullPage: true });
      // The head clips its overflow, so check the status chip, lead and toggle themselves.
      for (const selector of [".page-head .chip", ".page-head .lead", "[data-interval-toggle]"]) {
        const box = await page.locator(selector).boundingBox();
        expect(box && box.x + box.width <= width, `${selector} fits at ${width}px`).toBe(true);
      }
    }
  });
});
