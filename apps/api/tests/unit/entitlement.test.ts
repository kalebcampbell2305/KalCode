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

const billing = (tier: "pro" | "max", expiresAt = "2026-10-24T12:00:00.000Z"): ActiveGrant => ({
  tier,
  source: "billing",
  expiresAt,
});
const owner: ActiveGrant = { tier: "owner", source: "grant", expiresAt: null };

describe("pickEntitlement precedence", () => {
  it("is Free without grants", () => {
    expect(pickEntitlement([])).toEqual({ tier: "free", grantExpiresAt: null });
  });

  it("prefers an owner grant over any billing grant", () => {
    expect(pickEntitlement([billing("max"), owner, billing("pro")])).toEqual({ tier: "owner", grantExpiresAt: null });
    expect(pickEntitlement([owner, billing("max")]).tier).toBe("owner");
  });

  it("prefers MAX over Pro, and the later end among equal tiers", () => {
    expect(pickEntitlement([billing("pro"), billing("max")]).tier).toBe("max");
    expect(
      pickEntitlement([billing("pro", "2026-10-01T00:00:00.000Z"), billing("pro", "2026-11-01T00:00:00.000Z")]),
    ).toEqual({ tier: "pro", grantExpiresAt: "2026-11-01T00:00:00.000Z" });
    expect(
      pickEntitlement([{ tier: "pro", source: "grant", expiresAt: null }, billing("pro")]).grantExpiresAt,
    ).toBeNull();
  });

  it("ignores an owner row that did not come from an operator grant (defence in depth)", () => {
    expect(pickEntitlement([{ tier: "owner", source: "billing", expiresAt: null }]).tier).toBe("free");
    expect(pickEntitlement([{ tier: "owner", source: "billing", expiresAt: null }, billing("pro")]).tier).toBe("pro");
  });

  it("never gives an owner entitlement an end, whatever the row says", () => {
    expect(pickEntitlement([{ tier: "owner", source: "grant", expiresAt: "2026-09-25T00:00:00.000Z" }])).toEqual({
      tier: "owner",
      grantExpiresAt: null,
    });
  });
});

describe("buildEntitlement", () => {
  it("issues an unrestricted owner document with the standard document lifetime", () => {
    const doc = buildEntitlement(ACCOUNT, { tier: "owner", grantExpiresAt: null }, NOW, "k1");
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
    expect(limitFor(doc, "concurrentThreads")).toBeNull();
  });

  it("issues the catalog grants for paid and free tiers", () => {
    const max = buildEntitlement(ACCOUNT, { tier: "max", grantExpiresAt: "2027-01-01T00:00:00.000Z" }, NOW, "k1");
    expect(max.unrestricted).toBe(false);
    expect(limitFor(max, "concurrentThreads")).toBe(20);
    expect(hasFeature(max, "advancedMissions")).toBe(true);
    const free = buildEntitlement(ACCOUNT, { tier: "free", grantExpiresAt: null }, NOW, "k1");
    expect(free.features).toEqual([]);
    expect(limitFor(free, "concurrentThreads")).toBe(2);
  });

  it("does not outlive the paid period it reflects", () => {
    const doc = buildEntitlement(ACCOUNT, { tier: "pro", grantExpiresAt: "2026-09-25T12:00:00.000Z" }, NOW, "k1");
    expect(doc.expiresAt).toBe(NOW_S + 24 * 3600);
    const ending = buildEntitlement(ACCOUNT, { tier: "pro", grantExpiresAt: "2026-09-24T12:00:00.400Z" }, NOW, "k1");
    expect(ending.expiresAt).toBe(NOW_S + 1);
    expect(parseEntitlement(ending).ok).toBe(true);
  });
});
