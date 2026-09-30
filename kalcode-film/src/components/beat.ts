// The picture's view of the music. Kicks, claps and impacts are derived from the SAME
// cue_sheet.json blocks the score uses (src/audio/score.py kick_times / clap_times), so
// camera punches and light flashes land on the exact sample of each hit.
import cueJson from "../../cue_sheet.json";

type Drum = { start: number; end: number; kick: "four" | "half"; clap: boolean; hats: boolean };
const cue = cueJson as unknown as { drums: Drum[]; impacts: number[]; fps: number; blur?: [number, number][] };
const FPS = 60;

const kicks: number[] = [];
const claps: number[] = [];
for (const d of cue.drums) {
  const step = d.kick === "four" ? 0.5 : 1.0;
  for (let t = d.start; t < d.end - 1e-9; t += step) kicks.push(Math.round(t * FPS));
  if (d.clap)
    for (let t = d.start; t < d.end - 1e-9; t += 0.5)
      if (Math.round(t / 0.5) % 2 === 1) claps.push(Math.round(t * FPS));
}
const impacts = cue.impacts.map((t) => Math.round(t * FPS));

const lastBefore = (list: number[], frame: number) => {
  let best = -1e9;
  for (const f of list) if (f <= frame && f > best) best = f;
  return best;
};

/** 1 on the hit, decaying exponentially (tau in frames). */
const env = (list: number[], frame: number, tau: number) => {
  const d = frame - lastBefore(list, frame);
  return d < 0 || d > tau * 8 ? 0 : Math.exp(-d / tau);
};

export const kickEnv = (frame: number) => env(kicks, frame, 5);
export const clapEnv = (frame: number) => env(claps, frame, 7);
export const impactEnv = (frame: number) => env(impacts, frame, 10);
export const KICKS = kicks;
export const IMPACTS = impacts;

/** Frames where the whole picture is rendered with sub-frame motion blur. */
export const BLUR_WINDOWS: [number, number][] = (cue.blur ?? []).map(([a, b]) => [
  Math.round(a * FPS),
  Math.round(b * FPS),
]);
export const inBlur = (frame: number) => BLUR_WINDOWS.some(([a, b]) => frame >= a && frame < b);
