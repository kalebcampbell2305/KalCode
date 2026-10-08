import { describe, expect, it } from "vitest";
import { type AccountModels, MODEL_CATALOG_TTL_MS, reconcileModelFreshness } from "./providerAccountState.ts";

describe("account model freshness", () => {
  it("expires only a successful catalog without changing its account-owned choices", () => {
    const catalog: AccountModels = {
      status: "available",
      items: [],
      reason: null,
      observedAt: 1000,
      source: "runtime",
    };
    expect(reconcileModelFreshness(catalog, 1001)).toBe(catalog);
    expect(reconcileModelFreshness(catalog, 1000 + MODEL_CATALOG_TTL_MS)).toMatchObject({
      status: "stale",
      items: catalog.items,
      observedAt: 1000,
    });
  });
  it("never changes a pending discovery or claims freshness for unknown legacy metadata", () => {
    const pending: AccountModels = { status: "checking", items: [], reason: null };
    expect(reconcileModelFreshness(pending, Date.now())).toBe(pending);
    expect(reconcileModelFreshness({ ...pending, status: "available" }, Date.now()).status).toBe("stale");
  });
});
