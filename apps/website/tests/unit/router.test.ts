import { beforeEach, describe, expect, it } from "vitest";
import { CONSENT_VERSION } from "../../src/lib/site";
import {
  canonicalRedirect,
  clientKey,
  type Deps,
  handleRequest,
  networkKey,
  REMOVE_OK,
  REMOVE_PATH,
  SIGNUP_OK,
  SIGNUP_PATH,
} from "../../worker/lib/router";
import { IMMUTABLE_CACHE } from "../../worker/lib/security";
import type { EarlyAccessEntry } from "../../worker/lib/store";

const ORIGIN = "https://kalcoded.com";

interface Harness {
  deps: Deps;
  rows: Map<string, EarlyAccessEntry>;
  logs: Record<string, string>[];
  limitKeys: string[];
  assetRequests: string[];
  setLimited(limited: boolean): void;
  failStore(fail: boolean): void;
}

function harness(): Harness {
  const rows = new Map<string, EarlyAccessEntry>();
  const logs: Record<string, string>[] = [];
  const limitKeys: string[] = [];
  const assetRequests: string[] = [];
  let limited = false;
  let storeFails = false;
  return {
    rows,
    logs,
    limitKeys,
    assetRequests,
    setLimited: (value) => {
      limited = value;
    },
    failStore: (value) => {
      storeFails = value;
    },
    deps: {
      assets: {
        async fetch(request) {
          assetRequests.push(new URL(request.url).pathname);
          return new Response("<!doctype html><title>asset</title>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
      store: {
        async add(entry) {
          if (storeFails) throw new Error("D1_ERROR: secret internal detail for x@example.com");
          if (!rows.has(entry.email)) rows.set(entry.email, entry);
        },
        async remove(email) {
          if (storeFails) throw new Error("D1_ERROR: secret internal detail");
          rows.delete(email);
        },
      },
      limiter: {
        async limit({ key }) {
          limitKeys.push(key);
          return { success: !limited };
        },
      },
      now: () => new Date("2026-09-24T12:00:00.000Z"),
      log: (entry) => logs.push(entry),
    },
  };
}

function api(
  path: string,
  body: unknown,
  init: { headers?: Record<string, string>; method?: string; raw?: string } = {},
): Request {
  const method = init.method ?? "POST";
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.7",
      ...init.headers,
    },
    body: method === "GET" || method === "HEAD" ? null : (init.raw ?? JSON.stringify(body)),
  });
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("canonicalRedirect", () => {
  it("redirects www to the apex, keeping path and query", () => {
    expect(canonicalRedirect(new URL("https://www.kalcoded.com/pricing?ref=x#top"))).toBe(
      "https://kalcoded.com/pricing?ref=x",
    );
    expect(canonicalRedirect(new URL("http://WWW.kalcoded.com/"))).toBe("https://kalcoded.com/");
  });

  it("leaves the apex and other hosts alone", () => {
    expect(canonicalRedirect(new URL("https://kalcoded.com/docs"))).toBeNull();
    expect(canonicalRedirect(new URL("http://127.0.0.1:8787/"))).toBeNull();
  });
  it("upgrades plain-HTTP edge requests to HTTPS, keeping path and query", () => {
    const url = new URL("http://kalcoded.com/pricing?plan=pro");
    const edgeHttp = new Request(url, { headers: { "cf-visitor": '{"scheme":"http"}' } });
    expect(canonicalRedirect(url, edgeHttp)).toBe("https://kalcoded.com/pricing?plan=pro");
  });

  it("does not redirect HTTPS edge requests, local development, or malformed headers", () => {
    const url = new URL("http://kalcoded.com/");
    const edgeHttps = new Request(url, { headers: { "cf-visitor": '{"scheme":"https"}' } });
    const local = new Request(url);
    const malformed = new Request(url, { headers: { "cf-visitor": "not json" } });
    expect(canonicalRedirect(url, edgeHttps)).toBeNull();
    expect(canonicalRedirect(url, local)).toBeNull();
    expect(canonicalRedirect(url, malformed)).toBeNull();
    const otherHost = new URL("http://127.0.0.1:8787/");
    expect(
      canonicalRedirect(otherHost, new Request(otherHost, { headers: { "cf-visitor": '{"scheme":"http"}' } })),
    ).toBeNull();
  });
});

describe("handleRequest routing", () => {
  it("answers www requests with a 301 to the apex before anything else", async () => {
    const response = await handleRequest(new Request("https://www.kalcoded.com/docs/jarvis?x=1"), h.deps);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://kalcoded.com/docs/jarvis?x=1");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(h.assetRequests).toEqual([]);
  });

  it("also redirects www API calls instead of handling them", async () => {
    const response = await handleRequest(
      new Request("https://www.kalcoded.com/api/early-access", { method: "POST" }),
      h.deps,
    );
    expect(response.status).toBe(301);
    expect(h.rows.size).toBe(0);
  });

  it("serves everything else from static assets with security headers", async () => {
    const response = await handleRequest(new Request(`${ORIGIN}/pricing`), h.deps);
    expect(response.status).toBe(200);
    expect(h.assetRequests).toEqual(["/pricing"]);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/]+=*'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("permissions-policy")).toContain("microphone=()");
    expect(response.headers.get("permissions-policy")).toContain("geolocation=()");
    // Pages are served as-is: the proxy may not inject scripts (e.g. an analytics beacon).
    expect(response.headers.get("cache-control")).toBe("no-transform");
  });

  it("marks hashed build assets as immutable", async () => {
    const response = await handleRequest(new Request(`${ORIGIN}/_astro/site.abc123.css`), h.deps);
    expect(response.headers.get("cache-control")).toBe(IMMUTABLE_CACHE);
  });

  it("returns a JSON 404 for unknown API paths", async () => {
    const response = await handleRequest(api("/api/unknown", {}), h.deps);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: "not_found" });
    expect(response.headers.get("content-security-policy")).toBeTruthy();
  });
});

describe("POST /api/early-access", () => {
  it("stores a new address and returns the shared success body", async () => {
    const response = await handleRequest(
      api(SIGNUP_PATH, { email: " New@Example.com ", source: "/download", website: "" }),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SIGNUP_OK);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(h.rows.get("new@example.com")).toEqual({
      email: "new@example.com",
      source: "/download",
      createdAt: "2026-09-24T12:00:00.000Z",
      consentVersion: CONSENT_VERSION,
    });
  });

  it("responds identically for a duplicate, without changing the stored row", async () => {
    const first = await handleRequest(api(SIGNUP_PATH, { email: "a@example.com", source: "/" }), h.deps);
    const second = await handleRequest(api(SIGNUP_PATH, { email: "A@EXAMPLE.COM", source: "/pricing" }), h.deps);
    expect(second.status).toBe(first.status);
    expect(await second.text()).toBe(await first.text());
    expect(h.rows.size).toBe(1);
    expect(h.rows.get("a@example.com")?.source).toBe("/");
  });

  it("acknowledges a honeypot submission exactly like a real one but stores nothing", async () => {
    const real = await handleRequest(api(SIGNUP_PATH, { email: "r@example.com", source: "/" }), h.deps);
    const bot = await handleRequest(
      api(SIGNUP_PATH, { email: "bot@example.com", source: "/", website: "https://spam.example" }),
      h.deps,
    );
    expect(bot.status).toBe(real.status);
    expect(await bot.text()).toBe(await real.text());
    expect([...h.rows.keys()]).toEqual(["r@example.com"]);
  });

  it("rejects an invalid email with 400 and a specific message", async () => {
    const response = await handleRequest(api(SIGNUP_PATH, { email: "nope@", source: "/" }), h.deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "invalid_email" });
    expect(h.rows.size).toBe(0);
  });

  it("rejects an unknown source with 400", async () => {
    const response = await handleRequest(api(SIGNUP_PATH, { email: "a@example.com", source: "/elsewhere" }), h.deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_source" });
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await handleRequest(api(SIGNUP_PATH, null, { raw: "{not json" }), h.deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
  });

  it("rejects the wrong content type with 415", async () => {
    const response = await handleRequest(
      api(SIGNUP_PATH, null, {
        raw: "email=a%40example.com",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      h.deps,
    );
    expect(response.status).toBe(415);
  });

  it("rejects bodies over 2 KB with 413", async () => {
    const response = await handleRequest(
      api(SIGNUP_PATH, { email: "a@example.com", source: "/", padding: "x".repeat(2100) }),
      h.deps,
    );
    expect(response.status).toBe(413);
  });

  it.each(["GET", "PUT", "DELETE", "OPTIONS"])("rejects %s with 405 and an Allow header", async (method) => {
    const response = await handleRequest(api(SIGNUP_PATH, {}, { method }), h.deps);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects cross-origin browser submissions with 403", async () => {
    const response = await handleRequest(
      api(SIGNUP_PATH, { email: "a@example.com" }, { headers: { origin: "https://evil.example" } }),
      h.deps,
    );
    expect(response.status).toBe(403);
    expect(h.rows.size).toBe(0);
  });

  it("accepts same-origin submissions", async () => {
    const response = await handleRequest(
      api(SIGNUP_PATH, { email: "a@example.com" }, { headers: { origin: ORIGIN } }),
      h.deps,
    );
    expect(response.status).toBe(200);
  });

  it("rate-limits by client IP and returns 429 with Retry-After", async () => {
    h.setLimited(true);
    const response = await handleRequest(api(SIGNUP_PATH, { email: "a@example.com" }), h.deps);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(h.limitKeys).toEqual(["signup:203.0.113.7"]);
    expect(h.rows.size).toBe(0);
  });

  it("fails open, without logging request data, if the limiter errors", async () => {
    h.deps.limiter = {
      async limit() {
        throw new Error("limiter down");
      },
    };
    const response = await handleRequest(api(SIGNUP_PATH, { email: "a@example.com" }), h.deps);
    expect(response.status).toBe(200);
    expect(JSON.stringify(h.logs)).not.toContain("example.com");
  });

  it("returns a generic 500 when storage fails, never leaking internals or the email", async () => {
    h.failStore(true);
    const response = await handleRequest(api(SIGNUP_PATH, { email: "x@example.com" }), h.deps);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("D1_ERROR");
    expect(text).not.toContain("x@example.com");
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: "server_error" });
    expect(h.logs).toEqual([{ level: "error", event: "early_access.store_failed", error: "Error" }]);
  });
});

describe("POST /api/early-access/remove", () => {
  it("removes an address and answers identically whether or not it existed", async () => {
    await handleRequest(api(SIGNUP_PATH, { email: "gone@example.com", source: "/" }), h.deps);
    const existing = await handleRequest(api(REMOVE_PATH, { email: "Gone@Example.com" }), h.deps);
    const missing = await handleRequest(api(REMOVE_PATH, { email: "never@example.com" }), h.deps);
    expect(existing.status).toBe(200);
    expect(missing.status).toBe(200);
    const existingBody = await existing.text();
    expect(existingBody).toBe(await missing.text());
    expect(JSON.parse(existingBody)).toEqual(REMOVE_OK);
    expect(h.rows.size).toBe(0);
  });

  it("is rate-limited under its own key", async () => {
    h.setLimited(true);
    const response = await handleRequest(api(REMOVE_PATH, { email: "a@example.com" }), h.deps);
    expect(response.status).toBe(429);
    expect(h.limitKeys).toEqual(["remove:203.0.113.7"]);
  });

  it("validates the email", async () => {
    const response = await handleRequest(api(REMOVE_PATH, { email: "bad" }), h.deps);
    expect(response.status).toBe(400);
  });

  it("returns a generic 500 when storage fails", async () => {
    h.failStore(true);
    const response = await handleRequest(api(REMOVE_PATH, { email: "a@example.com" }), h.deps);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("D1_ERROR");
  });
});

describe("clientKey", () => {
  it("uses cf-connecting-ip and falls back to a shared bucket", () => {
    const withIp = new Request(ORIGIN, { headers: { "cf-connecting-ip": " 198.51.100.4 " } });
    expect(clientKey(withIp, "signup")).toBe("signup:198.51.100.4");
    expect(clientKey(new Request(ORIGIN), "remove")).toBe("remove:unknown");
  });
});

describe("networkKey", () => {
  it("keeps IPv4 addresses as-is", () => {
    expect(networkKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("groups IPv6 addresses by /64 so rotating within a prefix shares one limit", () => {
    expect(networkKey("2001:db8:abcd:12:1::5")).toBe("2001:db8:abcd:12::/64");
    expect(networkKey("2001:0db8:abcd:0012:ffff:eeee:dddd:cccc")).toBe("2001:db8:abcd:12::/64");
    expect(networkKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkKey("::1")).toBe("0:0:0:0::/64");
  });
});

describe("protocol-relative paths", () => {
  it("answers paths starting with // with 404 before assets or redirects", async () => {
    const response = await handleRequest(new Request("https://kalcoded.com//evil.example/docs/"), h.deps);
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeTruthy();
    expect(h.assetRequests).toEqual([]);
  });
});
