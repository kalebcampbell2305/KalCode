import { describe, expect, it } from "vitest";
import {
  ENTITLEMENT_DOCUMENT_TTL_SECONDS,
  ENTITLEMENT_MAX_DOCUMENT_LIFETIME_SECONDS,
  ENTITLEMENT_TIERS,
  type Entitlement,
  FEATURES,
  hasFeature,
  LIMITS,
  limitFor,
  parseEntitlement,
  tierGrants,
} from "./entitlements.ts";
import { getPlan, OWNER_LIMITS, PLANS } from "./plans.ts";

const T0 = 1_790_000_000;

function doc(overrides: Partial<Record<keyof Entitlement, unknown>> = {}): Record<string, unknown> {
  return {
    version: 1,
    accountId: "0b6f1c1e-5a39-4d0c-9a0f-2b1f7d9e4c11",
    tier: "pro",
    unrestricted: false,
    features: ["persistentAgents"],
    limits: { concurrentThreads: 8 },
    issuedAt: T0,
    expiresAt: T0 + ENTITLEMENT_DOCUMENT_TTL_SECONDS,
    keyId: "k2026-10",
    ...overrides,
  };
}

describe("owner tier", () => {
  it("is an entitlement tier but never part of the public catalog", () => {
    expect(ENTITLEMENT_TIERS).toContain("owner");
    const ids: readonly string[] = PLANS.map((plan) => plan.id);
    expect(ids).not.toContain("owner");
    expect(
      PLANS.some((plan) => /owner/i.test(`${plan.id} ${plan.name} ${plan.tagline} ${plan.cardFeatures.join(" ")}`)),
    ).toBe(false);
    // @ts-expect-error — owner is not a purchasable plan id
    expect(() => getPlan("owner")).toThrow(/Unknown plan/);
  });

  it("is unrestricted and enumerates nothing", () => {
    const owner = tierGrants("owner");
    expect(owner).toEqual({ unrestricted: true, features: [], limits: {} });
  });

  it("grants every current feature and unlimited limits, including KalVoice Requests", () => {
    const owner = tierGrants("owner");
    expect(limitFor(owner, "kalvoiceRequestsPerMonth")).toBeNull();
    // The display description of OWNER in plans.ts agrees with the evaluator.
    expect(OWNER_LIMITS.kalvoiceRequestsPerMonth).toBeNull();
    expect(OWNER_LIMITS.parallelAgents).toBeNull();
    for (const feature of FEATURES) expect(hasFeature(owner, feature)).toBe(true);
    for (const limit of LIMITS) expect(limitFor(owner, limit)).toBeNull();
  });

  it("grants features and limits that do not exist yet, by construction", () => {
    const owner = tierGrants("owner");
    expect(hasFeature(owner, "featureAddedInTheFuture")).toBe(true);
    expect(limitFor(owner, "limitAddedInTheFuture")).toBeNull();
    // Even a document whose lists are empty or hostile cannot restrict an unrestricted grant.
    expect(hasFeature({ unrestricted: true, features: [], limits: { concurrentThreads: 0 } }, "x")).toBe(true);
    expect(limitFor({ unrestricted: true, features: [], limits: { concurrentThreads: 0 } }, "concurrentThreads")).toBe(
      null,
    );
  });
});

describe("restricted tiers", () => {
  it("derive their grants from the public plan catalog", () => {
    for (const plan of PLANS) {
      const grants = tierGrants(plan.id);
      expect(grants.unrestricted).toBe(false);
      for (const limit of LIMITS) expect(limitFor(grants, limit)).toBe(plan.limits[limit]);
      expect(hasFeature(grants, "persistentAgents")).toBe(plan.limits.persistentAgents);
      expect(hasFeature(grants, "advancedMissions")).toBe(plan.limits.advancedMissions);
    }
    expect(limitFor(tierGrants("free"), "kalvoiceRequestsPerMonth")).toBe(25);
    expect(limitFor(tierGrants("pro"), "kalvoiceRequestsPerMonth")).toBe(150);
    expect(limitFor(tierGrants("max"), "kalvoiceRequestsPerMonth")).toBe(500);
    expect(limitFor(tierGrants("max2x"), "kalvoiceRequestsPerMonth")).toBe(1000);
    expect(limitFor(tierGrants("free"), "openTerminals")).toBeNull();
    expect(limitFor(tierGrants("max"), "workspaces")).toBeNull();
    expect(limitFor(tierGrants("max2x"), "parallelAgents")).toBeNull();
    expect(tierGrants("free").features).toEqual([]);
    expect(tierGrants("pro").features).toEqual([]);
    expect(tierGrants("max").features).toEqual(["multiAgentWorkflows", "advancedMissions"]);
    expect(tierGrants("max2x").features).toEqual([...FEATURES]);
  });

  it("ignores obsolete cached local terminal and coding-agent caps", () => {
    const legacy = {
      unrestricted: false,
      features: [],
      limits: { openTerminals: 4, parallelAgents: 1, workspaces: 2 },
    };
    expect(limitFor(legacy, "openTerminals")).toBeNull();
    expect(limitFor(legacy, "parallelAgents")).toBeNull();
    expect(limitFor(legacy, "workspaces")).toBe(2);
  });

  it("fail closed for unknown features and missing limits", () => {
    const max = tierGrants("max");
    expect(hasFeature(max, "featureAddedInTheFuture")).toBe(false);
    expect(limitFor(max, "limitAddedInTheFuture")).toBe(0);
    // Prototype keys are not limits.
    expect(limitFor(max, "constructor")).toBe(0);
    expect(hasFeature(max, "constructor")).toBe(false);
  });

  it("treat an explicit null limit as unlimited", () => {
    expect(
      limitFor({ unrestricted: false, features: [], limits: { concurrentThreads: null } }, "concurrentThreads"),
    ).toBe(null);
  });
});

describe("parseEntitlement", () => {
  it("accepts a well-formed document and ignores unknown fields", () => {
    const parsed = parseEntitlement({ ...doc(), addedLater: true });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).not.toHaveProperty("addedLater");
  });

  it("accepts an owner document", () => {
    expect(parseEntitlement(doc({ tier: "owner", unrestricted: true, features: [], limits: {} })).ok).toBe(true);
  });

  it.each([
    ["non-object", null],
    ["wrong version", doc({ version: 2 })],
    ["unknown tier", doc({ tier: "enterprise" })],
    ["empty account", doc({ accountId: "" })],
    ["unrestricted non-owner", doc({ unrestricted: true })],
    ["restricted owner", doc({ tier: "owner", unrestricted: false })],
    ["string unrestricted", doc({ unrestricted: "true" })],
    ["non-array features", doc({ features: "persistentAgents" })],
    ["non-string feature", doc({ features: [1] })],
    ["negative limit", doc({ limits: { concurrentThreads: -1 } })],
    ["fractional limit", doc({ limits: { concurrentThreads: 1.5 } })],
    ["string limit", doc({ limits: { concurrentThreads: "8" } })],
    ["expires before issued", doc({ expiresAt: T0 })],
    ["lifetime too long", doc({ expiresAt: T0 + ENTITLEMENT_MAX_DOCUMENT_LIFETIME_SECONDS + 1 })],
    ["fractional time", doc({ issuedAt: T0 + 0.5 })],
    ["bad key id", doc({ keyId: "../etc" })],
  ])("rejects %s", (_name, value) => {
    expect(parseEntitlement(value).ok).toBe(false);
  });
});
