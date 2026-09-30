// New thread pickers (real <select> state changes) and a clean Browser pane + site at pane size.

import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.env.KC_URL ?? "http://127.0.0.1:1431";
const out = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(`${base}/?scenario=threads`);
await page.addStyleTag({ content: "*{caret-color:transparent !important}" });
await page.waitForTimeout(1500);
// New thread: Claude Code, account Work, model Opus, task typed
await page.getByRole("navigation").getByText("Threads", { exact: true }).first().click();
await page.waitForTimeout(700);
await page
  .getByRole("button", { name: /New thread/ })
  .first()
  .click();
await page.waitForTimeout(800);
const combos = page.getByRole("combobox");
await page.screenshot({ path: `${out}/nt_0.png` });
await combos
  .nth(1)
  .selectOption({ label: "Work" })
  .catch((_e) => {});
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/nt_1.png` });
await combos
  .nth(2)
  .selectOption({ label: "Opus" })
  .catch((_e) => {});
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/nt_2.png` });
const task = page.getByPlaceholder(/Describe what you want done/);
const words = "Smooth the KalVoice waveform while it listens.";
mkdirSync(`${out}/nt_type`, { recursive: true });
for (let i = 0; i <= words.length; i += 2) {
  await task.fill(words.slice(0, i));
  await page.screenshot({ path: `${out}/nt_type/${String(i / 2).padStart(3, "0")}.png` });
}
// Browser pane, clean
await page.getByRole("navigation").getByText("Code", { exact: true }).first().click();
await page.waitForTimeout(900);
await page.locator(".xterm").first().click();
await page.keyboard.press("Control+Alt+D");
await page.waitForTimeout(900);
await page
  .getByRole("button", { name: /add|open here|new tab/i })
  .last()
  .click();
await page.waitForTimeout(400);
await page
  .getByRole("menuitem", { name: /^Browser/ })
  .first()
  .click();
await page.waitForTimeout(1800);
const vp = await page.evaluate(() => {
  const msg = [...document.querySelectorAll("*")].find(
    (e) => e.textContent?.trim() === "KalCode couldn't open this browser pane.",
  );
  const region = msg?.parentElement;
  if (region) region.style.visibility = "hidden";
  for (const el of document.querySelectorAll("div, span, footer"))
    if ((el.textContent ?? "").trim().startsWith("Couldn't open") && el.children.length < 6)
      el.style.visibility = "hidden";
  const input = [...document.querySelectorAll("input")].find((i) => i.value.startsWith("http://localhost"));
  if (input)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
      input,
      "http://localhost:4321/download",
    );
  const r = region?.parentElement?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
});
await page.keyboard.press("Escape");
await page.mouse.move(700, 600);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/code_browser_clean.png` });
// the page itself at the pane's viewport size
const site = await ctx.newPage();
await site.setViewportSize({ width: Math.round(vp.w), height: Math.round(vp.h) });
await site.goto("https://kalcoded.com/download", { waitUntil: "networkidle" });
await site.waitForTimeout(1500);
await site.screenshot({ path: `${out}/site_download_pane.png` });
await browser.close();
