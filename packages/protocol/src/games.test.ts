import { describe, expect, it } from "vitest";
import {
  GAME_LICENSE_MAX_LIFETIME_SECONDS,
  GAME_LICENSE_TTL_SECONDS,
  GAME_PERK_MAX_TOTAL_CENTS,
  GAME_PERKS,
  GAMES,
  type GameLicense,
  formatGamePrice,
  getGame,
  higherPerkTier,
  KAL_UNIVERSITY,
  parseGameLicense,
  perksAddedAt,
  perksThroughTier,
  perkTierForPlan,
} from "./games.ts";
import { getPlan, PLANS } from "./plans.ts";

const T0 = 1_790_000_000;
const SUBJECT = "A".repeat(43);

function license(overrides: Partial<Record<keyof GameLicense, unknown>> = {}): Record<string, unknown> {
  return {
    version: 1,
    gameId: "kal_university",
    subject: SUBJECT,
    source: "pro",
    perkTier: "pro",
    perks: [{ id: "ku_pro_start_cash", kind: "wallet", ref: "", amountCents: 5000 }],
    device: null,
    issuedAt: T0,
    expiresAt: T0 + GAME_LICENSE_TTL_SECONDS,
    keyId: "g2026-10",
    ...overrides,
  };
}

describe("game catalog", () => {
  it("sells KAL University for $9.99 standalone and includes it with every paid KalCode plan", () => {
    expect(KAL_UNIVERSITY.standalonePriceCents).toBe(999);
    expect(KAL_UNIVERSITY.standalonePriceUsd).toBe(9.99);
    expect(formatGamePrice(KAL_UNIVERSITY)).toBe("$9.99");
    expect(formatGamePrice({ standalonePriceUsd: 5 })).toBe("$5");
    expect(formatGamePrice({ standalonePriceUsd: 9.99 })).toBe("$9.99");
    expect(KAL_UNIVERSITY.includedWithPlans).toEqual(["pro", "max", "max2x"]);
    expect(getGame("kal_university")).toBe(KAL_UNIVERSITY);
    expect(GAMES.map((game) => game.id)).toEqual(["kal_university"]);
  });

  it("never changes or duplicates the KalCode plan prices", () => {
    // Update 3: existing KalCode subscription prices stay exactly as they are.
    expect(PLANS.map((plan) => [plan.id, plan.price.monthlyUsd, plan.price.yearlyUsd])).toEqual([
      ["free", 0, 0],
      ["pro", 10, 100],
      ["max", 25, 250],
      ["max2x", 50, 500],
    ]);
    for (const plan of KAL_UNIVERSITY.includedWithPlans) expect(getPlan(plan).price.monthlyUsd).toBeGreaterThan(0);
  });

  it("is truthfully coming soon until a tested build can be bought", () => {
    expect(KAL_UNIVERSITY.status).toBe("coming_soon");
    expect(KAL_UNIVERSITY.platforms.every((platform) => platform.status === "coming_soon")).toBe(true);
  });
});

describe("perk catalog", () => {
  it("has unique ids and only well-formed items", () => {
    expect(new Set(GAME_PERKS.map((perk) => perk.id)).size).toBe(GAME_PERKS.length);
    for (const perk of GAME_PERKS) {
      expect(perk.id).toMatch(/^[a-z0-9_]{1,64}$/);
      if (perk.kind === "wallet") {
        expect(perk.ref).toBe("");
        expect(perk.amountCents).toBeGreaterThan(0);
      } else {
        expect(perk.ref).toMatch(/^[a-z0-9_]{1,64}$/);
        expect(perk.amountCents).toBe(0);
      }
    }
  });

  it("gives standalone the complete game and nothing extra", () => {
    expect(perksThroughTier("kal_university", "standalone")).toEqual([]);
  });

  it("is cumulative and grows strictly with the tier", () => {
    const counts = (["standalone", "pro", "max", "max2x"] as const).map(
      (tier) => perksThroughTier("kal_university", tier).length,
    );
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(new Set(counts).size).toBe(4);
    const added = perksAddedAt("kal_university", "max").map((perk) => perk.id);
    expect(perksThroughTier("kal_university", "max").map((perk) => perk.id)).toEqual([
      ...perksAddedAt("kal_university", "pro").map((perk) => perk.id),
      ...added,
    ]);
  });

  it("keeps starting cash modest", () => {
    const cash = perksThroughTier("kal_university", "max2x").reduce((sum, perk) => sum + perk.amountCents, 0);
    expect(cash).toBe(15_000);
    expect(cash).toBeLessThanOrEqual(GAME_PERK_MAX_TOTAL_CENTS);
  });

  it("maps plans to perk tiers, OWNER as MAX 2X", () => {
    expect(perkTierForPlan("free")).toBe("standalone");
    expect(perkTierForPlan("pro")).toBe("pro");
    expect(perkTierForPlan("max2x")).toBe("max2x");
    expect(perkTierForPlan("owner")).toBe("max2x");
    expect(higherPerkTier("max", "pro")).toBe("max");
    expect(higherPerkTier("standalone", "max2x")).toBe("max2x");
  });
});

describe("parseGameLicense", () => {
  it("accepts a well-formed license", () => {
    const parsed = parseGameLicense(license());
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["version", { version: 2 }],
    ["unknown game", { gameId: "other" }],
    ["subject", { subject: "short" }],
    ["source", { source: "free" }],
    ["perk tier", { perkTier: "owner" }],
    ["perks not a list", { perks: {} }],
    ["perk kind", { perks: [{ id: "x", kind: "gems", ref: "", amountCents: 1 }] }],
    ["wallet with ref", { perks: [{ id: "x", kind: "wallet", ref: "acc_watch", amountCents: 1 }] }],
    ["cosmetic with cash", { perks: [{ id: "x", kind: "wardrobe", ref: "acc_watch", amountCents: 5 }] }],
    [
      "duplicate perk",
      {
        perks: [
          { id: "ku_pro_start_cash", kind: "wallet", ref: "", amountCents: 5000 },
          { id: "ku_pro_start_cash", kind: "wallet", ref: "", amountCents: 5000 },
        ],
      },
    ],
    ["too much cash", { perks: [{ id: "x", kind: "wallet", ref: "", amountCents: GAME_PERK_MAX_TOTAL_CENTS + 1 }] }],
    ["device", { device: "nope" }],
    ["times", { expiresAt: T0 }],
    ["lifetime", { expiresAt: T0 + GAME_LICENSE_MAX_LIFETIME_SECONDS + 1 }],
    ["key id", { keyId: "Bad Key" }],
  ])("rejects a bad %s", (_name, overrides) => {
    expect(parseGameLicense(license(overrides as Partial<Record<keyof GameLicense, unknown>>)).ok).toBe(false);
  });
});
