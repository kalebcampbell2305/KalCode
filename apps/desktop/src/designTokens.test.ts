// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The visual system is enforced, not suggested. Every UI stylesheet (desktop app, shared
 * components) takes colour, radius and text size from the tokens, so a new surface looks
 * KalCode-native by default and every appearance mode (light, dark, high contrast, text size)
 * reaches it. The marketing website keeps its cinematic treatment and is not checked here.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const STYLES = join(REPO, "packages/ui/src/styles");
const UI_ROOTS = ["apps/desktop/src", "packages/ui/src/components"];
const TOKENS = readFileSync(join(STYLES, "tokens.css"), "utf8");
const TERMINAL = readFileSync(join(STYLES, "terminal.css"), "utf8");

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path, ext);
    return ext.test(entry.name) ? [path] : [];
  });
}

const stylesheets = UI_ROOTS.flatMap((root) => walk(join(REPO, root), /\.css$/)).map((path) => ({
  file: relative(REPO, path).replaceAll("\\", "/"),
  // Comments may name colours ("navy ink on cool paper", "#05080F Space"); only declarations count.
  css: readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
}));

function offenders(pattern: RegExp, allow?: (match: string) => boolean): string[] {
  const found: string[] = [];
  for (const { file, css } of stylesheets) {
    css.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        if (!allow?.(match[0])) found.push(`${file}:${index + 1}  ${line.trim()}`);
      }
    });
  }
  return found;
}

describe("UI stylesheets use the design tokens", () => {
  it("contain no colour literals (pure black/white alpha is allowed for shadows and highlights)", () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(\s*[0-9.][^)]*\)/g;
    const blackOrWhite = (value: string) => /^rgba?\(\s*(?:0[\s,]+0[\s,]+0|255[\s,]+255[\s,]+255)\b/.test(value);
    expect(offenders(literal, blackOrWhite)).toEqual([]);
  });

  it("never hide a literal behind a var() fallback (fallbacks drift from the tokens they shadow)", () => {
    expect(offenders(/var\(\s*--[\w-]+\s*,\s*(?:#|rgba?\(|hsla?\()/g)).toEqual([]);
  });

  it("take corner radii from the radius scale", () => {
    // 1-2 px rounds tiny marks (carets, rules); anything a user reads as a shape uses a token.
    const radius = /border(?:-(?:top|bottom)-(?:left|right))?-radius:[^;]*\b(?:[3-9]|\d{2,})(?:\.\d+)?px/g;
    expect(offenders(radius)).toEqual([]);
  });

  it("size text in rem or type tokens so the Text size setting scales it", () => {
    expect(offenders(/font-size:\s*[0-9.]+px/g)).toEqual([]);
  });

  it("only reference custom properties that something defines", () => {
    const defined = new Set<string>();
    const sources = [TOKENS, TERMINAL, ...stylesheets.map((s) => s.css)];
    for (const source of sources) for (const m of source.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1] as string);
    // Properties set from components (style={{ "--x": ... }} or setProperty("--x", ...)).
    const scripts = UI_ROOTS.flatMap((root) => walk(join(REPO, root), /\.tsx?$/));
    for (const path of scripts) {
      for (const m of readFileSync(path, "utf8").matchAll(/["'`](--[\w-]+)["'`]/g)) defined.add(m[1] as string);
    }
    // Radix sets its positioning variables at runtime. An optional hook with a layout fallback
    // (`var(--rail-w, 16.5rem)`) is deliberate; colour fallbacks are refused by the rule above.
    const missing = offenders(/var\(\s*--[\w-]+\s*,?/g, (match) => {
      const name = match.replace(/^var\(\s*/, "").replace(/\s*,$/, "");
      return match.endsWith(",") || defined.has(name) || name.startsWith("--radix-");
    });
    expect(missing).toEqual([]);
  });
});

/* ---------- Token contrast: every text token stays readable on every surface ---------- */

type Palette = Record<string, string>;

function block(selector: string): Palette {
  const start = TOKENS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`tokens.css has no block for ${selector}`);
  const body = TOKENS.slice(start, TOKENS.indexOf("\n}", start));
  const palette: Palette = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) palette[m[1] as string] = m[2] as string;
  return palette;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = [
  "--color-bg",
  "--color-bg-sunken",
  "--color-surface",
  "--color-surface-raised",
  "--color-surface-overlay",
  "--color-surface-1",
  "--color-surface-2",
  "--color-surface-3",
];
const TEXT = [
  "--color-text",
  "--color-text-secondary",
  "--color-text-muted",
  "--color-text-faint",
  "--color-accent-text",
];
const STATUS_TEXT = ["working", "waiting", "muted", "done", "failed", "paused", "recovering"].map(
  (tone) => `--status-${tone}-text`,
);

const dark = block(':root,\n[data-theme="dark"]');
const light = { ...dark, ...block('[data-theme="light"]') };
const MODES: { name: string; palette: Palette; min: number; text: string[] }[] = [
  { name: "dark", palette: dark, min: 4.5, text: [...TEXT, ...STATUS_TEXT] },
  { name: "light", palette: light, min: 4.5, text: [...TEXT, ...STATUS_TEXT] },
  {
    name: "dark high contrast",
    palette: { ...dark, ...block(':root:not([data-theme="light"])[data-contrast="more"]') },
    min: 7,
    text: TEXT,
  },
  {
    name: "light high contrast",
    palette: { ...light, ...block(':root[data-theme="light"][data-contrast="more"]') },
    min: 7,
    text: TEXT,
  },
];

describe("token contrast", () => {
  for (const mode of MODES) {
    it(`${mode.name}: text tokens reach ${mode.min}:1 on every surface`, () => {
      const failures: string[] = [];
      for (const text of mode.text) {
        for (const surface of SURFACES) {
          const fg = mode.palette[text];
          const bg = mode.palette[surface];
          expect(fg, `${mode.name} defines ${text}`).toBeTruthy();
          expect(bg, `${mode.name} defines ${surface}`).toBeTruthy();
          const ratio = contrast(fg as string, bg as string);
          if (ratio < mode.min) failures.push(`${text} on ${surface}: ${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it("the dark foundation is graphite, not navy (low chroma)", () => {
    for (const surface of SURFACES) {
      const hex = dark[surface] as string;
      const [r, g, b] = [1, 3, 5].map((o) => Number.parseInt(hex.slice(o, o + 2), 16)) as [number, number, number];
      expect(Math.max(r, g, b) - Math.min(r, g, b), `${surface} ${hex}`).toBeLessThanOrEqual(10);
    }
  });

  it("every theme-specific family is defined for light as well as dark", () => {
    const families = /^--(?:chart|skeleton|empty|error|atmosphere|select-chevron|focus-ring-color|shadow-focus)/;
    const darkNames = [...TOKENS.slice(0, TOKENS.indexOf('[data-theme="light"] {')).matchAll(/(--[\w-]+):/g)]
      .map((m) => m[1] as string)
      .filter((name) => families.test(name));
    const lightBody = TOKENS.slice(TOKENS.indexOf('[data-theme="light"] {'));
    const missing = [...new Set(darkNames)].filter((name) => !lightBody.includes(`${name}:`));
    expect(missing).toEqual([]);
  });
});
