// Deterministic render: Remotion frames (muted H.264) + the cue-driven soundtrack, muxed by FFmpeg.
//   node scripts/render.mjs --comp KalCodeLaunch --out out/kalcode_launch_60s.mp4
//   node scripts/render.mjs --comp KalCodeLaunch --preview --out build/preview.mp4   (half-res, fast)
//   node scripts/render.mjs --comp KalCodeLaunch --from 0 --to 899 --out build/proto.mp4
//   node scripts/render.mjs --comp KalCodeLaunch --chunk 300 --concurrency 3 --out out/kalcode_launch_60s.mp4
//     (low memory: resumable chunks in build/chunks/, finished ones are skipped, then joined losslessly)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i < 0 ? d : (process.argv[i + 1] ?? true);
};
const comp = arg("comp", "KalCodeLaunch");
const out = arg("out", "out/kalcode_launch_60s.mp4");
const preview = process.argv.includes("--preview");
const chunk = Number(arg("chunk", 0));
const from = Number(arg("from", 0));
const to = arg("to", null);
mkdirSync(path.dirname(out), { recursive: true });
mkdirSync("build", { recursive: true });

const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const composition = await selectComposition({ serveUrl, id: comp });
const last = to === null ? composition.durationInFrames - 1 : Number(to);
const silent = `build/${comp}_${preview ? "preview" : "master"}_video.mp4`;
const t0 = Date.now();
const renderRange = (a, b, outputLocation) =>
  renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation,
    muted: true,
    frameRange: [a, b],
    scale: preview ? 0.5 : 1,
    crf: preview ? 23 : 16,
    x264Preset: preview ? "veryfast" : "slow",
    pixelFormat: "yuv420p",
    imageFormat: preview ? "jpeg" : "png",
    jpegQuality: 90,
    concurrency: Number(arg("concurrency", Math.max(4, Math.floor(os.cpus().length * 0.75)))),
    colorSpace: "bt709",
    onProgress: ({ progress }) => {
      const pc = Math.floor(progress * 10);
      if (pc !== globalThis.__pc) {
        globalThis.__pc = pc;
        console.log(`${comp} [${a}-${b}] ${pc * 10}%`);
      }
    },
  });
if (!chunk) {
  await renderRange(from, last, silent);
} else {
  const dir = `build/chunks/${comp}_${preview ? "preview" : "master"}`;
  mkdirSync(dir, { recursive: true });
  const parts = [];
  for (let a = from; a <= last; a += chunk) {
    const b = Math.min(a + chunk - 1, last);
    const part = `${dir}/${String(a).padStart(5, "0")}-${String(b).padStart(5, "0")}.mp4`;
    parts.push(part);
    if (existsSync(part)) continue;
    globalThis.__pc = undefined;
    await renderRange(a, b, `${part}.tmp.mp4`);
    renameSync(`${part}.tmp.mp4`, part);
  }
  const list = `${dir}/concat.txt`;
  writeFileSync(list, parts.map((p) => `file '${path.resolve(p).replaceAll("\\", "/")}'`).join("\n"));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent], {
    stdio: "inherit",
  });
}
console.log(`\nframes rendered in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// audio: the master WAV (built from cue_sheet.json), trimmed to the rendered range
if (!existsSync("audio/master.wav")) execFileSync("python", ["src/audio/build_audio.py"], { stdio: "inherit" });
const ss = (from / 60).toFixed(6);
const dur = ((last - from + 1) / 60).toFixed(6);
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-i",
    silent,
    "-ss",
    ss,
    "-t",
    dur,
    "-i",
    "audio/master.wav",
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "320k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-t",
    dur,
    out,
  ],
  { stdio: "inherit" },
);
console.log(`wrote ${out}`);
