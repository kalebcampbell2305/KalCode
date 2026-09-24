import { describe, expect, it } from "vitest";
import { contrast, MINIMUM_CONTRAST, type PaletteKey, TERMINAL_THEMES } from "./terminalTheme.ts";

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

  it("computes WCAG contrast", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast("#777777", "#777777")).toBe(1);
  });
});
