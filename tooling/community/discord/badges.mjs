// KalCode community badges: one medallion per badge role, drawn as SVG and rendered to PNG with resvg
// (deterministic, no browser). Used as Discord role icons (boost level 2) and as shout-out artwork.
//   node tooling/community/discord/kc-discord.mjs badges   → assets/branding/discord/badges/<key>-{256,512}.png
//
// Glyphs are from Lucide (https://lucide.dev, ISC license), the icon set the KalCode app already uses.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { BADGES } from "./server.mjs";

const GLYPHS = {
  bug: '<path d="M12 20v-9"/><path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/><path d="M14.12 3.88 16 2"/><path d="M21 21a4 4 0 0 0-3.81-4"/><path d="M21 5a4 4 0 0 1-3.55 3.97"/><path d="M22 13h-4"/><path d="M3 21a4 4 0 0 1 3.81-4"/><path d="M3 5a4 4 0 0 0 3.55 3.97"/><path d="M6 13H2"/><path d="m8 2 1.88 1.88"/><path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>',
  rocket:
    '<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09"/><path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05"/>',
  "life-buoy":
    '<circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/><circle cx="12" cy="12" r="4"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  "code-xml": '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  "chevrons-up": '<path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/>',
  medal:
    '<path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/>',
  sparkles:
    '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>',
};

/** A rounded hexagon path centred on (c, c). */
function hexPath(c, r, round) {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  });
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const t = round / r;
  let d = "";
  pts.forEach((p, i) => {
    const prev = pts[(i + 5) % 6];
    const next = pts[(i + 1) % 6];
    const a = lerp(p, prev, t);
    const b = lerp(p, next, t);
    d += `${i ? "L" : "M"}${a[0].toFixed(2)},${a[1].toFixed(2)} Q${p[0].toFixed(2)},${p[1].toFixed(2)} ${b[0].toFixed(2)},${b[1].toFixed(2)} `;
  });
  return `${d}Z`;
}

/** The badge as a 256×256 SVG on a transparent background. */
export function badgeSvg(badge) {
  const glyph = GLYPHS[badge.glyph];
  if (!glyph) throw new Error(`badge ${badge.key}: unknown glyph ${badge.glyph}`);
  const accent = badge.accent;
  const id = badge.key.replace(/[^a-z0-9]/g, "");
  const outer = hexPath(128, 118, 22);
  const inner = hexPath(128, 104, 18);
  // Veteran and Contributor get a second engraved ring: the top tiers read at a glance.
  const ring =
    badge.tier === "top"
      ? `<path d="${hexPath(128, 93, 15)}" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="2"/>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="rim${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#cfe0ff"/><stop offset="0.45" stop-color="${accent}"/><stop offset="1" stop-color="#1d3a78"/>
    </linearGradient>
    <radialGradient id="body${id}" cx="0.5" cy="0.32" r="0.8">
      <stop offset="0" stop-color="#16233d"/><stop offset="0.6" stop-color="#0b1322"/><stop offset="1" stop-color="#05080f"/>
    </radialGradient>
    <radialGradient id="glow${id}" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.45"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft${id}" filterUnits="userSpaceOnUse" x="-24" y="-24" width="72" height="72"><feGaussianBlur stdDeviation="5"/></filter>
  </defs>
  <path d="${outer}" fill="url(#rim${id})"/>
  <path d="${inner}" fill="url(#body${id})"/>
  <circle cx="128" cy="128" r="70" fill="url(#glow${id})"/>
  ${ring}
  <path d="${hexPath(128, 104, 18)}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>
  <g transform="translate(76 76) scale(4.333)" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <g stroke="${accent}" stroke-width="2.6" filter="url(#soft${id})" opacity="0.9">${glyph}</g>
    <g stroke="#f2f6fc" stroke-width="1.7">${glyph}</g>
  </g>
</svg>`;
}

export function renderBadge(badge, size) {
  return new Resvg(badgeSvg(badge), { fitTo: { mode: "width", value: size } }).render().asPng();
}

/** Writes every badge at 256 px (role icons; Discord caps them at 256 KB) and 512 px (shout-outs). */
export function writeBadges(outDir) {
  mkdirSync(outDir, { recursive: true });
  const files = [];
  for (const b of BADGES) {
    for (const size of [256, 512]) {
      const file = join(outDir, `${b.key}-${size}.png`);
      writeFileSync(file, renderBadge(b, size));
      files.push(file);
    }
  }
  return files;
}

export const badgeFile = (repoRoot, key, size = 256) =>
  join(repoRoot, "assets", "branding", "discord", "badges", `${key}-${size}.png`);
