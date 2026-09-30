// Utility: survey the real KalCode UI (ui-test fixture build) so shots can be planned.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = process.env.KC_URL ?? "http://127.0.0.1:1431";
const out = process.argv[2] ?? "survey";
mkdirSync(out, { recursive: true });
const shots = (process.argv[3] ?? "code,threads,busy,approvals,kalvoice-slow,providers-backoff").split(",");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 });
for (const scenario of shots) {
  await page.goto(`${base}/?scenario=${scenario}`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${scenario}.png` });
  const nav = await page.locator("nav a, nav button").allInnerTexts().catch(() => []);
  console.log(scenario, "| nav:", nav.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" · "));
}
await browser.close();
