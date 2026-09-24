import { expect, test } from "@playwright/test";
import { CONTACT_EMAIL, PAGES, SOCIAL } from "../../src/lib/site";

/**
 * Crawls every internal link starting from all known pages. Every target must answer 200
 * directly, and every in-page anchor must point at an element that exists.
 */
test("no dead internal links or anchors", async ({ page, request }) => {
  const queue: string[] = PAGES.map((entry) => entry.path);
  const visited = new Set<string>();
  const checkedTargets = new Map<string, number>();
  const problems: string[] = [];

  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (visited.has(path)) continue;
    visited.add(path);

    const response = await page.goto(path);
    if (response?.status() !== 200) {
      problems.push(`${path} → ${response?.status()}`);
      continue;
    }

    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""));

    for (const href of hrefs) {
      // The intended external links: the published contact and the configured social accounts.
      if (href === `mailto:${CONTACT_EMAIL}`) continue;
      if (Object.values(SOCIAL).some((account) => account.url === href)) continue;
      if (/^(https?:|mailto:|tel:)/.test(href)) {
        problems.push(`${path}: unexpected external link ${href}`);
        continue;
      }
      const url = new URL(href, `http://local${path}`);
      const target = url.pathname;
      if (url.hash) {
        const id = decodeURIComponent(url.hash.slice(1));
        if (target === path) {
          const exists = await page.locator(`[id="${id}"]`).count();
          if (!exists) problems.push(`${path}: missing anchor #${id}`);
        } else {
          const html = await (await request.get(target)).text();
          if (!html.includes(`id="${id}"`)) problems.push(`${path}: missing anchor ${target}#${id}`);
        }
      }
      if (!checkedTargets.has(target)) {
        const result = await request.get(target, { maxRedirects: 0 });
        checkedTargets.set(target, result.status());
        if (result.status() !== 200) problems.push(`${path}: ${target} → ${result.status()}`);
      }
      if (!visited.has(target) && !target.startsWith("/api/")) queue.push(target);
    }
  }

  expect(problems).toEqual([]);
  // Every listed page is reachable by following links from the others.
  for (const entry of PAGES) expect(visited.has(entry.path), entry.path).toBe(true);
});

test("header navigation and footer links resolve", async ({ page }) => {
  await page.goto("/");
  const header = page.getByRole("navigation", { name: "Main" });
  for (const name of ["Product", "Pricing", "Docs", "Changelog"]) {
    await header.getByRole("link", { name, exact: true }).click();
    await expect(page.locator("h1")).toBeVisible();
    await expect(header.getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
    await page.goto("/");
  }
  const footer = page.locator("footer");
  const footerLinks = await footer.locator("a[href]").count();
  expect(footerLinks).toBeGreaterThanOrEqual(12);
  for (const label of ["Security", "Privacy", "Terms"]) {
    await footer.getByRole("link", { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`/${label.toLowerCase()}$`));
    await page.goto("/");
  }
});
