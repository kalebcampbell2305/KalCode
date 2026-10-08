import {
  ENTITLEMENT_DOCUMENT_TTL_SECONDS,
  hasFeature,
  limitFor,
  parseEntitlement,
} from "@kalcode/protocol/entitlements";
import { describe, expect, it } from "vitest";
import { buildEntitlement, pickEntitlement } from "../../worker/lib/entitlement";
import type { ActiveGrant } from "../../worker/lib/store";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const ACCOUNT = "0b6f1c1e-5a39-4d0c-9a0f-2b1f7d9e4c11";

const GRANTED = "2026-09-01T00:00:00.000Z";
const billing = (tier: "pro" | "max" | "max2x", expiresAt = "2026-10-24T12:00:00.000Z"): ActiveGrant => ({
  tier,
  source: "billing",
  grantedAt: GRANTED,
  expiresAt,
});
const owner: ActiveGrant = { tier: "owner", source: "grant", grantedAt: GRANTED, expiresAt: null };

describe("pickEntitlement precedence", () => {
  it("is Free without grants", () => {
    expect(pickEntitlement([])).toEqual({ tier: "free", grantExpiresAt: null, billingAnchor: null });
  });

  it("prefers an owner grant over any billing grant", () => {
    expect(pickEntitlement([billing("max"), owner, billing("pro")])).toEqual({
      tier: "owner",
      grantExpiresAt: null,
      billingAnchor: null,
    });
    expect(pickEntitlement([owner, billing("max")]).tier).toBe("owner");
  });

  it("prefers MAX 2X over MAX over Pro, and the later end among equal tiers", () => {
    expect(pickEntitlement([billing("max"), billing("max2x"), billing("pro")]).tier).toBe("max2x");
    expect(pickEntitlement([billing("pro"), billing("max")]).tier).toBe("max");
    expect(
      pickEntitlement([billing("pro", "2026-10-01T00:00:00.000Z"), billing("pro", "2026-11-01T00:00:00.000Z")]),
    ).toEqual({ tier: "pro", grantExpiresAt: "2026-11-01T00:00:00.000Z", billingAnchor: GRANTED });
    const operatorPro: ActiveGrant = { tier: "pro", source: "grant", grantedAt: GRANTED, expiresAt: null };
    expect(pickEntitlement([operatorPro, billing("pro")])).toEqual({
      tier: "pro",
      grantExpiresAt: null,
      billingAnchor: null,
    });
  });

  it("ignores an owner row that did not come from an operator grant (defence in depth)", () => {
    const billedOwner: ActiveGrant = { tier: "owner", source: "billing", grantedAt: GRANTED, expiresAt: null };
    expect(pickEntitlement([billedOwner]).tier).toBe("free");
    expect(pickEntitlement([billedOwner, billing("pro")]).tier).toBe("pro");
  });

  it("never gives an owner entitlement an end, whatever the row says", () => {
    expect(
      pickEntitlement([{ tier: "owner", source: "grant", grantedAt: GRANTED, expiresAt: "2026-09-25T00:00:00.000Z" }]),
    ).toEqual({ tier: "owner", grantExpiresAt: null, billingAnchor: null });
  });
});

describe("buildEntitlement", () => {
  it("issues an unrestricted owner document with the standard document lifetime", () => {
    const doc = buildEntitlement(ACCOUNT, { tier: "owner", grantExpiresAt: null, billingAnchor: null }, NOW, "k1");
    expect(doc).toEqual({
      version: 1,
      accountId: ACCOUNT,
      tier: "owner",
      unrestricted: true,
      features: [],
      limits: {},
      issuedAt: NOW_S,
      expiresAt: NOW_S + ENTITLEMENT_DOCUMENT_TTL_SECONDS,
      keyId: "k1",
    });
    expect(parseEntitlement(doc).ok).toBe(true);
    expect(hasFeature(doc, "anythingAddedLater")).toBe(true);
    expect(limitFor(doc, "parallelAgents")).toBeNull();
    expect(limitFor(doc, "kalvoiceRequestsPerMonth")).toBeNull();
  });

  it("issues the catalog grants for paid and free tiers", () => {
    const max2x = buildEntitlement(
      ACCOUNT,
      { tier: "max2x", grantExpiresAt: "2027-01-01T00:00:00.000Z", billingAnchor: GRANTED },
      NOW,
      "k1",
    );
    expect(limitFor(max2x, "kalvoiceRequestsPerMonth")).toBe(1_000);
    expect(limitFor(max2x, "parallelAgents")).toBeNull();
    expect(limitFor(max2x, "openTerminals")).toBeNull();
    expect(hasFeature(max2x, "advancedMissions")).toBe(true);
    const max = buildEntitlement(
      ACCOUNT,
      { tier: "max", grantExpiresAt: "2027-01-01T00:00:00.000Z", billingAnchor: GRANTED },
      NOW,
      "k1",
    );
    expect(max.unrestricted).toBe(false);
    expect(max.limits).toEqual({
      kalvoiceRequestsPerMonth: 500,
      openTerminals: null,
      parallelAgents: null,
      workspaces: null,
      providerAccounts: 12,
      brainstormsPerMonth: null,
      launchRecipes: null,
      externalIntegrations: 25,
      operationsHistoryDays: 365,
      queuedTasks: null,
    });
    expect(hasFeature(max, "advancedMissions")).toBe(true);
    const free = buildEntitlement(ACCOUNT, { tier: "free", grantExpiresAt: null, billingAnchor: null }, NOW, "k1");
    expect(free.limits).toEqual({
      kalvoiceRequestsPerMonth: 25,
      openTerminals: null,
      parallelAgents: null,
      workspaces: null,
      providerAccounts: 2,
      brainstormsPerMonth: 3,
      launchRecipes: 1,
      externalIntegrations: 1,
      operationsHistoryDays: null,
      queuedTasks: 3,
    });
    expect(limitFor(free, "concurrentThreads")).toBe(0);
    const pro = buildEntitlement(
      ACCOUNT,
      { tier: "pro", grantExpiresAt: "2027-01-01T00:00:00.000Z", billingAnchor: GRANTED },
      NOW,
      "k1",
    );
    expect(limitFor(pro, "kalvoiceRequestsPerMonth")).toBe(150);
    expect(limitFor(pro, "parallelAgents")).toBeNull();
  });

  it("does not outlive the paid period it reflects", () => {
    const doc = buildEntitlement(
      ACCOUNT,
      { tier: "pro", grantExpiresAt: "2026-09-25T12:00:00.000Z", billingAnchor: GRANTED },
      NOW,
      "k1",
    );
    expect(doc.expiresAt).toBe(NOW_S + 24 * 3600);
    const ending = buildEntitlement(
      ACCOUNT,
      { tier: "pro", grantExpiresAt: "2026-09-24T12:00:00.400Z", billingAnchor: GRANTED },
      NOW,
      "k1",
    );
    expect(ending.expiresAt).toBe(NOW_S + 1);
    expect(parseEntitlement(ending).ok).toBe(true);
  });
});
