import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { CONSENT_VERSION, EARLY_ACCESS_EMAIL } from "../../src/lib/site";
import { scheduledPurge } from "../../worker/lib/early-access";
import {
  CONFIRM_PATH,
  CONFIRMED_OK,
  type Deps,
  dailyEmailLimit,
  handleRequest,
  localLinkOrigin,
  REMOVE_CONFIRM_PATH,
  REMOVE_OK,
  REMOVE_PATH,
  REMOVED_OK,
  SIGNUP_OK,
  SIGNUP_PATH,
} from "../../worker/lib/router";
import { type FakeMailer, type FakeStore, fakeMailer, fakeStore, linkToken } from "./fakes";

const ORIGIN = "https://kalcoded.com";
const START = new Date("2026-09-24T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const { confirmPath, removePath } = EARLY_ACCESS_EMAIL;

interface Harness {
  deps: Deps;
  store: FakeStore;
  mailer: FakeMailer;
  logs: Record<string, string>[];
  limitKeys: string[];
  assetRequests: string[];
  advance(ms: number): void;
}

let h: Harness;

function harness(
  options: { transport?: FakeMailer["transport"]; dailyLimit?: number; localLinkOrigin?: string | null } = {},
): Harness {
  const store = fakeStore();
  const mailer = fakeMailer(options.transport ?? "resend");
  const logs: Record<string, string>[] = [];
  const limitKeys: string[] = [];
  const assetRequests: string[] = [];
  let now = START.getTime();
  let counter = 0;
  return {
    store,
    mailer,
    logs,
    limitKeys,
    assetRequests,
    advance: (ms) => {
      now += ms;
    },
    deps: {
      assets: {
        async fetch(request) {
          assetRequests.push(new URL(request.url).pathname);
          return new Response("<!doctype html><title>page</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
      store,
      mailer,
      limiter: {
        async limit({ key }) {
          limitKeys.push(key);
          return { success: true };
        },
      },
      now: () => new Date(now),
      log: (entry) => logs.push(entry),
      // Distinct, correctly shaped codes; real ones come from crypto.getRandomValues.
      newToken: () => {
        counter += 1;
        return `code${String(counter).padStart(39, "0")}`;
      },
      dailyEmailLimit: options.dailyLimit ?? 90,
      localLinkOrigin: options.localLinkOrigin ?? null,
    },
  };
}

function post(path: string, body: unknown, origin = ORIGIN, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers },
    body: JSON.stringify(body),
  });
}

async function join(email: string, origin = ORIGIN): Promise<Response> {
  return handleRequest(post(SIGNUP_PATH, { email, source: "/download", website: "" }, origin), h.deps);
}

function lastEmail() {
  const email = h.mailer.sent.at(-1);
  if (!email) throw new Error("no email sent");
  return email;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

beforeEach(() => {
  h = harness();
});

describe("joining sends a confirmation email", () => {
  it("stores a pending row and emails confirm and removal links to the canonical site", async () => {
    const response = await join("new@example.com");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SIGNUP_OK);
    expect(h.store.rows.get("new@example.com")).toMatchObject({ status: "pending", consentVersion: CONSENT_VERSION });

    const email = lastEmail();
    expect(email.to).toBe("new@example.com");
    expect(email.subject).toBe("Confirm your KalCode early-access email");
    expect(email.text).toContain(`${ORIGIN}${confirmPath}?token=`);
    expect(email.text).toContain(`${ORIGIN}${removePath}?token=`);
    expect(email.html).toContain(`${ORIGIN}${confirmPath}?token=`);
    expect(email.html).not.toMatch(/<img|<script|https?:\/\/(?!kalcoded\.com)/);
    expect(email.idempotencyKey).toMatch(/^early-access-[0-9a-f]{32}$/);
  });

  it("stores only SHA-256 hashes of the link codes, expiring after 72 hours", async () => {
    await join("new@example.com");
    const confirm = linkToken(lastEmail().text, confirmPath);
    const remove = linkToken(lastEmail().text, removePath);
    const stored = [...h.store.tokens.values()];
    expect(stored.map((token) => token.hash).sort()).toEqual([sha256(confirm), sha256(remove)].sort());
    expect(JSON.stringify(stored)).not.toContain(confirm);
    for (const token of stored) {
      expect(Date.parse(token.expiresAt) - START.getTime()).toBe(EARLY_ACCESS_EMAIL.linkTtlHours * HOUR);
    }
  });

  it("links to the configured local server with the test transport, and fails without one", async () => {
    h = harness({ transport: "capture", localLinkOrigin: "http://127.0.0.1:8794" });
    const local = await join("dev@example.com");
    expect(local.status).toBe(200);
    expect(lastEmail().text).toContain(`http://127.0.0.1:8794${confirmPath}?token=`);

    h = harness({ transport: "log", localLinkOrigin: null });
    const unconfigured = await join("prod@example.com");
    expect(unconfigured.status).toBe(502);
    expect(await unconfigured.json()).toMatchObject({ ok: false, error: "email_failed" });
    expect(h.store.rows.has("prod@example.com")).toBe(false);
    expect(h.logs).toContainEqual({ level: "error", event: "email.transport_misconfigured", transport: "log" });
  });

  it("links to the canonical site with Resend, whatever the request host or local setting", async () => {
    h = harness({ transport: "resend", localLinkOrigin: "http://127.0.0.1:8794" });
    await join("a@example.com", "http://127.0.0.1:8794");
    expect(lastEmail().text).toContain(`${ORIGIN}${confirmPath}?token=`);
    expect(lastEmail().text).not.toContain("127.0.0.1");
  });

  it("accepts only a loopback EMAIL_LINK_ORIGIN", () => {
    expect(localLinkOrigin("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(localLinkOrigin("http://localhost:4321")).toBe("http://localhost:4321");
    for (const bad of [undefined, "", "https://kalcoded.com", "http://evil.example", "javascript:alert(1)", "nope"]) {
      expect(localLinkOrigin(bad)).toBeNull();
    }
  });

  it("refuses to pretend when the transport name is unknown", async () => {
    h = harness({ transport: "invalid", localLinkOrigin: "http://127.0.0.1:8794" });
    const response = await join("a@example.com");
    expect(response.status).toBe(502);
    expect(h.store.rows.size).toBe(0);
  });
});

describe("no enumeration", () => {
  it("answers new, pending, confirmed and legacy addresses identically", async () => {
    h.store.seed("confirmed@example.com", "confirmed");
    h.store.seed("legacy@example.com", "legacy_unconfirmed");
    await join("pending@example.com");
    h.advance(11 * MINUTE);

    const responses = await Promise.all(
      ["fresh@example.com", "pending@example.com", "confirmed@example.com", "legacy@example.com"].map((email) =>
        join(email),
      ),
    );
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([200]));
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] ?? "")).toEqual(SIGNUP_OK);
    // Every address still got exactly one email for this round, so timing and failures match too.
    expect(
      h.mailer.sent
        .slice(1)
        .map((email) => email.to)
        .sort(),
    ).toEqual(["confirmed@example.com", "fresh@example.com", "legacy@example.com", "pending@example.com"]);
  });

  it("tells a confirmed address it is already on the list, with a removal link and no confirm link", async () => {
    h.store.seed("confirmed@example.com", "confirmed");
    await join("confirmed@example.com");
    const email = lastEmail();
    expect(email.subject).toBe("You're already on the KalCode early-access list");
    expect(email.text).not.toContain(confirmPath);
    expect(email.text).toContain(`${ORIGIN}${removePath}?token=`);
    expect(h.store.rows.get("confirmed@example.com")?.status).toBe("confirmed");
  });

  it("keeps a legacy row legacy until its owner confirms", async () => {
    h.store.seed("legacy@example.com", "legacy_unconfirmed");
    await join("legacy@example.com");
    expect(h.store.rows.get("legacy@example.com")).toMatchObject({
      status: "legacy_unconfirmed",
      consentVersion: CONSENT_VERSION,
    });
    const code = linkToken(lastEmail().text, confirmPath);
    const response = await handleRequest(post(CONFIRM_PATH, { token: code }), h.deps);
    expect(response.status).toBe(200);
    expect(h.store.rows.get("legacy@example.com")?.status).toBe("confirmed");
  });

  it("answers removal requests identically for listed and unlisted addresses", async () => {
    h.store.seed("listed@example.com", "legacy_unconfirmed");
    const listed = await handleRequest(post(REMOVE_PATH, { email: "listed@example.com" }), h.deps);
    const unlisted = await handleRequest(post(REMOVE_PATH, { email: "unlisted@example.com" }), h.deps);
    expect(listed.status).toBe(unlisted.status);
    expect(await listed.text()).toBe(await unlisted.text());
    expect(h.mailer.sent.map((email) => email.to)).toEqual(["listed@example.com"]);
  });
});

describe("confirming", () => {
  async function joinAndGetCode(email = "c@example.com"): Promise<string> {
    await join(email);
    return linkToken(lastEmail().text, confirmPath);
  }

  it("confirms with a POST of the code, once", async () => {
    const code = await joinAndGetCode();
    const first = await handleRequest(post(CONFIRM_PATH, { token: code }), h.deps);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(CONFIRMED_OK);
    expect(h.store.rows.get("c@example.com")).toMatchObject({
      status: "confirmed",
      confirmedAt: START.toISOString(),
    });
    // The removal link of the same email keeps working; no confirmation link is left.
    expect([...h.store.tokens.values()].map((token) => token.purpose)).toEqual(["remove"]);

    const reuse = await handleRequest(post(CONFIRM_PATH, { token: code }), h.deps);
    expect(reuse.status).toBe(410);
    expect(await reuse.json()).toMatchObject({ ok: false, error: "invalid_link" });
  });

  it("never confirms on GET: the API refuses it and the page is plain static HTML", async () => {
    const code = await joinAndGetCode();
    const api = await handleRequest(new Request(`${ORIGIN}${CONFIRM_PATH}?token=${code}`), h.deps);
    expect(api.status).toBe(405);
    const page = await handleRequest(new Request(`${ORIGIN}${confirmPath}?token=${code}`), h.deps);
    expect(page.status).toBe(200);
    expect(h.assetRequests).toEqual([confirmPath]);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(h.store.rows.get("c@example.com")?.status).toBe("pending");
  });

  it("rejects an expired link and a forged one", async () => {
    const code = await joinAndGetCode();
    h.advance(EARLY_ACCESS_EMAIL.linkTtlHours * HOUR);
    const expired = await handleRequest(post(CONFIRM_PATH, { token: code }), h.deps);
    expect(expired.status).toBe(410);
    expect(h.store.rows.get("c@example.com")?.status).toBe("pending");

    const forged = await handleRequest(post(CONFIRM_PATH, { token: "A".repeat(43) }), h.deps);
    expect(forged.status).toBe(410);
  });

  it("rejects a removal code on the confirm endpoint and the reverse", async () => {
    await join("c@example.com");
    const remove = linkToken(lastEmail().text, removePath);
    const confirm = linkToken(lastEmail().text, confirmPath);
    expect((await handleRequest(post(CONFIRM_PATH, { token: remove }), h.deps)).status).toBe(410);
    expect((await handleRequest(post(REMOVE_CONFIRM_PATH, { token: confirm }), h.deps)).status).toBe(410);
    expect(h.store.rows.get("c@example.com")?.status).toBe("pending");
  });

  it.each([
    [{}, 400],
    [{ token: "short" }, 400],
    [{ token: `${"a".repeat(42)}!` }, 400],
    [{ token: 42 }, 400],
  ])("rejects a malformed body %j with %i", async (body, status) => {
    const response = await handleRequest(post(CONFIRM_PATH, body), h.deps);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  it("applies the shared method, origin and rate-limit guard", async () => {
    const cross = await handleRequest(
      post(CONFIRM_PATH, { token: "A".repeat(43) }, ORIGIN, { origin: "https://evil.example" }),
      h.deps,
    );
    expect(cross.status).toBe(403);
    await handleRequest(post(REMOVE_CONFIRM_PATH, { token: "A".repeat(43) }), h.deps);
    expect(h.limitKeys).toEqual(["remove_confirm:203.0.113.9"]);
  });
});

describe("removal", () => {
  it("deletes the row and every link permanently with the emailed removal link", async () => {
    h.store.seed("bye@example.com", "confirmed");
    await join("other@example.com");
    const request = await handleRequest(post(REMOVE_PATH, { email: "bye@example.com" }), h.deps);
    expect(await request.json()).toEqual(REMOVE_OK);
    const email = lastEmail();
    expect(email.to).toBe("bye@example.com");
    expect(email.subject).toBe("Confirm removal from the KalCode early-access list");
    const code = linkToken(email.text, removePath);

    const removed = await handleRequest(post(REMOVE_CONFIRM_PATH, { token: code }), h.deps);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual(REMOVED_OK);
    expect(h.store.rows.has("bye@example.com")).toBe(false);
    expect([...h.store.tokens.values()].every((token) => token.subscriberId !== 1)).toBe(true);
    expect(h.store.rows.has("other@example.com")).toBe(true);

    const reuse = await handleRequest(post(REMOVE_CONFIRM_PATH, { token: code }), h.deps);
    expect(reuse.status).toBe(410);
  });

  it("works from the removal link in the confirmation email, removing pending links too", async () => {
    await join("changed-mind@example.com");
    const code = linkToken(lastEmail().text, removePath);
    const response = await handleRequest(post(REMOVE_CONFIRM_PATH, { token: code }), h.deps);
    expect(response.status).toBe(200);
    expect(h.store.rows.size).toBe(0);
    expect(h.store.tokens.size).toBe(0);
  });
});

describe("email throttle and budget", () => {
  it("sends at most one email per address per 10 minutes, answering the same way", async () => {
    await join("t@example.com");
    h.advance(9 * MINUTE);
    const throttled = await join("t@example.com");
    expect(throttled.status).toBe(200);
    expect(await throttled.json()).toEqual(SIGNUP_OK);
    expect(h.mailer.sent).toHaveLength(1);
    h.advance(1 * MINUTE);
    await join("t@example.com");
    expect(h.mailer.sent).toHaveLength(2);
  });

  it("caps emails per address per UTC day, across joins and removal requests", async () => {
    for (let i = 0; i < EARLY_ACCESS_EMAIL.dailyPerAddress + 2; i += 1) {
      await (i % 2 === 0
        ? join("cap@example.com")
        : handleRequest(post(REMOVE_PATH, { email: "cap@example.com" }), h.deps));
      h.advance(11 * MINUTE);
    }
    expect(h.mailer.sent).toHaveLength(EARLY_ACCESS_EMAIL.dailyPerAddress);
    h.advance(12 * HOUR); // next UTC day
    await join("cap@example.com");
    expect(h.mailer.sent).toHaveLength(EARLY_ACCESS_EMAIL.dailyPerAddress + 1);
  });

  it("stops at the site-wide daily budget with a clear 503 and leaves nothing behind", async () => {
    h = harness({ dailyLimit: 31 });
    expect((await join("first@example.com")).status).toBe(200);
    const second = await join("second@example.com");
    expect(second.status).toBe(503);
    expect(await second.json()).toMatchObject({ ok: false, error: "email_unavailable" });
    expect(h.store.rows.has("second@example.com")).toBe(false);
    h.advance(11 * MINUTE);
    const removal = await handleRequest(post(REMOVE_PATH, { email: "first@example.com" }), h.deps);
    expect(removal.status).toBe(503);
    // The refused attempt did not use up the address's throttle.
    expect(h.store.rows.get("first@example.com")?.emailDayCount).toBe(1);
    h.advance(24 * HOUR);
    expect((await join("second@example.com")).status).toBe(200);
  });

  it("parses EMAIL_DAILY_LIMIT defensively", () => {
    expect(dailyEmailLimit("25")).toBe(25);
    expect(dailyEmailLimit("0")).toBe(0);
    for (const bad of [undefined, "", "-1", "1.5", "lots"]) {
      expect(dailyEmailLimit(bad)).toBe(EARLY_ACCESS_EMAIL.dailyTotal);
    }
  });
});

describe("when the email cannot be sent", () => {
  it.each([
    ["rejected", { ok: false, reason: "rejected", status: 500 }],
    ["not configured", { ok: false, reason: "not_configured" }],
  ] as const)("(%s) answers 502, undoes everything and lets the person retry at once", async (_label, failure) => {
    h.mailer.failWith = failure;
    const failed = await join("retry@example.com");
    expect(failed.status).toBe(502);
    const body = (await failed.json()) as { error: string; message: string };
    expect(body.error).toBe("email_failed");
    expect(body.message).toMatch(/couldn't send the email/);
    expect(JSON.stringify(body)).not.toMatch(/resend|500|timeout/i);
    expect(h.store.rows.size).toBe(0);
    expect(h.store.tokens.size).toBe(0);
    expect([...h.store.budget.values()]).toEqual([0]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ level: "error", event: "early_access.email_failed", reason: failure.reason }),
    );

    h.mailer.failWith = null;
    const retry = await join("retry@example.com");
    expect(retry.status).toBe(200);
    expect(h.mailer.sent).toHaveLength(1);
  });

  it.each(["network", "timeout"] as const)(
    "retains the budget, throttle, row and usable links when %s leaves delivery ambiguous",
    async (reason) => {
      h.mailer.failWith = { ok: false, reason };
      const failed = await join("ambiguous@example.com");
      expect(failed.status).toBe(502);
      expect(h.store.rows.has("ambiguous@example.com")).toBe(true);
      expect(h.store.tokens.size).toBe(2);
      expect([...h.store.budget.values()]).toEqual([1]);

      h.mailer.failWith = null;
      expect((await join("ambiguous@example.com")).status).toBe(200);
      expect(h.mailer.sent).toHaveLength(0);
    },
  );

  it("keeps an existing row as it was, throttle included", async () => {
    await join("kept@example.com");
    const before = { ...h.store.rows.get("kept@example.com") };
    h.advance(11 * MINUTE);
    h.mailer.failWith = { ok: false, reason: "rejected", status: 500 };
    expect((await join("kept@example.com")).status).toBe(502);
    expect(h.store.rows.get("kept@example.com")).toEqual(before);
    expect(h.store.tokens.size).toBe(2); // the links from the first email still work
    const removal = await handleRequest(post(REMOVE_PATH, { email: "kept@example.com" }), h.deps);
    expect(removal.status).toBe(502);
    expect(h.store.rows.get("kept@example.com")).toEqual(before);
  });
});

describe("logs", () => {
  it("never contain an address or a link code", async () => {
    await join("private@example.com");
    const code = linkToken(lastEmail().text, confirmPath);
    await handleRequest(post(CONFIRM_PATH, { token: code }), h.deps);
    h.mailer.failWith = { ok: false, reason: "rejected", status: 422 };
    h.advance(11 * MINUTE);
    await handleRequest(post(REMOVE_PATH, { email: "private@example.com" }), h.deps);
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain("private@");
    expect(text).not.toContain("example.com");
    expect(text).not.toContain(code);
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "early_access.email_failed", status: "422" }));
  });
});

describe("cleanup", () => {
  it("deletes expired links and unconfirmed sign-ups, keeping confirmed and legacy rows", async () => {
    h.store.seed("legacy@example.com", "legacy_unconfirmed");
    h.store.seed("confirmed@example.com", "confirmed");
    await join("pending@example.com");
    h.advance(EARLY_ACCESS_EMAIL.linkTtlHours * HOUR - MINUTE);
    await scheduledPurge(h.deps);
    expect(h.store.rows.has("pending@example.com")).toBe(true);

    h.advance(MINUTE);
    await scheduledPurge(h.deps);
    expect([...h.store.rows.keys()].sort()).toEqual(["confirmed@example.com", "legacy@example.com"]);
    expect(h.store.tokens.size).toBe(0);
    expect(h.logs).toContainEqual({ level: "info", event: "early_access.purged" });
  });

  it("also runs on every join, so an expired pending address starts over", async () => {
    await join("again@example.com");
    const firstId = h.store.rows.get("again@example.com")?.id;
    h.advance(EARLY_ACCESS_EMAIL.linkTtlHours * HOUR + MINUTE);
    await join("again@example.com");
    expect(h.store.rows.get("again@example.com")?.id).not.toBe(firstId);
    expect(h.store.tokens.size).toBe(2);
  });
});
