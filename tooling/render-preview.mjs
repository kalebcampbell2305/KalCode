// Renders an SVG to PNG for visual review: node tooling/render-preview.mjs <in.svg> <out.png> <width> [bg] [color]
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const [input, output, width = "512", background, color] = process.argv.slice(2);
let svg = readFileSync(input, "utf8");
if (color) svg = svg.replaceAll("currentColor", color);
const png = new Resvg(svg, {
  fitTo: { mode: "width", value: Number(width) },
  background,
}).render().asPng();
writeFileSync(output, png);
console.log(`wrote ${output}`);
