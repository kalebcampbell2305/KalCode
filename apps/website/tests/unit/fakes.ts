/**
 * In-memory stand-ins for the early-access store and the mailer. The fake store follows the
 * same rules as the D1 store (tests/unit/store-d1.test.ts checks the real one against local D1).
 */
import type { Mailer, OutgoingEmail, SendResult } from "../../worker/lib/mailer";
import {
  type AddressClaim,
  type EarlyAccessStore,
  emailAdmissionCaps,
  type Subscriber,
  type SubscriberStatus,
  type TokenRecord,
  throttleAllows,
  utcDay,
} from "../../worker/lib/store";

export interface FakeRow {
  id: number;
  email: string;
  source: string | null;
  createdAt: string;
  consentVersion: string;
  status: SubscriberStatus;
  confirmedAt: string | null;
  lastEmailAt: string | null;
  emailDay: string | null;
  emailDayCount: number;
}

export interface FakeStore extends EarlyAccessStore {
  rows: Map<string, FakeRow>;
  tokens: Map<string, TokenRecord>;
  budget: Map<string, number>;
  /** Makes every call throw, like a D1 outage. */
  fail: boolean;
  /** Seeds a row as the previous Worker version (or an operator) would have left it. */
  seed(email: string, status: SubscriberStatus, extra?: Partial<FakeRow>): FakeRow;
}

export function fakeStore(): FakeStore {
  const rows = new Map<string, FakeRow>();
  const tokens = new Map<string, TokenRecord>();
  const budget = new Map<string, number>();
  const marketingClaims = new Map<string, { day: string; state: "claimed" | "sent" | "ambiguous" | "rejected" }>();
  let nextId = 1;
  const byId = (id: number) => [...rows.values()].find((row) => row.id === id);
  const subscriber = (row: FakeRow): Subscriber => ({ id: row.id, status: row.status });

  const store: FakeStore = {
    rows,
    tokens,
    budget,
    fail: false,
    seed(email, status, extra = {}) {
      const row: FakeRow = {
        id: nextId++,
        email,
        source: "/",
        createdAt: "2026-09-20T00:00:00.000Z",
        consentVersion: "2026-09-24",
        status,
        confirmedAt: null,
        lastEmailAt: null,
        emailDay: null,
        emailDayCount: 0,
        ...extra,
      };
      rows.set(email, row);
      return row;
    },
    async purgeExpired(now, pendingCutoff) {
      check();
      const nowIso = now.toISOString();
      for (const [hash, token] of tokens) if (token.expiresAt <= nowIso) tokens.delete(hash);
      for (const [email, row] of rows) {
        const liveConfirm = [...tokens.values()].some((t) => t.subscriberId === row.id && t.purpose === "confirm");
        if (row.status === "pending" && row.createdAt <= pendingCutoff.toISOString() && !liveConfirm)
          rows.delete(email);
      }
      for (const day of budget.keys()) if (day < utcDay(now)) budget.delete(day);
      for (const [id, claim] of marketingClaims) if (claim.day < utcDay(now)) marketingClaims.delete(id);
    },
    async find(email) {
      check();
      const row = rows.get(email);
      return row ? subscriber(row) : null;
    },
    async addPending(signup) {
      check();
      const existing = rows.get(signup.email);
      if (existing) {
        if (existing.status !== "confirmed") existing.consentVersion = signup.consentVersion;
        return { subscriber: subscriber(existing), created: false };
      }
      const row = store.seed(signup.email, "pending", {
        source: signup.source,
        createdAt: signup.createdAt,
        consentVersion: signup.consentVersion,
      });
      return { subscriber: subscriber(row), created: true };
    },
    async deleteCreated(id) {
      check();
      for (const [hash, token] of tokens) if (token.subscriberId === id) tokens.delete(hash);
      const row = byId(id);
      if (row && row.status === "pending") rows.delete(row.email);
    },
    async claimAddressSend(id, now, policy) {
      check();
      const row = byId(id);
      if (!row) return null;
      const previous = { lastEmailAt: row.lastEmailAt, emailDay: row.emailDay, emailDayCount: row.emailDayCount };
      const { allowed, nextCount } = throttleAllows(previous, now, policy);
      if (!allowed) return null;
      row.lastEmailAt = now.toISOString();
      row.emailDay = utcDay(now);
      row.emailDayCount = nextCount;
      return { subscriberId: id, claimedAt: row.lastEmailAt, previous } satisfies AddressClaim;
    },
    async releaseAddressSend(claim) {
      check();
      const row = byId(claim.subscriberId);
      if (row && row.lastEmailAt === claim.claimedAt) {
        row.lastEmailAt = claim.previous.lastEmailAt;
        row.emailDay = claim.previous.emailDay;
        row.emailDayCount = claim.previous.emailDayCount;
      }
    },
    async claimMarketingSend(now, limit) {
      check();
      const day = utcDay(now);
      const caps = emailAdmissionCaps(limit);
      const sent = budget.get(day) ?? 0;
      const marketing = [...marketingClaims.values()].filter(
        (claim) => claim.day === day && claim.state !== "rejected",
      ).length;
      if (sent >= caps.hard || marketing >= caps.marketing) return null;
      const claimId = crypto.randomUUID();
      budget.set(day, sent + 1);
      marketingClaims.set(claimId, { day, state: "claimed" });
      return { claimId, day };
    },
    async finalizeMarketingSend(claim, state) {
      check();
      const current = marketingClaims.get(claim.claimId);
      if (!current || current.state !== "claimed") return;
      current.state = state;
      if (state === "rejected") {
        const sent = budget.get(claim.day) ?? 0;
        if (sent > 0) budget.set(claim.day, sent - 1);
      }
    },
    async addTokens(records) {
      check();
      for (const record of records) {
        if (tokens.has(record.hash)) throw new Error("UNIQUE constraint failed");
        tokens.set(record.hash, record);
      }
    },
    async deleteTokens(hashes) {
      check();
      for (const hash of hashes) tokens.delete(hash);
    },
    async confirmByToken(hash, now) {
      check();
      const token = tokens.get(hash);
      if (token?.purpose !== "confirm") return false;
      tokens.delete(hash);
      if (token.expiresAt <= now.toISOString()) return false;
      const row = byId(token.subscriberId);
      if (!row) return false;
      row.status = "confirmed";
      row.confirmedAt = now.toISOString();
      for (const [h, t] of tokens) if (t.subscriberId === row.id && t.purpose === "confirm") tokens.delete(h);
      return true;
    },
    async removeByToken(hash, now) {
      check();
      const token = tokens.get(hash);
      if (token?.purpose !== "remove") return false;
      tokens.delete(hash);
      if (token.expiresAt <= now.toISOString()) return false;
      const row = byId(token.subscriberId);
      if (!row) return false;
      for (const [h, t] of tokens) if (t.subscriberId === row.id) tokens.delete(h);
      rows.delete(row.email);
      return true;
    },
  };
  function check() {
    if (store.fail) throw new Error("D1_ERROR: secret internal detail for x@example.com");
  }
  return store;
}

export interface FakeMailer extends Mailer {
  sent: OutgoingEmail[];
  /** The next sends fail with this result until cleared. */
  failWith: SendResult | null;
}

export function fakeMailer(transport: Mailer["transport"] = "resend"): FakeMailer {
  const mailer: FakeMailer = {
    transport,
    sent: [],
    failWith: null,
    async send(email) {
      if (mailer.failWith) return mailer.failWith;
      mailer.sent.push(email);
      return { ok: true };
    },
  };
  return mailer;
}

/** The `token` query parameter of the first link in `text` that points at `path`. */
export function linkToken(text: string, path: string): string {
  const match = text.match(new RegExp(`https?://[^\\s"]+${path.replace(/\//g, "\\/")}\\?token=([A-Za-z0-9_-]+)`));
  if (!match?.[1]) throw new Error(`no ${path} link in email`);
  return match[1];
}
