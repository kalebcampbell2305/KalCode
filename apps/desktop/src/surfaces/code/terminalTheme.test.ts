import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contrast,
  invalidateMonoFontFamily,
  MINIMUM_CONTRAST,
  monoFontFamily,
  type PaletteKey,
  TERMINAL_THEMES,
} from "./terminalTheme.ts";

/**
 * The shared terminal palette (website stage + desktop): packages/ui/src/styles/terminal.css,
 * found by walking up from the working directory (vitest runs from the package or the repo root).
 */
function readSharedTerminalCss(): string {
  const relative = join("packages", "ui", "src", "styles", "terminal.css");
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    if (dirname(dir) === dir) throw new Error(`${relative} not found above ${process.cwd()}`);
  }
}
const TERMINAL_CSS = readSharedTerminalCss();

/** The custom properties declared in the first rule whose selector matches. */
function cssBlock(selector: RegExp): Record<string, string> {
  const match = selector.exec(TERMINAL_CSS);
  if (!match) throw new Error(`terminal.css: no rule matching ${selector}`);
  const start = TERMINAL_CSS.indexOf("{", match.index) + 1;
  const body = TERMINAL_CSS.slice(start, TERMINAL_CSS.indexOf("}", start));
  const vars: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (name && value) vars[name] = value.trim().toLowerCase();
  }
  return vars;
}

const CSS_NAME: Record<PaletteKey | "cursor", string> = {
  background: "--term-bg",
  foreground: "--term-fg",
  cursor: "--term-cursor",
  black: "--term-black",
  red: "--term-red",
  green: "--term-green",
  yellow: "--term-yellow",
  blue: "--term-blue",
  magenta: "--term-magenta",
  cyan: "--term-cyan",
  white: "--term-white",
  brightBlack: "--term-bright-black",
  brightRed: "--term-bright-red",
  brightGreen: "--term-bright-green",
  brightYellow: "--term-bright-yellow",
  brightBlue: "--term-bright-blue",
  brightMagenta: "--term-bright-magenta",
  brightCyan: "--term-bright-cyan",
  brightWhite: "--term-bright-white",
};

const TEXT_COLOURS: PaletteKey[] = [
  "foreground",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

describe("terminal palettes", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`every ${theme} text colour meets WCAG AA on the ${theme} background`, () => {
      const palette = TERMINAL_THEMES[theme];
      const failing = TEXT_COLOURS.map((key) => [key, contrast(palette[key], palette.background)] as const).filter(
        ([, ratio]) => ratio < 4.5,
      );
      expect(failing).toEqual([]);
    });

    it(`the ${theme} default text is comfortably above AAA`, () => {
      const palette = TERMINAL_THEMES[theme];
      expect(contrast(palette.foreground, palette.background)).toBeGreaterThanOrEqual(12);
    });
  }

  it("light black is usable as text; dark black is a background colour lifted by the contrast floor", () => {
    expect(contrast(TERMINAL_THEMES.light.black, TERMINAL_THEMES.light.background)).toBeGreaterThan(7);
    expect(MINIMUM_CONTRAST).toBeGreaterThanOrEqual(4.5);
  });

  it("is the shared terminal palette: every colour equals packages/ui terminal.css in both themes", () => {
    const css = {
      dark: cssBlock(/:root,\s*\[data-theme="dark"\]\s*\{/),
      light: cssBlock(/\[data-theme="light"\]\s*\{/),
    };
    for (const theme of ["dark", "light"] as const) {
      const palette = TERMINAL_THEMES[theme];
      const mismatches = (Object.keys(CSS_NAME) as (keyof typeof CSS_NAME)[])
        .map((key) => [key, String(palette[key]).toLowerCase(), css[theme][CSS_NAME[key]]] as const)
        .filter(([, app, shared]) => app !== shared);
      expect(mismatches, `${theme} palette differs from terminal.css`).toEqual([]);
    }
  });

  it("computes WCAG contrast", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast("#777777", "#777777")).toBe(1);
  });
});

describe("terminal font stack", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--font-mono");
    invalidateMonoFontFamily();
    vi.restoreAllMocks();
  });

  it("reads --font-mono once per theme, never caching the fallback", () => {
    invalidateMonoFontFamily();
    expect(monoFontFamily()).toBe("ui-monospace, Consolas, monospace");
    document.documentElement.style.setProperty("--font-mono", "Mono A, monospace");
    const read = vi.spyOn(window, "getComputedStyle");
    expect(monoFontFamily()).toBe("Mono A, monospace");
    expect(monoFontFamily()).toBe("Mono A, monospace");
    expect(read).toHaveBeenCalledTimes(1);
    document.documentElement.style.setProperty("--font-mono", "Mono B, monospace");
    expect(monoFontFamily()).toBe("Mono A, monospace");
    invalidateMonoFontFamily();
    expect(monoFontFamily()).toBe("Mono B, monospace");
  });
});
