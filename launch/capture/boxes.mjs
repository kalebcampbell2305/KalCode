// Measure UI element rectangles (CSS px; plates are DPR 2) for Blender overlay alignment.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const base = process.env.KC_URL ?? "http://127.0.0.1:1431";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const boxes = {};
const rectOf = (sel) =>
  page.evaluate((sel) => {
    const pick = () => {
      if (sel.text) {
        const all = [...document.querySelectorAll("body *")].filter((e) => e.children.length === 0 && e.textContent?.trim() === sel.text);
        const el = all[sel.nth ?? 0];
        return sel.up ? el?.closest(sel.up) : el;
      }
      return document.querySelector(sel.css);
    };
    const r = pick()?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  }, sel);

await page.goto(`${base}/?scenario=threads`);
await page.waitForTimeout(1500);
boxes.sidebar = await rectOf({ css: "aside" });
boxes.nav = await rectOf({ css: "nav" });
boxes.pill = await rectOf({ text: "Ready", up: "div[class*=pill], div[class*=Pill], div[class*=bar], header div" });
boxes.logo = await rectOf({ css: "aside svg, aside img" });
boxes.dash_card_needs = await rectOf({ text: "Download page copy", up: "article, li, [class*=card], [class*=Card]" });
boxes.dash_card_browser = await rectOf({ text: "Browser redesign", up: "article, li, [class*=card], [class*=Card]" });
boxes.dash_card_updater = await rectOf({ text: "Updater retry", up: "article, li, [class*=card], [class*=Card]" });
await page.getByRole("navigation").getByText("Threads", { exact: true }).first().click();
await page.waitForTimeout(900);
for (const name of ["Browser redesign", "Updater retry", "KalVoice waveform", "Download page copy", "Release notes"]) {
  boxes[`row:${name}`] = await rectOf({ text: name, up: "button, a, li, [role=option], [class*=row], [class*=Row]" });
}
boxes.thread_list = await rectOf({ text: "Recent", up: "section, aside, div[class*=list], div[class*=List]" });
boxes.thread_detail = await rectOf({ text: "Interrupt", up: "section, article, main > div" });
boxes.composer = await rectOf({ css: "textarea" });
await page.getByRole("navigation").getByText("Code", { exact: true }).first().click();
await page.waitForTimeout(900);
boxes.terminal = await rectOf({ css: ".xterm" });
boxes.code_canvas = await rectOf({ css: ".xterm" }).then(async () => rectOf({ text: "PowerShell 7", up: "section, [class*=pane], [class*=Pane]" }));
writeFileSync(process.argv[2], JSON.stringify(boxes, null, 2));
console.log(JSON.stringify(boxes));
await browser.close();
