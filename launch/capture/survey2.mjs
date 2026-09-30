// Utility: visit surfaces of the real KalCode UI (ui-test fixture build) for shot planning.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = process.env.KC_URL ?? "http://127.0.0.1:1431";
const out = process.argv[2];
mkdirSync(out, { recursive: true });
// scenario:NavLabel pairs
const plan = (process.argv[3] ?? "code:Code,threads:Threads,kalvoice-slow:KalVoice,providers-backoff:Providers,threads:Code").split(",");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
for (const item of plan) {
  const [scenario, nav] = item.split(":");
  await page.goto(`${base}/?scenario=${scenario}`);
  await page.waitForTimeout(1500);
  await page.getByRole("navigation").getByText(nav, { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${out}/${scenario}-${nav}.png` });
  console.log("ok", scenario, nav);
}
await browser.close();
