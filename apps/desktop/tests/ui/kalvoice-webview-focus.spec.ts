import { expect, type Page, test } from "@playwright/test";

async function open(page: Page) {
  await page.goto("/?transcript=dashboard");
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "KalVoice", exact: true })
    .click();
  const field = page.locator("#kalvoice-page-request");
  await field.fill("Original");
  await field.focus();
  return field;
}

async function keySignal(page: Page, type: "keydown" | "keyup") {
  // Model a native shortcut signal while this webview's DOM does not have focus.
  // Browser keyboard automation would itself reactivate the page before sending the key.
  await page.evaluate(
    (eventType) =>
      window.dispatchEvent(
        new KeyboardEvent(eventType, {
          key: "F8",
          code: "F8",
          bubbles: true,
        }),
      ),
    type,
  );
}

async function blurSignal(page: Page) {
  // Headless Chromium keeps each page notionally focused. Model the main-webview event
  // boundary explicitly; this is not a claim about physical WKWebView event ordering.
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
    window.dispatchEvent(new FocusEvent("blur"));
    // An element focusout microtask arriving after window blur must not revive the old target.
    document.activeElement?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

test("a native capture after the webview blur signal cannot reuse the retained DOM field", async ({ page }) => {
  const field = await open(page);
  await blurSignal(page);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("kalvoice-page-request");
  await keySignal(page, "keydown");
  await expect(
    page.getByRole("region", { name: "KalVoice widget" }).getByText("Listening", { exact: true }),
  ).toBeVisible();
  await keySignal(page, "keyup");
  // With no focused dictation target, this low-confidence surface name is a local command.
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "dashboard");
  await expect(field).toHaveCount(0);
});

test("webview blur preserves the immutable target of capture already in progress", async ({ page }) => {
  const field = await open(page);
  await keySignal(page, "keydown");
  await expect(
    page.getByRole("region", { name: "KalVoice widget" }).getByText("Listening", { exact: true }),
  ).toBeVisible();
  await blurSignal(page);
  // The memory transport, like native top-level focus handling, finishes an active recording on blur.
  await expect(field).toHaveValue("Original dashboard");
  await expect(page.locator("#main")).toHaveAttribute("data-surface", "kalvoice");
});

test("webview focus restores the retained field without another element focusin", async ({ page }) => {
  const field = await open(page);
  await blurSignal(page);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hasFocus");
    window.dispatchEvent(new FocusEvent("focus"));
  });
  await keySignal(page, "keydown");
  await keySignal(page, "keyup");
  await expect(field).toHaveValue("Original dashboard");
});
