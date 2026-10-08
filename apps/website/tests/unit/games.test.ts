import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KAL_UNIVERSITY } from "@kalcode/protocol/games";
import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatUserCode,
  isCompleteUserCode,
  ownershipLabel,
  parseReturn,
  returnUrl,
  serializeReturn,
} from "../../src/lib/games-client";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("game account helpers", () => {
  it("formats user codes as the API issues them", () => {
    expect(formatUserCode("bcdf ghjk")).toBe("BCDF-GHJK");
    expect(formatUserCode("BCD")).toBe("BCD");
    expect(formatUserCode("b-c-d-f-g-h-j-k-l-m")).toBe("BCDF-GHJK");
    // Vowels and look-alikes are not in the alphabet and are dropped.
    expect(formatUserCode("AEIO0U1")).toBe("");
    expect(isCompleteUserCode("BCDF-GHJK")).toBe(true);
    expect(isCompleteUserCode("BCDF-GHJ")).toBe(false);
  });

  it("only returns to a known game page, for a short while", () => {
    const now = 1_800_000_000_000;
    const raw = serializeReturn("/games/activate", "BCDF-GHJK", now);
    expect(parseReturn(raw, now + 60_000)).toEqual({ path: "/games/activate", code: "BCDF-GHJK" });
    expect(returnUrl({ path: "/games/activate", code: "BCDF-GHJK" })).toBe("/games/activate?code=BCDF-GHJK");
    expect(parseReturn(raw, now + 31 * 60_000)).toBeNull();
    expect(parseReturn(JSON.stringify({ path: "https://evil.example/", at: now }), now)).toBeNull();
    expect(parseReturn("not json", now)).toBeNull();
    expect(parseReturn(serializeReturn("/games/library", "nope", now), now)).toEqual({ path: "/games/library", code: null });
  });

  it("labels ownership truthfully and formats sizes", () => {
    expect(ownershipLabel("standalone")).toBe("Bought on its own");
    expect(ownershipLabel("max2x")).toBe("Included with KalCode MAX 2X");
    expect(formatBytes(1_234_000_000)).toBe("1.2 GB");
    expect(formatBytes(0)).toBe("");
  });
});

describe("KAL University page truth (Update 3)", () => {
  const page = source("src/pages/games/kal-university.astro");

  it("no longer claims the game is separate from KalCode plans or needs no account", () => {
    expect(page).not.toMatch(/separate from KalCode/);
    expect(page).not.toMatch(/isn't included in any KalCode plan/);
    expect(page).not.toMatch(/price isn't set/i);
  });

  it("takes prices and perks from the protocol catalogs and keeps buying disabled while coming soon", () => {
    expect(KAL_UNIVERSITY.status).toBe("coming_soon");
    expect(page).toContain('from "@kalcode/protocol/games"');
    expect(page).toContain("perksAddedAt(KAL_UNIVERSITY.id, id)");
    expect(page).not.toMatch(/\$10\/|\$25\/|\$50\//);
    expect(page).toMatch(/<button class="cf-soon cf-soon--row cf-own__action" type="button" disabled>/);
    expect(page).toContain('id="own"');
  });

  it("keeps the private game pages honest about what they decide", () => {
    for (const path of ["src/pages/games/library.astro", "src/pages/games/activate.astro"]) {
      const text = source(path);
      expect(text).toContain("credentials: \"include\"");
      expect(text).not.toMatch(/localStorage\.setItem\([^)]*(owned|license|tier)/i);
    }
  });
});
