// KalVoice sequences: hold F8, the fixture recognizer "hears" ?transcript=, release, result.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = process.env.KC_URL ?? "http://127.0.0.1:1431";
const out = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

async function run(name, surface, transcript, select) {
  const dir = `${out}/${name}`;
  mkdirSync(dir, { recursive: true });
  await page.goto(`${base}/?scenario=threads&transcript=${encodeURIComponent(transcript)}`);
  await page.addStyleTag({ content: "*{caret-color:transparent !important}" });
  await page.waitForTimeout(1500);
  await page.getByRole("navigation").getByText(surface, { exact: true }).first().click();
  await page.waitForTimeout(900);
  if (select) {
    await page.getByText(select, { exact: true }).first().click();
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: `${dir}/before.png` });
  await page.keyboard.down("F8");
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(90);
    await page.screenshot({ path: `${dir}/listen_${String(i).padStart(3, "0")}.png` });
  }
  await page.keyboard.up("F8");
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(110);
    await page.screenshot({ path: `${dir}/after_${String(i).padStart(3, "0")}.png` });
  }
}

// On Threads with a different thread selected, so the focus move is visible.
await run("v_focus", "Threads", "Focus the Browser redesign thread.", "Updater retry");
await run("v_tell", "Threads", "Tell it to finish the redesign.", "Browser redesign");
await run("v_approve", "Dashboard", "What needs my approval?", null);
await browser.close();
console.log("voice done");
