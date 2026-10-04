import type { ITheme } from "@xterm/xterm";

/**
 * Terminal palettes, derived from the design tokens (packages/ui/src/styles/tokens.css).
 *
 * Dark: Starlight text on the graphite code background (#0A0B0E), accents from Constellation, status
 * hues from the success / waiting / danger tokens, lifted for text on near-black.
 * Light: navy ink on the white surface, every hue darkened until it reads as text.
 *
 * Every foreground colour meets WCAG AA (4.5:1) against its background — except dark "black",
 * which programs use as a background colour. `MINIMUM_CONTRAST` makes xterm.js lift any
 * foreground/background pair a program chooses that would fall below AA.
 */
export const MINIMUM_CONTRAST = 4.5;

const MONO_FALLBACK = "ui-monospace, Consolas, monospace";
let monoFontCache: string | null = null;

/**
 * The terminal font stack from `--font-mono`, read once (getComputedStyle forces a style
 * recalculation, and every terminal mount asked several times). A fallback is never cached, so a
 * read before the stylesheet applies doesn't stick; a theme change invalidates the cache.
 */
export function monoFontFamily(): string {
  if (monoFontCache) return monoFontCache;
  const value =
    typeof document === "undefined"
      ? ""
      : getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  if (!value) return MONO_FALLBACK;
  monoFontCache = value;
  return value;
}

/** Forget the cached font stack (the theme or font tokens changed). */
export function invalidateMonoFontFamily(): void {
  monoFontCache = null;
}

export const TERMINAL_THEMES: Record<"dark" | "light", Required<Pick<ITheme, PaletteKey>> & ITheme> = {
  dark: {
    background: "#0a0b0e",
    foreground: "#e3e7ee",
    cursor: "#8db6ff",
    cursorAccent: "#0a0b0e",
    selectionBackground: "rgba(76, 141, 255, 0.32)",
    selectionInactiveBackground: "rgba(180, 195, 225, 0.18)",
    scrollbarSliderBackground: "rgba(180, 195, 225, 0.18)",
    scrollbarSliderHoverBackground: "rgba(180, 195, 225, 0.3)",
    scrollbarSliderActiveBackground: "rgba(180, 195, 225, 0.4)",
    black: "#2b3039",
    red: "#f0707a",
    green: "#43cf93",
    yellow: "#efb84f",
    blue: "#5f9bff",
    magenta: "#c595f0",
    cyan: "#4ccbd9",
    white: "#bcc3cf",
    brightBlack: "#828b9b",
    brightRed: "#ff959d",
    brightGreen: "#74e3b0",
    brightYellow: "#ffd580",
    brightBlue: "#91b8ff",
    brightMagenta: "#dcb6ff",
    brightCyan: "#87e3ee",
    brightWhite: "#f3f5f8",
  },
  light: {
    background: "#ffffff",
    foreground: "#131c2e",
    cursor: "#1d5be0",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(29, 91, 224, 0.2)",
    selectionInactiveBackground: "rgba(16, 32, 64, 0.1)",
    scrollbarSliderBackground: "rgba(16, 32, 64, 0.16)",
    scrollbarSliderHoverBackground: "rgba(16, 32, 64, 0.26)",
    scrollbarSliderActiveBackground: "rgba(16, 32, 64, 0.34)",
    black: "#131c2e",
    red: "#c0263a",
    green: "#0b774f",
    yellow: "#875600",
    blue: "#1d57d8",
    magenta: "#8a37b3",
    cyan: "#086f80",
    white: "#5b6880",
    brightBlack: "#5f6a80",
    brightRed: "#9e1a2d",
    brightGreen: "#07613f",
    brightYellow: "#6b4400",
    brightBlue: "#1343a8",
    brightMagenta: "#6c2393",
    brightCyan: "#055866",
    brightWhite: "#37445a",
  },
};

export type PaletteKey =
  | "background"
  | "foreground"
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
