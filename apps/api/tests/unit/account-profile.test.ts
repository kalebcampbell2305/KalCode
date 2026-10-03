import { describe, expect, it } from "vitest";
import type { AccountProfile, AccountStore } from "../../worker/lib/account-store";
import { normalizeDisplayName } from "../../worker/lib/profile";
import { ACCOUNT_PATH, ACCOUNT_PROFILE_PATH, type Deps, handleRequest } from "../../worker/lib/router";
import type { EntitlementStore, UsageStore } from "../../worker/lib/store";
import { TEST_ACCOUNT_HEADER, TEST_ONLY_AUTHENTICATOR } from "../support/test-auth";

const BASE = "http://127.0.0.1";
const ACCOUNT = "acct-profile";
const CREATED = "2026-09-24T12:00:00.000Z";

function deps() {
  const profiles = new Map<string, AccountProfile>([
    [ACCOUNT, { id: ACCOUNT, email: "kaleb@example.com", activatedAt: CREATED, displayName: "Kaleb Campbell" }],
  ]);
  const writes: { accountId: string; displayName: string | null }[] = [];
  const accountStore = {
    async accountProfile(accountId: string) {
      return profiles.get(accountId) ?? null;
    },
    async setDisplayName(accountId: string, displayName: string | null) {
      writes.push({ accountId, displayName });
      const current = profiles.get(accountId);
      if (!current) return null;
      const next = { ...current, displayName };
      profiles.set(accountId, next);
      return next;
    },
  } as unknown as AccountStore;
  const store = {
    async account(accountId: string) {
      return profiles.has(accountId) ? { id: accountId, createdAt: CREATED } : null;
    },
  } as unknown as EntitlementStore & UsageStore;
  const d: Deps = {
    store,
    auth: TEST_ONLY_AUTHENTICATOR,
    accountStore,
    signingKey: async () => null,
    previousPublicKeys: () => [],
    now: () => new Date(CREATED),
    log: () => {},
  };
  return { d, writes };
}

function update(d: Deps, body: unknown, headers: Record<string, string> = {}, account: string | null = ACCOUNT) {
  return handleRequest(
    new Request(`${BASE}${ACCOUNT_PROFILE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(account ? { [TEST_ACCOUNT_HEADER]: account } : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    d,
  );
}

const get = (d: Deps, path: string, account: string | null = ACCOUNT) =>
  handleRequest(new Request(`${BASE}${path}`, { headers: account ? { [TEST_ACCOUNT_HEADER]: account } : {} }), d);

describe("account display name", () => {
  it("serves the display name on the profile route and keeps GET /v1/account's shipped shape", async () => {
    const { d } = deps();
    const profile = await get(d, ACCOUNT_PROFILE_PATH);
    expect(profile.status).toBe(200);
    expect(await profile.json()).toEqual({
      ok: true,
      account: { id: ACCOUNT, email: "kaleb@example.com", activatedAt: CREATED, displayName: "Kaleb Campbell" },
    });
    // Installed desktop builds parse this body with deny_unknown_fields: no new keys, ever.
    const legacy = await get(d, ACCOUNT_PATH);
    expect(await legacy.json()).toEqual({
      ok: true,
      account: { id: ACCOUNT, email: "kaleb@example.com", activatedAt: CREATED },
    });
  });

  it("sets a trimmed name and returns the updated account without touching id or email", async () => {
    const { d, writes } = deps();
    const response = await update(d, { displayName: "  Kaleb  " });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      account: { id: ACCOUNT, email: "kaleb@example.com", activatedAt: CREATED, displayName: "Kaleb" },
    });
    expect(writes).toEqual([{ accountId: ACCOUNT, displayName: "Kaleb" }]);
    expect(await (await get(d, ACCOUNT_PROFILE_PATH)).json()).toMatchObject({ account: { displayName: "Kaleb" } });
  });

  it.each([[null], [""], ["   "]])("clears the name for %j", async (displayName) => {
    const { d, writes } = deps();
    const response = await update(d, { displayName });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account: { displayName: null } });
    expect(writes).toEqual([{ accountId: ACCOUNT, displayName: null }]);
  });

  it.each([
    ["too long", "x".repeat(65)],
    ["a control character", "Ka\u0007leb"],
    ["a newline", "Kaleb\nCampbell"],
    ["a bidi override", "Kaleb‮"],
    ["a zero-width joiner", "Ka‍leb"],
    ["a number", 42],
  ])("rejects %s without writing", async (_label, displayName) => {
    const { d, writes } = deps();
    const response = await update(d, { displayName });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "invalid_display_name" });
    expect(writes).toEqual([]);
  });

  it("accepts 64 characters, counting code points, not UTF-16 units", async () => {
    const { d } = deps();
    const name = "\u{1F600}".repeat(64);
    const response = await update(d, { displayName: name });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account: { displayName: name } });
  });

  it.each([
    ["an unknown field", { displayName: "Kaleb", email: "other@example.com" }],
    ["a missing field", {}],
    ["an array", ["Kaleb"]],
  ])("refuses a body with %s, so nothing else can be changed", async (_label, body) => {
    const { d, writes } = deps();
    const response = await update(d, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(writes).toEqual([]);
  });

  it("refuses non-JSON and malformed bodies", async () => {
    const { d, writes } = deps();
    const form = await update(d, "displayName=Kaleb", { "content-type": "application/x-www-form-urlencoded" });
    expect(form.status).toBe(415);
    expect((await update(d, "{nope")).status).toBe(400);
    expect(writes).toEqual([]);
  });

  it("requires sign-in for both reading and writing", async () => {
    const { d, writes } = deps();
    expect((await get(d, ACCOUNT_PROFILE_PATH, null)).status).toBe(401);
    const response = await update(d, { displayName: "Kaleb" }, {}, null);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect((await update(d, { displayName: "Kaleb" }, {}, "acct-unknown")).status).toBe(401);
    expect(writes).toEqual([]);
  });

  it("refuses browser writes from any origin other than kalcoded.com", async () => {
    const { d, writes } = deps();
    const foreign = await update(d, { displayName: "Kaleb" }, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(writes).toEqual([]);
    const site = await update(d, { displayName: "Kaleb" }, { origin: "https://kalcoded.com" });
    expect(site.status).toBe(200);
    expect(site.headers.get("access-control-allow-origin")).toBe("https://kalcoded.com");
  });
});

describe("normalizeDisplayName", () => {
  it("NFC-normalizes so the same visible name is stored once", () => {
    expect(normalizeDisplayName("José")).toEqual({ ok: true, displayName: "José" });
  });

  it("bounds the raw input before trimming", () => {
    expect(normalizeDisplayName(`${" ".repeat(300)}Kaleb`)).toEqual({ ok: false });
  });
});
