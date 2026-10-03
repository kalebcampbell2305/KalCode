import { expect, test } from "@playwright/test";

test("Code welcome keeps missing-workspace actions aligned at compact widths", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  await page.evaluate(() => {
    const memory = (window as unknown as { __kalcodeMemory: { queueFolders: (...folders: string[]) => void } })
      .__kalcodeMemory;
    memory.queueFolders("missing-project", "temporary-project");
  });
  const code = page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true });
  await code.click();
  await page.getByRole("button", { name: "Open folder…", exact: true }).click();
  await expect(page.getByRole("heading", { name: "missing-project", exact: true })).toBeVisible();
  // With a workspace open, folders open from the workspace switcher (its name in the header).
  await page.getByRole("heading", { level: 1, name: "missing-project" }).getByRole("button").click();
  await page.getByRole("menuitem", { name: "Open folder…" }).click();
  await expect(page.getByRole("heading", { name: "temporary-project", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const memory = (window as unknown as { __kalcodeMemory: { makeUnavailable: (name: string) => void } })
      .__kalcodeMemory;
    memory.makeUnavailable("missing-project");
    memory.makeUnavailable("temporary-project");
  });
  await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await code.click();
  await page.getByRole("button", { name: "Remove from KalCode", exact: true }).click();
  for (const width of [1360, 680]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("heading", { name: "Open a project folder" })).toBeVisible();
    const missing = page.getByRole("listitem").filter({ hasText: "Folder not found" });
    await expect(missing).toHaveCount(1);
    const badge = await missing.getByText("Folder not found").boundingBox();
    const remove = await missing.getByRole("button", { name: /Remove .* from KalCode/ }).boundingBox();
    expect(badge).not.toBeNull();
    expect(remove).not.toBeNull();
    expect(
      Math.abs((badge?.y ?? 0) + (badge?.height ?? 0) / 2 - ((remove?.y ?? 0) + (remove?.height ?? 0) / 2)),
    ).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath(`code-welcome-${width}.png`) });
  }
});
