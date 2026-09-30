// Browser pane (real Code canvas pane) + the live kalcoded.com pages it shows.

import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.env.KC_URL ?? "http://127.0.0.1:1431";
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

await page.goto(`${base}/?scenario=threads`);
await page.waitForTimeout(1500);
await page.getByRole("navigation").getByText("Code", { exact: true }).first().click();
await page.waitForTimeout(1000);
// Split the canvas, then use the new pane's add menu ("+" in its tab strip) to open a Browser pane.
await page.locator(".xterm").first().click();
await page.keyboard.press("Control+Alt+D");
await page.waitForTimeout(900);
const adds = page.getByRole("button", { name: /add|open here|new tab/i });
await adds
  .last()
  .click()
  .catch((_e) => {});
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/code_menu.png` });
const item = page.getByRole("menuitem", { name: /^Browser/ }).first();
if (await item.count()) {
  await item.click();
  await page.waitForTimeout(2000);
}
await page.screenshot({ path: `${out}/code_browser.png` });
// Film staging: the ui-test build has no native web view. Clear its error so the live page can be
// composited into the viewport, and show the local site preview address.
const _vp = await page.evaluate(() => {
  const hide = (txt) => {
    for (const el of document.querySelectorAll("div, p, span, footer")) {
      if ((el.textContent ?? "").trim().startsWith(txt) && el.children.length < 6) {
        el.style.visibility = "hidden";
        return true;
      }
    }
    return false;
  };
  const msg = [...document.querySelectorAll("*")].find(
    (e) => e.textContent?.trim() === "KalCode couldn't open this browser pane.",
  );
  const region = msg?.parentElement;
  if (region) region.style.visibility = "hidden";
  hide("Couldn't open");
  const input = [...document.querySelectorAll("input")].find((i) => i.value.startsWith("http://localhost"));
  if (input) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(input, "http://localhost:4321/download");
  }
  const r = region?.parentElement?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
});
await page.mouse.move(5, 900);
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/code_browser_clean.png` });
await browser.close();
process.exit(0);
const site = await ctx.newPage();
for (const [name, url] of [
  ["site_home", "https://kalcoded.com/"],
  ["site_download", "https://kalcoded.com/download"],
]) {
  await site.goto(url, { waitUntil: "networkidle" });
  await site.waitForTimeout(1500);
  await site.screenshot({ path: `${out}/${name}.png` });
}
await browser.close();
