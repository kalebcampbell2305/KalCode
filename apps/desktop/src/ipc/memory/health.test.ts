import { describe, expect, it } from "vitest";
import { KalCodeClient } from "../client.ts";
import { createMemoryTransport, type MemoryScenario } from "../memoryTransport.ts";

function setup(scenario: MemoryScenario = "default") {
  const transport = createMemoryTransport(scenario, { detectDelayMs: 0 });
  return { transport, client: new KalCodeClient(transport) };
}

describe("in-memory provider health", () => {
  it("is unknown until detection runs, then follows the mock detection", async () => {
    const { client } = setup();
    const before = await client.listProviderHealth();
    expect(before.map((h) => [h.providerId, h.state, h.reasonCode])).toEqual([
      ["claude-code", "unknown", "not_checked"],
      ["codex", "unknown", "not_checked"],
      ["gemini-cli", "unknown", "not_checked"],
      ["cursor", "unknown", "not_checked"],
    ]);
    expect(before.every((h) => h.activeSessions === 0 && h.capacity === "unknown")).toBe(true);

    await client.detectProviders();
    const [claude, codex, gemini] = await client.listProviderHealth();
    expect(claude).toMatchObject({
      state: "healthy",
      activeSessions: 2,
      processRunning: true,
      recentFailures: 0,
      trend: "stable",
      recoverability: "none",
    });
    expect(claude?.latencyP50Ms).not.toBeNull();
    expect(codex).toMatchObject({
      state: "degraded",
      recentFailures: 2,
      lastFailure: { code: "turn_failed" },
      capacity: "available",
      recoverability: "restart",
      reasonCode: "recent_failures",
    });
    expect(gemini).toMatchObject({ state: "healthy", auth: "unknown", reasonCode: "auth_unknown" });
    // No invented rate limits outside the explicit backoff scenario.
    expect([claude, codex, gemini].every((h) => h?.capacity !== "backing_off" && h?.backoffUntil === null)).toBe(true);
  });

  it("records transitions after detection, once", async () => {
    const { client } = setup();
    await client.detectProviders();
    await client.detectProviders();
    const events = (await client.recentEvents(100)).filter((e) => e.type === "provider.health_changed");
    expect(events.map((e) => [e.correlation.providerId, e.payload]).reverse()).toEqual([
      ["claude-code", { providerId: "claude-code", from: "unknown", to: "healthy", reason: "auth_unknown" }],
      ["codex", { providerId: "codex", from: "unknown", to: "degraded", reason: "recent_failures" }],
      ["gemini-cli", { providerId: "gemini-cli", from: "unknown", to: "healthy", reason: "auth_unknown" }],
      ["cursor", { providerId: "cursor", from: "unknown", to: "healthy", reason: "healthy" }],
    ]);
    const capacity = (await client.recentEvents(100)).filter((e) => e.type === "provider.capacity_changed");
    expect(capacity).toHaveLength(4);
  });

  it("keeps health consistent with detection in every provider scenario", async () => {
    const none = setup("providers-none").client;
    await none.detectProviders();
    expect((await none.listProviderHealth()).map((h) => [h.state, h.recoverability, h.activeSessions])).toEqual([
      ["unavailable", "install", 0],
      ["unavailable", "install", 0],
      ["unavailable", "install", 0],
      ["unavailable", "install", 0],
    ]);
    const outdated = setup("providers-outdated").client;
    await outdated.detectProviders();
    expect(await outdated.getProviderHealth("claude-code")).toMatchObject({
      state: "unavailable",
      recoverability: "update",
      reasonCode: "outdated",
      minimumVersion: "2.1.259",
    });
    const signedOut = setup("providers-signed-out").client;
    await signedOut.detectProviders();
    expect(await signedOut.getProviderHealth("codex")).toMatchObject({
      state: "unavailable",
      recoverability: "sign_in",
      reasonCode: "signed_out",
      recentFailures: 0,
    });
  });

  it("shows a rate limit only in the explicit backoff scenario, with no retry time", async () => {
    const { client } = setup("providers-backoff");
    await client.detectProviders();
    expect(await client.getProviderHealth("codex")).toMatchObject({
      state: "degraded",
      capacity: "backing_off",
      reasonCode: "rate_limited",
      recoverability: "automatic",
      backoffUntil: null,
    });
  });

  it("returns hourly rollups, oldest first, and validates like native", async () => {
    const { client, transport } = setup();
    await client.detectProviders();
    const rollups = await client.providerHealthTrend("claude-code", 24);
    expect(rollups.length).toBeGreaterThan(2);
    const starts = rollups.map((r) => r.hourStart);
    expect([...starts].sort()).toEqual(starts);
    expect(rollups.every((r) => r.sessionsStarted > 0 || r.failures > 0)).toBe(true);
    expect((await client.providerHealthTrend("gemini-cli", 24)).length).toBe(1);
    await expect(client.getProviderHealth("other-cli")).rejects.toMatchObject({ code: "unknown_provider" });
    await expect(transport.invoke("provider_health_trend", { providerId: "codex", hours: 0 })).rejects.toMatchObject({
      code: "invalid_hours",
    });
    await expect(transport.invoke("provider_health_trend", { providerId: "codex", hours: 721 })).rejects.toMatchObject({
      code: "invalid_hours",
    });
  });

  it("can fail without affecting providers or threads", async () => {
    const { client, transport } = setup();
    transport.health.configure({ failing: true });
    await expect(client.listProviderHealth()).rejects.toMatchObject({ code: "health_unavailable" });
    expect(await client.detectProviders()).toHaveLength(4);
  });

  it("records a transition when an observation changes", async () => {
    const { client, transport } = setup();
    await client.detectProviders();
    transport.health.observe("codex", { failuresSinceSuccess: 0, recentFailures: 0, lastFailure: null });
    expect((await client.getProviderHealth("codex")).state).toBe("healthy");
    const [latest] = (await client.recentEvents(10)).filter((e) => e.type === "provider.health_changed");
    expect(latest?.payload).toEqual({ providerId: "codex", from: "degraded", to: "healthy", reason: "healthy" });
  });
});
