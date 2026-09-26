import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";
import { CONSENT_VERSION, EARLY_ACCESS_EMAIL } from "../../src/lib/site";
import { scheduledPurge, THROTTLE } from "../../worker/lib/early-access";
import {
  CONFIRM_PATH,
  type Deps,
  handleRequest,
  REMOVE_CONFIRM_PATH,
  REMOVE_PATH,
  SIGNUP_OK,
  SIGNUP_PATH,
} from "../../worker/lib/router";
import { d1Store, type EarlyAccessStore } from "../../worker/lib/store";
import { hashToken } from "../../worker/lib/tokens";
import { type FakeMailer, fakeMailer, linkToken } from "./fakes";

// Runs the real D1 store and the whole early-access flow against workerd's local D1 simulation
// (in memory, never the production database), with migrations/ applied in order. Checks what
// the in-memory fake cannot: the SQL, the constraints, the migration of existing rows,
// single-use deletes and the conditional throttle and budget writes.

type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let proxy: Proxy;
let db: D1Database;
let store: EarlyAccessStore;

const T0 = new Date("2026-09-24T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function statements(file: string): string[] {
  const sql = readFileSync(fileURLToPath(new URL(`../../migrations/${file}`, import.meta.url)), "utf8");
  return unstable_splitSqlQuery(sql);
}

async function migrate(file: string): Promise<void> {
  for (const statement of statements(file)) await db.prepare(statement).run();
}

async function row(email: string) {
  return db.prepare("SELECT * FROM early_access WHERE email = ?1").bind(email).first<Record<string, unknown>>();
}

async function count(table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: fileURLToPath(new URL("./fixtures/wrangler.d1.jsonc", import.meta.url)),
    persist: false,
  });
  db = proxy.env.DB;
  await migrate("0001_early_access.sql");
  // A row written by the previous Worker version, before double opt-in existed.
  await db
    .prepare("INSERT INTO early_access (email, created_at, source, consent_version) VALUES (?1, ?2, ?3, ?4)")
    .bind("legacy@example.com", "2026-09-20T08:00:00.000Z", "/", "2026-09-24")
    .run();
  await migrate("0002_double_opt_in.sql");
  await migrate("0004_account_mail_dispatch.sql");
  await migrate("0005_fair_email_admission.sql");
  store = d1Store(db);
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM marketing_email_dispatches"),
    db.prepare("DELETE FROM account_email_dispatches"),
    db.prepare("DELETE FROM early_access_tokens"),
    db.prepare("DELETE FROM early_access WHERE email != 'legacy@example.com'"),
    db.prepare("DELETE FROM email_send_budget"),
    db.prepare(
      "UPDATE early_access SET status = 'legacy_unconfirmed', confirmed_at = NULL, last_email_at = NULL, email_day = NULL, email_day_count = 0",
    ),
  ]);
});

describe("migration 0002", () => {
  it("marks existing rows legacy_unconfirmed and keeps their data", async () => {
    expect(await row("legacy@example.com")).toMatchObject({
      email: "legacy@example.com",
      created_at: "2026-09-20T08:00:00.000Z",
      consent_version: "2026-09-24",
      status: "legacy_unconfirmed",
      confirmed_at: null,
      email_day_count: 0,
    });
  });

  it("gives rows inserted the old way (no status) the legacy status", async () => {
    await db
      .prepare(
        "INSERT INTO early_access (email, created_at, source, consent_version) VALUES ('old-code@example.com', 'x', NULL, 'v')",
      )
      .run();
    expect((await row("old-code@example.com"))?.status).toBe("legacy_unconfirmed");
  });

  it("enforces the status and link constraints", async () => {
    await expect(
      db.prepare("UPDATE early_access SET status = 'maybe' WHERE email = 'legacy@example.com'").run(),
    ).rejects.toThrow(/CHECK/);
    const id = (await row("legacy@example.com"))?.id;
    await expect(
      db.prepare("INSERT INTO early_access_tokens VALUES ('short', ?1, 'confirm', 'x', 'y')").bind(id).run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db.prepare("INSERT INTO early_access_tokens VALUES (?1, 999999, 'confirm', 'x', 'y')").bind("f".repeat(64)).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe("d1Store", () => {
  const signup = (email: string, createdAt = T0) => ({
    email,
    source: "/download",
    createdAt: createdAt.toISOString(),
    consentVersion: CONSENT_VERSION,
  });

  it("adds a pending row once and reports whether it created it", async () => {
    const first = await store.addPending(signup("a@example.com"));
    const second = await store.addPending(signup("A@Example.com"));
    expect(first.created).toBe(true);
    expect(second).toEqual({ subscriber: first.subscriber, created: false });
    expect(first.subscriber.status).toBe("pending");
  });

  it("updates the consent version of an unconfirmed row, not a confirmed one", async () => {
    await store.addPending(signup("legacy@example.com"));
    expect((await row("legacy@example.com"))?.consent_version).toBe(CONSENT_VERSION);
    await db
      .prepare(
        "UPDATE early_access SET status = 'confirmed', consent_version = 'old' WHERE email = 'legacy@example.com'",
      )
      .run();
    await store.addPending(signup("legacy@example.com"));
    expect((await row("legacy@example.com"))?.consent_version).toBe("old");
  });

  it("claims the per-address throttle atomically and gives it back", async () => {
    const { subscriber } = await store.addPending(signup("t@example.com"));
    const claims = await Promise.all([1, 2, 3].map(() => store.claimAddressSend(subscriber.id, T0, THROTTLE)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.claimAddressSend(subscriber.id, new Date(T0.getTime() + 9 * MINUTE), THROTTLE)).toBeNull();

    const claim = claims.find(Boolean);
    if (!claim) throw new Error("no claim");
    await store.releaseAddressSend(claim);
    expect(await row("t@example.com")).toMatchObject({ last_email_at: null, email_day: null, email_day_count: 0 });
  });

  it("caps emails per address per UTC day", async () => {
    const { subscriber } = await store.addPending(signup("cap@example.com"));
    let sent = 0;
    for (let i = 0; i < 8; i += 1) {
      if (await store.claimAddressSend(subscriber.id, new Date(T0.getTime() + i * 11 * MINUTE), THROTTLE)) sent += 1;
    }
    expect(sent).toBe(EARLY_ACCESS_EMAIL.dailyPerAddress);
    expect(await store.claimAddressSend(subscriber.id, new Date(T0.getTime() + 13 * HOUR), THROTTLE)).not.toBeNull();
  });

  it("keeps the site-wide daily budget, even under concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => store.claimMarketingSend(T0, 34)));
    expect(results.filter(Boolean)).toHaveLength(4);
    const claim = results.find(Boolean);
    if (!claim) throw new Error("no marketing claim");
    await store.finalizeMarketingSend(claim, "rejected");
    expect(await store.claimMarketingSend(T0, 34)).not.toBeNull();
    expect(await store.claimMarketingSend(T0, 34)).toBeNull();
    expect(await store.claimMarketingSend(new Date(T0.getTime() + 24 * HOUR), 34)).not.toBeNull();
    expect(await store.claimMarketingSend(T0, 0)).toBeNull();
  });

  it("confirms with a link once, even when used twice at the same moment", async () => {
    const { subscriber } = await store.addPending(signup("c@example.com"));
    const hash = await hashToken("confirm-code");
    await store.addTokens([
      {
        hash,
        subscriberId: subscriber.id,
        purpose: "confirm",
        createdAt: T0.toISOString(),
        expiresAt: "2026-09-27T12:00:00.000Z",
      },
    ]);
    const results = await Promise.all([store.confirmByToken(hash, T0), store.confirmByToken(hash, T0)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await row("c@example.com")).toMatchObject({ status: "confirmed", confirmed_at: T0.toISOString() });
    expect(await count("early_access_tokens")).toBe(0);
  });

  it("rejects and deletes an expired link without confirming", async () => {
    const { subscriber } = await store.addPending(signup("e@example.com"));
    const hash = await hashToken("expired-code");
    await store.addTokens([
      {
        hash,
        subscriberId: subscriber.id,
        purpose: "confirm",
        createdAt: T0.toISOString(),
        expiresAt: T0.toISOString(),
      },
    ]);
    expect(await store.confirmByToken(hash, T0)).toBe(false);
    expect((await row("e@example.com"))?.status).toBe("pending");
    expect(await count("early_access_tokens")).toBe(0);
  });

  it("removes a row and all of its links with a removal link", async () => {
    const { subscriber } = await store.addPending(signup("r@example.com"));
    const expiresAt = "2026-09-27T12:00:00.000Z";
    const remove = await hashToken("remove-code");
    await store.addTokens([
      {
        hash: await hashToken("c1"),
        subscriberId: subscriber.id,
        purpose: "confirm",
        createdAt: T0.toISOString(),
        expiresAt,
      },
      { hash: remove, subscriberId: subscriber.id, purpose: "remove", createdAt: T0.toISOString(), expiresAt },
    ]);
    expect(await store.confirmByToken(remove, T0)).toBe(false); // wrong purpose: consumed nothing
    expect(await count("early_access_tokens")).toBe(2);
    expect(await store.removeByToken(remove, T0)).toBe(true);
    expect(await row("r@example.com")).toBeNull();
    expect(await count("early_access_tokens")).toBe(0);
    expect(await store.removeByToken(remove, T0)).toBe(false);
  });

  it("purges expired links, expired pending rows and old budget days", async () => {
    await store.addPending(signup("old-pending@example.com", new Date(T0.getTime() - 80 * HOUR)));
    const fresh = await store.addPending(signup("fresh@example.com", T0));
    await store.addTokens([
      {
        hash: await hashToken("live"),
        subscriberId: fresh.subscriber.id,
        purpose: "confirm",
        createdAt: T0.toISOString(),
        expiresAt: "2026-09-27T12:00:00.000Z",
      },
    ]);
    await store.claimMarketingSend(new Date(T0.getTime() - 24 * HOUR), 90);
    await store.claimMarketingSend(T0, 90);
    await store.purgeExpired(T0, new Date(T0.getTime() - 72 * HOUR));
    expect(await row("old-pending@example.com")).toBeNull();
    expect(await row("fresh@example.com")).not.toBeNull();
    expect(await row("legacy@example.com")).not.toBeNull();
    expect(await count("email_send_budget")).toBe(1);
    expect(await count("early_access_tokens")).toBe(1);
  });
});

describe("the whole flow on local D1", () => {
  let mailer: FakeMailer;
  let now: number;
  let deps: Deps;

  beforeEach(() => {
    mailer = fakeMailer();
    now = T0.getTime();
    deps = {
      assets: { fetch: async () => new Response("page") },
      store,
      mailer,
      limiter: { limit: async () => ({ success: true }) },
      now: () => new Date(now),
      log: () => undefined,
      newToken: () => crypto.randomUUID().replace(/-/g, "").padEnd(43, "x").slice(0, 43),
      dailyEmailLimit: 90,
      localLinkOrigin: null,
    };
  });

  const post = (path: string, body: unknown) =>
    handleRequest(
      new Request(`https://kalcoded.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      deps,
    );

  it("join → confirm → removal request → remove", async () => {
    const joined = await post(SIGNUP_PATH, { email: "flow@example.com", source: "/" });
    expect(await joined.json()).toEqual(SIGNUP_OK);
    expect((await row("flow@example.com"))?.status).toBe("pending");
    const confirmCode = linkToken(mailer.sent[0]?.text ?? "", EARLY_ACCESS_EMAIL.confirmPath);

    expect((await post(CONFIRM_PATH, { token: confirmCode })).status).toBe(200);
    expect((await row("flow@example.com"))?.status).toBe("confirmed");
    expect((await post(CONFIRM_PATH, { token: confirmCode })).status).toBe(410);

    now += 11 * MINUTE;
    expect((await post(REMOVE_PATH, { email: "flow@example.com" })).status).toBe(200);
    const removeCode = linkToken(mailer.sent[1]?.text ?? "", EARLY_ACCESS_EMAIL.removePath);
    expect((await post(REMOVE_CONFIRM_PATH, { token: removeCode })).status).toBe(200);
    expect(await row("flow@example.com")).toBeNull();
    expect(await count("early_access_tokens")).toBe(0);
  });

  it("undoes a failed send completely, so an immediate retry works", async () => {
    mailer.failWith = { ok: false, reason: "rejected", status: 500 };
    expect((await post(SIGNUP_PATH, { email: "fail@example.com", source: "/" })).status).toBe(502);
    expect(await row("fail@example.com")).toBeNull();
    expect(await count("early_access_tokens")).toBe(0);
    expect((await db.prepare("SELECT sent FROM email_send_budget").first<{ sent: number }>())?.sent).toBe(0);

    mailer.failWith = null;
    expect((await post(SIGNUP_PATH, { email: "fail@example.com", source: "/" })).status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
  });

  it("the cron cleanup deletes an unconfirmed sign-up once its link expires", async () => {
    await post(SIGNUP_PATH, { email: "late@example.com", source: "/" });
    now += EARLY_ACCESS_EMAIL.linkTtlHours * HOUR;
    await scheduledPurge(deps);
    expect(await row("late@example.com")).toBeNull();
    expect(await row("legacy@example.com")).not.toBeNull();
  });
});
