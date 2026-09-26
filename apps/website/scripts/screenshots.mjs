#!/usr/bin/env node
/**
 * Visual QA: full-page screenshots of key pages at desktop and phone widths in both themes.
 *
 *   node scripts/screenshots.mjs [baseUrl] [outDir] [--pages=/,/pricing] [--widths=1440,390]
 *
 * Defaults: http://127.0.0.1:8787 → qa/screenshots. Theme is forced by emulating the OS
 * colour scheme (the site's default "system" preference follows it).
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];

const base = positional[0] ?? "http://127.0.0.1:8787";
const outDir = resolve(positional[1] ?? "qa/screenshots");
const pages = (flag("pages") ?? "/,/product,/kalvoice,/pricing,/download,/docs,/updates,/privacy").split(",");
const widths = (flag("widths") ?? "1440,390").split(",").map(Number);
const themes = (flag("themes") ?? "dark,light").split(",");
const fullPage = flag("full") !== "false";

const slug = (path) => (path === "/" ? "home" : path.replace(/^\//, "").replaceAll("/", "-"));

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const width of widths) {
    for (const theme of themes) {
      const context = await browser.newContext({
        viewport: { width, height: width < 800 ? 844 : 900 },
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      for (const path of pages) {
        await page.goto(new URL(path, base).href, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const file = resolve(outDir, `${slug(path)}-${width}-${theme}.png`);
        await page.screenshot({ path: file, fullPage });
        console.log(file);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
