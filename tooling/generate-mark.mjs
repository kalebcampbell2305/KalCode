// Generates the KalCode constellation-globe mark (detailed + small variants).
// Geometry is derived from the brand reference: a dotted globe with a K constellation.
// Usage: node tooling/generate-mark.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const out = (name) => fileURLToPath(new URL(`../packages/ui/src/brand/${name}`, import.meta.url));
const f = (n) => Number(n.toFixed(2));

// Deterministic PRNG so the mark is stable across runs.
let seed = 7;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const C = 50;
const R = 44;
const tilt = 0.38; // radians, tips the north pole toward the viewer

// Fibonacci sphere, rotated, keep front hemisphere, orthographic projection.
function sphereDots(count) {
  const dots = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i + 0.9;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const y2 = y * Math.cos(tilt) - z * Math.sin(tilt);
    const z2 = y * Math.sin(tilt) + z * Math.cos(tilt);
    if (z2 <= 0.02) continue;
    const j = 0.9 * (1 - z2 * 0.5);
    dots.push({ x: C + x * R + (rand() - 0.5) * j, y: C - y2 * R + (rand() - 0.5) * j, z: z2 });
  }
  return dots;
}

const K = {
  nodes: [
    [38.5, 24.5, 1.55],
    [38.5, 46, 1.9],
    [38.5, 72.5, 1.55],
    [44, 42, 0.95],
    [59.5, 31, 1.3],
    [74.5, 21, 1.55],
    [51, 55.8, 1.2],
    [68.5, 71, 1.55],
  ],
  paths: ["M38.5 24.5V72.5", "M38.5 46 44 42l15.5-11 15-10", "M38.5 46 51 55.8 68.5 71"],
};

const dots = sphereDots(520);

// Faint network: connect a sparse subset of dots to a near neighbour.
const links = [];
for (let i = 0; i < dots.length; i += 9) {
  const a = dots[i];
  let best = null;
  let bestD = Infinity;
  for (let j = 0; j < dots.length; j++) {
    if (j === i) continue;
    const b = dots[j];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d > 5 && d < 16 && d < bestD && rand() > 0.35) {
      best = b;
      bestD = d;
    }
  }
  if (best) links.push(`M${f(a.x)} ${f(a.y)}L${f(best.x)} ${f(best.y)}`);
}

const dotMarkup = dots
  .map((d) => {
    const size = 0.22 + d.z * 0.38 + (rand() > 0.93 ? 0.35 : 0);
    const alpha = 0.18 + d.z * 0.62;
    return `<circle cx="${f(d.x)}" cy="${f(d.y)}" r="${f(size)}" fill-opacity="${f(alpha)}"/>`;
  })
  .join("");

const detailed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" role="img" aria-label="KalCode">
<defs>
<radialGradient id="kcg" cx="40%" cy="36%" r="72%"><stop offset="0" stop-color="#10254a"/><stop offset=".6" stop-color="#07122a"/><stop offset="1" stop-color="#040915"/></radialGradient>
<radialGradient id="kcr" cx="50%" cy="50%" r="50%"><stop offset=".8" stop-color="#3f7fff" stop-opacity="0"/><stop offset=".95" stop-color="#4c8dff" stop-opacity=".38"/><stop offset="1" stop-color="#a9c9ff" stop-opacity=".85"/></radialGradient>
<filter id="kcglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>
<circle cx="${C}" cy="${C}" r="${R}" fill="url(#kcg)"/>
<g stroke="#7fb0ff" stroke-opacity=".16" stroke-width=".28">${links.map((d) => `<path d="${d}"/>`).join("")}</g>
<g fill="#cfe0ff">${dotMarkup}</g>
<circle cx="${C}" cy="${C}" r="${R}" fill="url(#kcr)"/>
<g filter="url(#kcglow)">
<g stroke="#e8f0ff" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round">${K.paths.map((d) => `<path d="${d}"/>`).join("")}</g>
<g fill="#ffffff">${K.nodes.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join("")}</g>
</g>
</svg>
`;

// Small variant (favicons, ≤48px): no dot field, heavier strokes, crisp rim.
const small = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" role="img" aria-label="KalCode">
<defs><radialGradient id="kcs" cx="40%" cy="36%" r="72%"><stop offset="0" stop-color="#153063"/><stop offset="1" stop-color="#050b19"/></radialGradient></defs>
<circle cx="50" cy="50" r="46" fill="url(#kcs)"/>
<circle cx="50" cy="50" r="44.5" stroke="#5b97ff" stroke-width="3"/>
<g stroke="#eef4ff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M37 24v52"/><path d="M37 49 72 22"/><path d="M37 49l33 27"/></g>
<g fill="#ffffff"><circle cx="37" cy="24" r="5.5"/><circle cx="37" cy="76" r="5.5"/><circle cx="72" cy="22" r="5.5"/><circle cx="70" cy="76" r="5.5"/><circle cx="37" cy="49" r="6"/></g>
</svg>
`;

writeFileSync(out("mark.svg"), detailed);
writeFileSync(out("mark-small.svg"), small);
console.log(`mark.svg: ${dots.length} dots, ${links.length} links; mark-small.svg written`);
