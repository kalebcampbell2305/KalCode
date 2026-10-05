import { expect, type Page, test } from "@playwright/test";

async function openCode(page: Page) {
  await page.goto("/?scenario=code");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "kalcode-site", exact: true })).toBeVisible();
}

async function imageBytes(page: Page) {
  return Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 48;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No canvas");
      context.fillStyle = "#408cff";
      context.fillRect(0, 0, 64, 48);
      return canvas.toDataURL("image/png").split(",")[1] ?? "";
    }),
    "base64",
  );
}

test("image picker inserts a path without submitting and preserves the shell", async ({ page }, testInfo) => {
  await openCode(page);
  const terminal = page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows');
  const before = await terminal.innerText();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach image", exact: true }).click();
  await (await chooser).setFiles({ name: "screenshot.png", mimeType: "image/png", buffer: await imageBytes(page) });
  await expect(terminal).toContainText("/ui-test-only/terminal-images/");
  await expect(terminal).not.toContainText("not recognized");
  expect((await terminal.innerText()).split("PS ").length).toBe(before.split("PS ").length);
  await expect(page.getByRole("button", { name: "Attach image", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("code-image-attachment.png") });
  await page.keyboard.press("Control+c");
  await page.keyboard.type("echo still-here");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("still-here");
});

test("clipboard image paste attaches while ordinary text paste stays native", async ({ page }) => {
  await openCode(page);
  const png = (await imageBytes(page)).toString("base64");
  const input = page.locator('[role="tabpanel"]:not([hidden]) .xterm-helper-textarea');
  await input.evaluate((element, base64) => {
    const clipboard = new DataTransfer();
    clipboard.items.add(
      new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], "clipboard.png", { type: "image/png" }),
    );
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, png);
  const terminal = page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows');
  await expect(terminal).toContainText("/ui-test-only/terminal-images/");
  await page.keyboard.press("Control+c");
  await input.evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "echo normal-paste");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("normal-paste");
});

for (const provider of ["Claude Code", "Codex", "Gemini CLI"]) {
  test(`${provider} pane accepts the image without submitting a prompt`, async ({ page }) => {
    await openCode(page);
    await page.getByRole("button", { name: "Agent launch options", exact: true }).click();
    const launcher = page.getByRole("dialog", { name: "New agent" });
    // The launcher lists accounts grouped by provider; picking one picks its provider.
    await launcher.getByRole("group", { name: provider, exact: true }).getByRole("option").first().click();
    if (provider === "Gemini CLI") {
      await launcher.getByRole("button", { name: "Reconnect" }).click();
    } else {
      await launcher.getByRole("button", { name: `Launch ${provider} agent`, exact: true }).click();
    }
    await expect(launcher).not.toBeVisible();
    await expect(page.locator("[data-provider-pane]")).toHaveCount(1);
    const providerPane = page.locator("[data-provider-pane]").first();
    await expect(providerPane.locator(".xterm-rows")).toContainText("KalCode fake provider");
    await expect(providerPane.locator("[data-pane-status]")).toHaveText(/^(READY|IDLE)$/);
    const activePane = providerPane.locator("xpath=ancestor::*[@data-pane-id][1]");
    const chooser = page.waitForEvent("filechooser");
    await activePane.getByRole("button", { name: "Attach image", exact: true }).click();
    await (await chooser).setFiles({ name: "agent.png", mimeType: "image/png", buffer: await imageBytes(page) });
    await expect(providerPane.locator(".xterm-rows")).toContainText("/ui-test-only/terminal-images/");
    await expect(providerPane.locator("[data-pane-status]")).toHaveText(/^(READY|IDLE)$/);
  });
}

test("invalid image gives an actionable error and keeps the terminal ready", async ({ page }) => {
  await openCode(page);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach image", exact: true }).click();
  await (await chooser).setFiles({ name: "bad.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
  await expect(page.getByText("Couldn't attach image", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Attach image", exact: true })).toBeEnabled();
  await expect(page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows')).not.toContainText("/ui-test-only/");
});

test("JPEG decoding works with the shipping image CSP and WebView fallback", async ({ page }) => {
  await openCode(page);
  const jpeg = await page.evaluate(() => {
    Object.defineProperty(window, "createImageBitmap", { configurable: true, value: undefined });
    const policy = document.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = "img-src 'self' data:";
    document.head.append(policy);
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 24;
    return canvas.toDataURL("image/jpeg").split(",")[1] ?? "";
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach image", exact: true }).click();
  await (await chooser).setFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpeg, "base64") });
  await expect(page.locator('[role="tabpanel"]:not([hidden]) .xterm-rows')).toContainText(
    "/ui-test-only/terminal-images/",
  );
  await expect(page.getByText("Couldn't attach image", { exact: true })).toHaveCount(0);
});
