// Capture real KalCode UI plates (ui-test fixture build + capture-only film fixture patch).
// Run from apps/desktop (needs @playwright/test): node ../../launch/capture/capture.mjs <outDir> [steps]

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.env.KC_URL ?? "http://127.0.0.1:1431";
const out = process.argv[2];
const only = process.argv[3]?.split(",");
mkdirSync(out, { recursive: true });
const boxes = {};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
// Film staging: hide the unavailable Gemini CLI rows (never advertised); stop the caret blink.
const STAGE_CSS = `*{caret-color:transparent !important} .xterm-cursor-blink{animation:none !important}`;

async function open(scenario) {
  await page.goto(`${base}/?scenario=${scenario}`);
  await page.addStyleTag({ content: STAGE_CSS });
  await page.waitForTimeout(1500);
  await hideGemini();
}
async function hideGemini() {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("li, tr, [role=row], [role=listitem], section > div, article")) {
      const t = el.textContent ?? "";
      if (t.includes("Gemini CLI") && !t.includes("Claude Code") && !t.includes("Codex") && t.length < 400)
        el.style.display = "none";
    }
  });
}
async function nav(label) {
  await page.getByRole("navigation").getByText(label, { exact: true }).first().click();
  await page.waitForTimeout(1200);
  await hideGemini();
}
async function shot(name) {
  await page.screenshot({ path: `${out}/${name}.png` });
}
async function box(name, locator) {
  const b = await locator
    .first()
    .boundingBox({ timeout: 2000 })
    .catch(() => null);
  if (b) boxes[name] = b;
}
const want = (s) => !only || only.includes(s);

// 1. Dashboard
await open("threads");
if (want("dash")) {
  await shot("dash");
  await box("dash.needsYou", page.getByText("Needs you", { exact: false }));
}

// 2. Threads: Browser redesign selected, composer typing sequence
if (want("threads")) {
  await nav("Threads");
  await page.getByText("Browser redesign", { exact: true }).first().click();
  await page.waitForTimeout(800);
  await shot("threads");
  await box("threads.list", page.getByText("Recent", { exact: true }).locator(".."));
  await box("threads.composer", page.getByPlaceholder(/Message/));
  const composer = page.getByPlaceholder(/Message/).first();
  const prompt = "Finish the redesign.";
  mkdirSync(`${out}/composer`, { recursive: true });
  for (let i = 0; i <= prompt.length; i++) {
    await composer.fill(prompt.slice(0, i));
    await page.screenshot({ path: `${out}/composer/${String(i).padStart(3, "0")}.png` });
  }
  await page.keyboard.press("Control+Enter");
  mkdirSync(`${out}/sent`, { recursive: true });
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${out}/sent/${String(i).padStart(3, "0")}.png` });
  }
}

// 3. Code: terminal typing + streamed test output
if (want("code")) {
  await open("threads");
  await nav("Code");
  await page.waitForTimeout(800);
  await shot("code");
  const term = page.locator(".xterm").first();
  await term.click();
  await page.keyboard.type("cls\n");
  await page.waitForTimeout(500);
  await shot("code_clear");
  mkdirSync(`${out}/term`, { recursive: true });
  const cmd = "pnpm test";
  let n = 0;
  const f = () => `${out}/term/${String(n++).padStart(3, "0")}.png`;
  for (const ch of cmd) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(60);
    await page.screenshot({ path: f() });
  }
  await page.keyboard.press("Enter");
  for (let i = 0; i < 26; i++) {
    await page.waitForTimeout(70);
    await page.screenshot({ path: f() });
  }
  await box("code.terminal", term);
}

// 4. KalVoice listening + transcript
if (want("voice")) {
  await open("threads");
  await nav("Threads");
  await page.getByText("Browser redesign", { exact: true }).first().click();
  await page.waitForTimeout(600);
  await page.keyboard.down("F8");
  await page.waitForTimeout(900);
  await shot("voice_listen");
  await page.evaluate(() => window.__kalcodeMemory?.kalvoice?.setTranscript("Focus the Browser redesign thread."));
  await page.waitForTimeout(700);
  await shot("voice_transcript");
  await page.keyboard.up("F8");
  await page.waitForTimeout(1500);
  await shot("voice_done");
}

// 5. Providers › Accounts
if (want("providers")) {
  await nav("Providers");
  await page
    .getByRole("tab", { name: "Accounts" })
    .first()
    .click()
    .catch(() => page.getByText("Accounts", { exact: true }).first().click());
  await page.waitForTimeout(900);
  await hideGemini();
  await shot("accounts");
}

// 6. New thread: provider, account and model pickers
if (want("newthread")) {
  await nav("Threads");
  await page
    .getByRole("button", { name: /New thread/ })
    .first()
    .click();
  await page.waitForTimeout(900);
  await shot("newthread");
}

writeFileSync(`${out}/boxes.json`, JSON.stringify(boxes, null, 2));
await browser.close();
