import { describe, expect, it } from "vitest";
import worker from "../../worker/index";
import type { Env } from "../../worker/lib/env";

describe("schema maintenance admission", () => {
  it.each([
    ["POST", "/v1/billing/webhook"],
    ["POST", "/v1/auth/google/start"],
    ["GET", "/v1/account"],
    ["OPTIONS", "/v1/auth/microsoft/complete"],
  ])("holds %s %s before touching any service or credential", async (method, path) => {
    const env = new Proxy({} as Env, {
      get(_target, name) {
        if (name === "ACCOUNT_SCHEMA_MAINTENANCE") return "true";
        throw new Error("Maintenance accessed a forbidden dependency");
      },
    });
    const response = await worker.fetch(new Request(`https://api.kalcoded.com${path}`, { method }), env);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("location")).toBe(false);
    expect(await response.json()).toEqual({
      ok: false,
      error: "account_maintenance",
      message: "Account services are temporarily unavailable. Please retry shortly.",
    });
  });
});
