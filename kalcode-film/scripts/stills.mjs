// Render review stills at given seconds and tile them into one sheet.
//   node scripts/stills.mjs <comp> <out.png> 6.2 7 8.8 ...

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const [comp, out, ...secs] = process.argv.slice(2);
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const composition = await selectComposition({ serveUrl, id: comp });
mkdirSync("build/stills", { recursive: true });
const files = [];
for (const s of secs) {
  const f = `build/stills/${comp}_${s}.png`;
  await renderStill({ composition, serveUrl, output: f, frame: Math.round(Number(s) * 60) });
  files.push(f);
}
execFileSync("python", ["scripts/sheet.py", out, ...files], { stdio: "inherit" });
