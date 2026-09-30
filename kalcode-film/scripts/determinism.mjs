// Frames rendered independently must match the film: render each frame twice as a standalone
// still (must be byte-identical pixels) and compare with the same frame decoded from the master.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

const frames = [400, 1500, 2800, 3500];
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const composition = await selectComposition({ serveUrl, id: "KalCodeLaunch" });
for (const f of frames) {
  for (const k of ["a", "b"]) await renderStill({ composition, serveUrl, frame: f, output: `build/det_${f}_${k}.png` });
  execFileSync("ffmpeg", [
    "-loglevel",
    "error",
    "-y",
    "-i",
    "out/kalcode_launch_60s.mp4",
    "-vf",
    `trim=start_frame=${f}`,
    "-frames:v",
    "1",
    `build/det_${f}_film.png`,
  ]);
}
execFileSync("python", ["scripts/det_compare.py", ...frames.map(String)], { stdio: "inherit" });
