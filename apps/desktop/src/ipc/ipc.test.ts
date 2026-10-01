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
    await new Promise((r) => setTimeout(r, 0)); // events are delivered asynchronously
    expect(received).toEqual(["settings.changed"]);
    expect((await c.getSettings()).theme).toBe("light");
  });

  it("rejects an empty settings patch like the native runtime", async () => {
    await expect(client().updateSettings({})).rejects.toMatchObject({
      code: "empty_settings_patch",
      category: "validation",
    });
  });

  it("rejects unknown settings fields and invalid values like native serde", async () => {
    const c = client();
    await expect(c.updateSettings({ theme: "neon" } as never)).rejects.toMatchObject({ code: "ipc_rejected" });
    await expect(c.updateSettings({ telemetry: true } as never)).rejects.toMatchObject({ code: "ipc_rejected" });
    expect((await c.getSettings()).theme).toBe("dark");
  });

  it("queries events by type prefix, order and page like the native runtime", async () => {
    const c = client();
    await c.boot();
    const newest = await c.queryEvents({ types: ["app.*"] });
    expect(newest.events.map((e) => e.type)).toEqual(["app.started"]);
    expect(newest.nextCursor).toBeNull();
    const oldestFirst = await c.queryEvents({ order: "asc", limit: 1 });
    expect(oldestFirst.events.map((e) => e.type)).toEqual(["database.migrated"]);
    expect(oldestFirst.nextCursor).toBe(oldestFirst.events[0]?.seq);
    const next = await c.queryEvents({ order: "asc", limit: 1, afterSeq: oldestFirst.nextCursor });
    expect(next.events.map((e) => e.type)).toEqual(["app.started"]);
    const none = await c.queryEvents({ correlation: { threadId: "0192f3c4-0000-7000-8000-000000000000" } });
    expect(none.events).toEqual([]);
  });

  it("clamps page sizes before calling the runtime", async () => {
    const c = client();
    await expect(c.recentEvents(10_000)).resolves.toHaveLength(2);
    await expect(c.recentEvents(0)).resolves.toHaveLength(1);
  });

  it("surfaces startup errors from boot and blocks runtime commands", async () => {
    const transport = createMemoryTransport("startup-error");
    const c = new KalCodeClient(transport);
    const boot = await c.boot();
    expect(boot.startupError?.code).toBe("schema_too_new");
    await expect(c.getSettings()).rejects.toMatchObject({ code: "schema_too_new" });
    await expect(transport.invoke("operations_snapshot", {})).rejects.toMatchObject({ code: "schema_too_new" });
  });

  it("reports credential store failures with a user-facing message", async () => {
    const c = new KalCodeClient(createMemoryTransport("keychain-failure"));
    const result = await c.checkSecureStore();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/credential store/);
  });
});
