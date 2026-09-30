// Normalizes and validates cue_sheet.json — the single source of timing truth.
// Authors write `t` (seconds). This fills bar/beat/frame/sample and fails if any event is off
// the 16th-note grid or any scene boundary is off a bar line.
//   node scripts/cues.mjs
import { readFileSync, writeFileSync } from "node:fs";

const path = new URL("../cue_sheet.json", import.meta.url);
const cue = JSON.parse(readFileSync(path, "utf8"));
const { bpm, fps, sampleRate } = cue;
const beatS = 60 / bpm;
const errors = [];

const stamp = (t, what, grid = beatS / 4) => {
  const q = t / grid;
  if (Math.abs(q - Math.round(q)) > 1e-9) errors.push(`${what}: t=${t} is not on the ${grid}s grid`);
  const beats = t / beatS;
  return {
    t,
    bar: Math.floor(beats / 4) + 1,
    beat: +((beats % 4) + 1).toFixed(4),
    frame: Math.round(t * fps),
    sample: Math.round(t * sampleRate),
  };
};

cue.scenes = cue.scenes.map((s) => {
  const a = typeof s.start === "number" ? s.start : s.start.t;
  const b = typeof s.end === "number" ? s.end : s.end.t;
  return { ...s, start: stamp(a, `scene ${s.id} start`, beatS * 4), end: stamp(b, `scene ${s.id} end`, beatS * 4) };
});
for (let i = 1; i < cue.scenes.length; i++)
  if (cue.scenes[i].start.t !== cue.scenes[i - 1].end.t) errors.push(`scene gap before ${cue.scenes[i].id}`);
if (cue.scenes.at(-1).end.t !== cue.duration) errors.push("last scene must end at duration");

const ids = new Set();
cue.events = cue.events
  .map((e) => {
    if (ids.has(e.id)) errors.push(`duplicate event ${e.id}`);
    ids.add(e.id);
    const { bar, beat, frame, sample, ...rest } = e;
    return { ...rest, ...stamp(e.t, `event ${e.id}`) };
  })
  .sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
writeFileSync(path, `${JSON.stringify(cue, null, 2)}\n`);
console.log(`cue_sheet.json OK: ${cue.scenes.length} scenes, ${cue.events.length} events`);
