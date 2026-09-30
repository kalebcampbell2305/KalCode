// Captures for acts 3-7: live Dashboard, Approvals, Notifications, New thread pickers,
// workspace switcher, terminal naming + git push, accounts, Browser pane.

import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.env.KC_URL ?? "http://127.0.0.1:1431";
const out = process.argv[2];
const only = process.argv[3]?.split(",");
const want = (s) => !only || only.includes(s);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const CSS = "*{caret-color:transparent !important}";

async function open(scenario = "threads") {
  await page.goto(`${base}/?scenario=${scenario}`);
  await page.addStyleTag({ content: CSS });
  await page.waitForTimeout(1500);
  await hideGemini();
}
async function hideGemini() {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("li, tr, [role=row], [role=listitem], section > div, article, div")) {
      const t = el.textContent ?? "";
      if (t.includes("Gemini CLI") && !t.includes("Claude Code") && !t.includes("Codex") && t.length < 300)
        el.style.display = "none";
    }
  });
}
async function nav(label) {
  await page.getByRole("navigation").getByText(label, { exact: true }).first().click();
  await page.waitForTimeout(1100);
  await hideGemini();
}
async function seq(dir, n, ms, name = "") {
  mkdirSync(`${out}/${dir}`, { recursive: true });
  for (let i = 0; i < n; i++) {
    await page.screenshot({ path: `${out}/${dir}/${name}${String(i).padStart(3, "0")}.png` });
    await page.waitForTimeout(ms);
  }
}
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });

if (want("dashlive")) {
  // Live Dashboard: Codex asks to build; approving it moves the card from Needs you to Working.
  await open();
  await seq("dashlive", 6, 100, "a");
  const card = page.locator("article, [class*=card], [class*=Card]").filter({ hasText: "Download page copy" }).first();
  await card
    .getByRole("button", { name: /^Approve$/ })
    .first()
    .click()
    .catch((_e) => {});
  await page.waitForTimeout(300);
  await seq("dashlive", 6, 100, "b");
  await shot("dash_approve_menu");
  const once = page.getByRole("button", { name: /Approve once/ }).first();
  if (await once.count()) await once.click();
  else
    await page
      .getByRole("menuitem", { name: /Approve once|Approve/ })
      .first()
      .click()
      .catch(() => {});
  await seq("dashlive", 30, 110, "c");
}

if (want("approvals")) {
  await open();
  await nav("Approvals");
  await shot("approvals");
}
if (want("notifications")) {
  await open();
  await nav("Notifications");
  await shot("notifications");
}
if (want("newthread")) {
  await open();
  await nav("Threads");
  await page
    .getByRole("button", { name: /New thread/ })
    .first()
    .click();
  await page.waitForTimeout(900);
  await shot("nt_base");
  const _selects = page.locator("select");
  const _combos = page.getByRole("combobox");
}
if (want("switch")) {
  await open();
  await nav("Code");
  await page
    .getByRole("button", { name: /Switch workspace/ })
    .first()
    .click();
  await page.waitForTimeout(700);
  await shot("switch_ws");
  await page.keyboard.press("Escape");
}
if (want("terminals")) {
  await open();
  await nav("Code");
  await page.getByRole("button", { name: "New terminal" }).first().click();
  await page.waitForTimeout(1200);
  await shot("term_second");
  await page.locator(".xterm").last().click();
  await page.keyboard.type("git push");
  await page.keyboard.press("Enter");
  await seq("push", 14, 110);
}
if (want("accounts")) {
  await open();
  await nav("Providers");
  await page.getByText("Accounts", { exact: true }).first().click();
  await page.waitForTimeout(900);
  await hideGemini();
  await page.mouse.wheel(0, 380);
  await page.waitForTimeout(600);
  await shot("accounts_scrolled");
}
await browser.close();
