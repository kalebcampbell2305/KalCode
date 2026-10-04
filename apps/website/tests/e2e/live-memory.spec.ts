import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) {
  test(`Unified Memory demo edits temporary project context at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page
      .getByRole("link", { name: /Try KalCode/ })
      .first()
      .click();
    await expect(page.locator("[data-live]")).toHaveAttribute("data-live", "ready");
    const app = page.locator("[data-live-app]");
    await app.locator('[data-do="go:memory"]').click();
    const memory = app.getByRole("region", { name: "Unified Memory", exact: true });
    await expect(memory).toContainText("Fictional sample notes");
    await expect(memory.getByRole("article", { name: "Memory details" })).toContainText("Dashboard.tsx");
    await memory.screenshot({ path: testInfo.outputPath(`memory-${width}.png`) });
    const accessibility = await new AxeBuilder({ page }).include(".lk-memory").analyze();
    expect(accessibility.violations).toEqual([]);
    await memory.getByRole("button", { name: "Edit memory", exact: true }).click();
    await memory
      .getByRole("textbox", { name: "Memory content" })
      .fill("Use shared stat cards. <sample> stays plain text.");
    await memory.getByRole("button", { name: "Save memory", exact: true }).click();
    await expect(memory.getByRole("article")).toContainText("<sample> stays plain text.");
    await memory.getByRole("button", { name: "Unpin", exact: true }).click();
    await expect(memory.getByRole("button", { name: "Pin", exact: true })).toHaveAttribute("aria-pressed", "false");
    if (width < 500) await memory.getByRole("button", { name: "Back to memories" }).click();
    await memory.getByRole("searchbox", { name: "Search memory" }).fill("revenue");
    await expect(memory.locator(".lk-memory__note")).toHaveCount(1);
    await memory.getByRole("button", { name: "Chart labels on small screens", exact: true }).click();
    await memory.getByRole("button", { name: "Mark reviewed" }).click();
    await expect(memory.locator(".lk-memory__stale")).toHaveCount(0);
    await memory.getByRole("button", { name: "Remove", exact: true }).click();
    await memory.getByRole("button", { name: "Remove memory", exact: true }).click();
    await expect(memory).toContainText("No memories found");
    await memory.getByRole("button", { name: "Add memory", exact: true }).click();
    await memory.getByRole("textbox", { name: "Memory title" }).fill("Keep releases small");
    await memory.getByRole("textbox", { name: "Memory content" }).fill("Ship focused changes after validation.");
    await memory.getByRole("combobox", { name: "Memory category", exact: true }).selectOption("decisions");
    await memory.getByRole("button", { name: "Save memory", exact: true }).click();
    await expect(memory.getByRole("article")).toContainText("Keep releases small");
    await page.getByRole("button", { name: "Reset demo", exact: true }).click();
    await app.locator('[data-do="go:memory"]').click();
    await expect(memory).not.toContainText("Keep releases small");
    await expect(memory.getByRole("article")).toContainText("main dashboard shell");
    expect(errors).toEqual([]);
  });
}
