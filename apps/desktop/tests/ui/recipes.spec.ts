import { expect, type Page, test } from "@playwright/test";

async function palette(page: Page, query: string) {
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox");
  await input.fill(query);
  await expect(page.getByRole("option", { name: query, exact: true })).toBeVisible();
  await input.press("Enter");
}

test("a Recipe saved in the library launches from the command palette and opens its desk", async ({ page }) => {
  await page.goto("/?scenario=code");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

  // Create a Recipe with one terminal that runs a startup command.
  await palette(page, "Manage Recipes");
  const library = page.getByRole("dialog", { name: "Recipes" });
  await expect(library).toBeVisible();
  await library.getByRole("button", { name: "New Recipe" }).first().click();

  // The editor is titled by the draft name, so find it by its Save action.
  const editor = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Save Recipe" }) });
  await editor.getByLabel("Name", { exact: true }).first().fill("Morning desk");
  await editor.getByRole("button", { name: "Add Terminal" }).click();
  await editor.getByLabel("Startup command").fill("echo recipe-ready");
  await editor.getByRole("button", { name: "Save Recipe" }).click();
  await expect(page.getByRole("list", { name: "Recipes" }).getByLabel("Morning desk", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  // One action recreates the desk: the terminal opens and runs its command; the summary links it.
  await palette(page, "Launch Morning desk");
  const summary = page.getByRole("status", { name: "Morning desk launch result" });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("Started 1 of 1");
  await expect(summary.getByRole("button", { name: "Open Terminal" })).toBeVisible();
  await expect(page.getByText("recipe-ready").first()).toBeVisible();
});
