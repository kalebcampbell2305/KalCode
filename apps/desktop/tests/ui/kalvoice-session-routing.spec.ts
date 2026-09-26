import { expect, type Locator, type Page, test } from "@playwright/test";

function widget(page: Page): Locator {
  return page.getByRole("region", { name: "KalVoice widget" });
}

async function openKalVoice(page: Page, transcript: string) {
  await page.goto(`/?transcript=${encodeURIComponent(transcript)}`);
  await page.getByRole("button", { name: "KalVoice", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "KalVoice" })).toBeVisible();
}

async function finishWithKey(page: Page) {
  await page.keyboard.up("F8");
  await expect(widget(page).getByText("Done", { exact: true })).toBeVisible();
}

test("one utterance keeps its keyboard target when focus changes", async ({ page }) => {
  await openKalVoice(page, "immutable destination");
  const original = page.locator("#kalvoice-page-request");
  await original.fill("Start");
  await original.focus();
  await page.keyboard.down("F8");
  await expect(widget(page).getByText("Listening", { exact: true })).toBeVisible();

  await page.evaluate(() => {
    const later = document.createElement("textarea");
    later.id = "later-dictation-target";
    document.body.append(later);
    later.focus();
  });
  await finishWithKey(page);

  await expect(original).toHaveValue("Start immutable destination");
  await expect(page.locator("#later-dictation-target")).toHaveValue("");
});

test("pressing the widget orb preserves the field focused before pointer-down", async ({ page }) => {
  await openKalVoice(page, "from the orb");
  const original = page.locator("#kalvoice-page-request");
  await original.focus();
  const orb = widget(page).getByRole("button", { name: "Hold to talk" });
  const bounds = await orb.boundingBox();
  if (!bounds) throw new Error("KalVoice orb has no bounds");

  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await expect(widget(page).getByText("Listening", { exact: true })).toBeVisible();
  await page.mouse.up();
  await expect(widget(page).getByText("Done", { exact: true })).toBeVisible();

  await expect(original).toHaveValue("from the orb");
});

test("a closed target fails without echoing its transcript", async ({ page }) => {
  const transcript = "private closed target phrase";
  await openKalVoice(page, transcript);
  await page.locator("#kalvoice-page-request").focus();
  await page.keyboard.down("F8");
  await expect(widget(page).getByText("Listening", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Dashboard" }).click();
  await page.keyboard.up("F8");

  await expect(widget(page).getByText("Error", { exact: true })).toBeVisible();
  await expect(
    widget(page).getByText("The text box couldn't accept the dictated text. Nothing was inserted.", { exact: true }),
  ).toBeVisible();
  await expect(widget(page).getByText(transcript, { exact: false })).toHaveCount(0);
});
