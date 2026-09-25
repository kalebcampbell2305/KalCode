import { describe, expect, it } from "vitest";
import { KalCodeClient } from "./client.ts";
import { createMemoryTransport, type MemoryScenario } from "./memoryTransport.ts";

const client = (scenario: MemoryScenario = "default") =>
  new KalCodeClient(createMemoryTransport(scenario, { detectDelayMs: 0 }));

describe("memory transport providers", () => {
  it("lists every provider unchecked, then detects them", async () => {
    const c = client();
    const cached = await c.listProviders();
    expect(cached.map((s) => [s.id, s.detection])).toEqual([
      ["claude-code", null],
      ["codex", null],
      ["gemini-cli", null],
    ]);
    const detected = await c.detectProviders();
    expect(detected.map((s) => [s.id, s.detection?.state, s.detection?.version, s.detection?.auth])).toEqual([
      ["claude-code", "installed", "2.1.282", "authenticated"],
      ["codex", "installed", "0.155.1", "authenticated"],
      ["gemini-cli", "installed", "0.12.0", "unknown"],
    ]);
    expect(detected.map((s) => s.adapter)).toEqual(["implemented", "implemented", "implemented"]);
    expect(await c.listProviders()).toEqual(detected);
  });

  it("records provider.detected on the first detection only", async () => {
    const c = client();
    await c.detectProviders();
    await c.detectProviders();
    const events = (await c.recentEvents(50)).filter((e) => e.type === "provider.detected");
    expect(events.map((e) => [e.correlation.providerId, e.payload])).toEqual([
      ["gemini-cli", { providerId: "gemini-cli", installed: true, version: "0.12.0" }],
      ["codex", { providerId: "codex", installed: true, version: "0.155.1" }],
      ["claude-code", { providerId: "claude-code", installed: true, version: "2.1.282" }],
    ]);
  });

  it("marks the Providers surface available", async () => {
    const boot = await client().boot();
    expect(boot.info.flags.surfaces.find((s) => s.id === "providers")?.state).toBe("available");
  });

  it("mirrors the native Codex and Gemini CLI permission mappings", async () => {
    const [, codex, gemini] = await client().listProviders();
    const setting = (mode: string, status = codex) =>
      status?.capabilities.permissionMappings.find((m) => m.mode === mode)?.providerSetting;
    expect(setting("plan")).toBe(
      "--sandbox read-only --skip-git-repo-check -c approval_policy='never' -c web_search='disabled' -c shell_environment_policy.inherit='core' --ignore-rules",
    );
    expect(setting("bypass")).toBe(
      "--sandbox workspace-write -c sandbox_workspace_write.network_access=false -c approval_policy='never' -c web_search='disabled' -c shell_environment_policy.inherit='core' --ignore-rules",
    );
    expect(["plan", "approve", "auto", "bypass"].map((m) => setting(m, gemini))).toEqual([
      "--approval-mode plan",
      "--approval-mode default",
      "--approval-mode default",
      "--approval-mode auto_edit",
    ]);
    for (const status of [codex, gemini]) {
      for (const mapping of status?.capabilities.permissionMappings ?? []) {
        expect(mapping.providerSetting).not.toMatch(/danger-full-access|yolo/);
        expect(mapping.fidelity).toBe("approximate_stricter");
      }
    }
    expect(gemini?.capabilities.models.map((m) => m.id)).toEqual(["auto", "pro", "flash", "flash-lite"]);
    expect(codex?.capabilities.models).toEqual([]);
  });

  it("supports failure, nothing-installed and outdated scenarios", async () => {
    await expect(client("providers-error").detectProviders()).rejects.toMatchObject({
      code: "detection_interrupted",
    });
    const none = await client("providers-none").detectProviders();
    expect(none.every((s) => s.detection?.state === "not_installed")).toBe(true);
    const outdated = await client("providers-outdated").detectProviders();
    expect(outdated[0]?.detection).toMatchObject({
      state: "outdated",
      version: "2.1.100",
      auth: "not_authenticated",
      minimumVersion: "2.1.259",
    });
    const signedOut = await client("providers-signed-out").detectProviders();
    expect(signedOut.map((s) => [s.id, s.detection?.state, s.detection?.auth])).toEqual([
      ["claude-code", "installed", "authenticated"],
      ["codex", "installed", "not_authenticated"],
      ["gemini-cli", "not_installed", "unknown"],
    ]);
  });
});
