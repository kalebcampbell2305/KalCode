// Live Dashboard: prompts sent to two threads, then the Dashboard records their status changes.

import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.env.KC_URL ?? "http://127.0.0.1:1431";
const out = process.argv[2];
mkdirSync(`${out}/dashlive2`, { recursive: true });
const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2 })
).newPage();
await page.goto(`${base}/?scenario=threads`);
await page.addStyleTag({ content: "*{caret-color:transparent !important}" });
await page.waitForTimeout(1500);
const hide = () =>
  page.evaluate(() => {
    for (const el of document.querySelectorAll("div, li, article")) {
      const t = el.textContent ?? "";
      if (t.includes("Gemini CLI") && !t.includes("Claude Code") && !t.includes("Codex") && t.length < 300)
        el.style.display = "none";
    }
  });
await page.getByRole("navigation").getByText("Threads", { exact: true }).first().click();
await page.waitForTimeout(800);
for (const [name, prompt] of [
  ["KalVoice waveform", "Add a test for the waveform easing."],
  ["Updater retry", "Also log the retry reason."],
]) {
  await page.getByText(name, { exact: true }).first().click();
  await page.waitForTimeout(500);
  await page
    .getByPlaceholder(/Message/)
    .first()
    .fill(prompt);
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(250);
}
await page.getByRole("navigation").getByText("Dashboard", { exact: true }).first().click();
for (let i = 0; i < 48; i++) {
  await hide();
  await page.screenshot({ path: `${out}/dashlive2/${String(i).padStart(3, "0")}.png` });
  await page.waitForTimeout(120);
}
await browser.close();
