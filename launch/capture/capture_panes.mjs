// Multi-session coding: the real Layout presets (4 panes 2 × 2, 6 panes 3 × 2) with the Claude Code and
// Codex CLIs working in KalCode terminals, plus the full Providers page (Setup, Accounts scrolled).
// Run from apps/desktop (needs @playwright/test): node ../../launch/capture/capture_panes.mjs <outDir> [steps]

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
const STAGE_CSS = `*{caret-color:transparent !important} .xterm-cursor-blink{animation:none !important}`;

async function hideGemini() {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("li, tr, [role=row], [role=listitem], section, section > div, article")) {
      const t = el.textContent ?? "";
      if (t.includes("Gemini CLI") && !t.includes("Claude Code") && !t.includes("Codex") && t.length < 600)
        el.style.display = "none";
    }
    // Setup tab: the provider card whose title is Gemini CLI
    for (const el of document.querySelectorAll("*"))
      if (el.children.length === 0 && el.textContent?.trim() === "Gemini CLI") {
        let card = el;
        while (card.parentElement && !(card.parentElement.textContent ?? "").includes("Codex")) card = card.parentElement;
        card.style.display = "none";
      }
    // the one sign-in sentence that also names Gemini CLI: keep the Claude Code / Codex half
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode())
      if (n.nodeValue.includes(", and Gemini CLI opens Google sign-in in your browser"))
        n.nodeValue = n.nodeValue.replace(", and Gemini CLI opens Google sign-in in your browser", "");
  });
}
async function open(scenario) {
  await page.goto(`${base}/?scenario=${scenario}`);
  await page.addStyleTag({ content: STAGE_CSS });
  await page.waitForTimeout(1500);
  await hideGemini();
}
async function nav(label) {
  await page.getByRole("navigation").getByText(label, { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await hideGemini();
}
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
const seqShots = async (dir, n, ms) => {
  mkdirSync(`${out}/${dir}`, { recursive: true });
  for (let i = 0; i < n; i++) {
    await page.waitForTimeout(ms);
    await page.screenshot({ path: `${out}/${dir}/${String(i).padStart(3, "0")}.png` });
  }
};

async function preset(label, file) {
  await page.getByRole("button", { name: /Layout/ }).first().click();
  await page.waitForTimeout(500);
  if (file) await shot(file);
  await page.getByText(label, { exact: false }).first().click();
  await page.waitForTimeout(900);
}

// fill every empty pane with a PowerShell terminal, then start one agent CLI in each terminal pane
async function fillPanes() {
  for (let k = 0; k < 8; k++) {
    const btn = page.getByRole("button", { name: /New PowerShell 7 terminal/ });
    if ((await btn.count()) === 0) break;
    await btn.first().click();
    await page.waitForTimeout(600);
  }
}
async function startAgents(jobs) {
  const terms = page.locator(".xterm");
  const n = await terms.count();
  for (let i = 0; i < Math.min(n, jobs.length); i++) {
    await terms.nth(i).click();
    await page.keyboard.type("cls\n");
    await page.waitForTimeout(150);
  }
  for (let i = 0; i < Math.min(n, jobs.length); i++) {
    await terms.nth(i).click();
    await page.keyboard.type(jobs[i]);
  }
  await page.mouse.move(800, 940);
  await page.waitForTimeout(400);
}
async function launchAll(jobs) {
  const terms = page.locator(".xterm");
  for (let i = 0; i < jobs.length; i++) {
    await terms.nth(i).click();
    await page.keyboard.press("Enter");
  }
  await page.mouse.move(800, 940);
}

const JOBS4 = [
  'claude "Tighten the Browser toolbar"',
  'codex "Add retry backoff to the updater"',
  'claude "Smooth the KalVoice waveform"',
  'codex "Test the download page"',
];
const JOBS6 = [
  JOBS4[0],
  JOBS4[1],
  'claude "Fix the loading bar flicker"',
  JOBS4[2],
  JOBS4[3],
  'codex "Draft the release notes"',
];

if (want("four")) {
  await open("threads");
  await nav("Code");
  await page.waitForTimeout(600);
  await preset("4 panes", "layout_menu");
  await fillPanes();
  await startAgents(JOBS4);
  await shot("four_ready");
  await launchAll(JOBS4);
  await seqShots("four", 40, 120);
}

if (want("six")) {
  await open("threads");
  await nav("Code");
  await page.waitForTimeout(600);
  await preset("6 panes", "layout_menu6");
  await fillPanes();
  await startAgents(JOBS6);
  await shot("six_ready");
  await launchAll(JOBS6);
  await seqShots("six", 44, 120);
}

if (want("providers")) {
  await open("threads");
  await nav("Providers");
  await page.getByRole("tab", { name: "Setup" }).first().click().catch(() => {});
  await page.waitForTimeout(900);
  await hideGemini();
  await shot("prov_setup");
  await page.getByRole("tab", { name: "Accounts" }).first().click();
  await page.waitForTimeout(900);
  await hideGemini();
  await page.mouse.move(1500, 600);
  // scroll the page top -> bottom in small steps
  const scroller = await page.evaluateHandle(() => {
    const all = [...document.querySelectorAll("main, main *")];
    return all.find((e) => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== "visible") ?? document.scrollingElement;
  });
  const max = await scroller.evaluate((e) => e.scrollHeight - e.clientHeight);
  mkdirSync(`${out}/prov_scroll`, { recursive: true });
  const N = 30;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await scroller.evaluate((el, y) => (el.scrollTop = y), Math.round(e * max));
    await page.waitForTimeout(60);
    await page.screenshot({ path: `${out}/prov_scroll/${String(i).padStart(3, "0")}.png` });
  }
  console.log("providers scroll max", max);
}

await browser.close();
