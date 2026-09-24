import { describe, expect, it } from "vitest";
import { KalCodeClient } from "./client.ts";
import { KalCodeError, toKalCodeError } from "./errors.ts";
import { createMemoryTransport } from "./memoryTransport.ts";

describe("toKalCodeError", () => {
  it("preserves native IPC errors", () => {
    const err = toKalCodeError({
      category: "database",
      code: "schema_too_new",
      message: "Update KalCode.",
      retryable: false,
    });
    expect(err).toBeInstanceOf(KalCodeError);
    expect(err.toIpcError()).toEqual({
      category: "database",
      code: "schema_too_new",
      message: "Update KalCode.",
      retryable: false,
    });
  });

  it("hides unexpected error details behind a generic message", () => {
    const err = toKalCodeError("invalid args `patch` for command `settings_update`: unknown field `telemetry`");
    expect(err.code).toBe("ipc_rejected");
    expect(err.message).toBe("KalCode couldn't complete that request.");
    expect(err.message).not.toContain("telemetry");
  });

  it("rejects look-alike objects with unknown categories", () => {
    expect(toKalCodeError({ category: "nope", code: "x", message: "y", retryable: false }).code).toBe("ipc_rejected");
  });
});

describe("KalCodeClient with the memory transport", () => {
  const client = () => new KalCodeClient(createMemoryTransport("default"));

  it("boots with build info and records startup events", async () => {
    const c = client();
    const boot = await c.boot();
    expect(boot.startupError).toBeNull();
    expect(boot.info.name).toBe("KalCode");
    const events = await c.recentEvents(10);
    expect(events.map((e) => e.type)).toEqual(["app.started", "database.migrated"]);
  });

  it("emits settings.changed only for values that change", async () => {
    const c = client();
    const received: string[] = [];
    await c.subscribeEvents((e) => received.push(e.type));
    await c.updateSettings({ theme: "light" });
    await c.updateSettings({ theme: "light" });
    expect(received).toEqual(["settings.changed"]);
    expect((await c.getSettings()).theme).toBe("light");
  });

  it("rejects an empty settings patch like the native runtime", async () => {
    await expect(client().updateSettings({})).rejects.toMatchObject({
      code: "empty_settings_patch",
      category: "validation",
    });
  });

  it("clamps page sizes before calling the runtime", async () => {
    const c = client();
    await expect(c.recentEvents(10_000)).resolves.toHaveLength(2);
    await expect(c.recentEvents(0)).resolves.toHaveLength(1);
  });

  it("surfaces startup errors from boot and blocks runtime commands", async () => {
    const c = new KalCodeClient(createMemoryTransport("startup-error"));
    const boot = await c.boot();
    expect(boot.startupError?.code).toBe("schema_too_new");
    await expect(c.getSettings()).rejects.toMatchObject({ code: "schema_too_new" });
  });

  it("reports credential store failures with a user-facing message", async () => {
    const c = new KalCodeClient(createMemoryTransport("keychain-failure"));
    const result = await c.checkSecureStore();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/credential store/);
  });
});
