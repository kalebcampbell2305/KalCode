import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page } from "@playwright/test";
import type { ReleaseManifest } from "../../src/data/releases";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/**
 * The committed release manifest as the site presents it: specs assert the state the site is built from.
 * A production build "X.Y.Z+N" is named by its public version "X.Y.Z" everywhere on the site, mirroring
 * displayManifest() in src/lib/releases.ts (which specs cannot import, see isSignedStable). File names and
 * pinned URLs keep the build.
 */
export function presentedManifest(manifest: ReleaseManifest): ReleaseManifest {
  if (!manifest.latest) return manifest;
  return { ...manifest, latest: { ...manifest.latest, version: manifest.latest.version.replace(/\+\d+$/, "") } };
}
export const MANIFEST = presentedManifest(
  JSON.parse(readFileSync(resolve(APP_ROOT, "src/data/releases.json"), "utf8")) as ReleaseManifest,
);
/** The published Windows build, or null while there is no public build. */
export const WINDOWS_BUILD = MANIFEST.latest?.platforms.find((platform) => platform.os === "windows") ?? null;
/** "Stable" or "Preview", as the site labels the manifest's channel (src/lib/releases.ts channelLabel). */
export const CHANNEL_LABEL = MANIFEST.latest?.channel === "stable" ? "Stable" : "Preview";
/**
 * True when a manifest selects a complete signed Stable release (signed Windows x64 and macOS
 * arm64), mirroring signedStableRelease() in src/lib/releases.ts, which specs cannot import:
 * Playwright's loader rejects its JSON import without an import attribute.
 * tests/unit/e2e-helpers.test.ts keeps the two rules equal.
 */
export function isSignedStable(manifest: ReleaseManifest): boolean {
  const latest = manifest.latest;
  return (
    latest?.channel === "stable" &&
    latest.platforms.some((p) => p.os === "windows" && p.arch === "x64" && p.signed) &&
    latest.platforms.some((p) => p.os === "macos" && p.arch === "arm64" && p.signed)
  );
}
/** The committed manifest selects a complete signed Stable release. */
export const SIGNED_STABLE = isSignedStable(MANIFEST);
/**
 * True when /download serves a Stable release (Stable channel with at least one signed build),
 * mirroring servedStableRelease() in src/lib/releases.ts for the same reason as isSignedStable.
 */
export function isServedStable(manifest: ReleaseManifest): boolean {
  const latest = manifest.latest;
  return latest?.channel === "stable" && latest.platforms.some((p) => p.signed);
}
/** The committed manifest's release is served as Stable (KalVoice copy is then shipped). */
export const SERVED_STABLE = isServedStable(MANIFEST);
/**
 * The meta description a page renders once a Stable release is served: /kalvoice drops the
 * catalog's trailing " In development." (src/pages/kalvoice.astro), /terms says "the KalCode app"
 * instead of "the KalCode preview app" (src/pages/terms.astro), a docs page names the served Stable
 * version where its catalog text says 0.1.6 (releaseCopy in src/layouts/Docs.astro), and every other
 * page uses its own.
 */
export function renderedDescription(
  page: { path: string; description: string },
  servedStable = SERVED_STABLE,
  version = MANIFEST.latest?.version ?? "0.1.6",
): string {
  if (!servedStable) return page.description;
  if (page.path === "/kalvoice") return page.description.replace(/ In development\.$/, "");
  if (page.path === "/terms") return page.description.replace(/ preview app\.$/, " app.");
  if (page.path.startsWith("/docs/")) return page.description.replaceAll("0.1.6", version);
  return page.description;
}

/** The local mail sink (tests/e2e/mail-sink.mjs); same default as playwright.config.ts. */
export const MAIL_SINK = `http://127.0.0.1:${Number(process.env.KALCODE_E2E_MAIL_PORT ?? Number(process.env.KALCODE_E2E_PORT ?? 8788) + 1)}`;

let ipCounter = 0;
/**
 * A fresh client IP per test. `wrangler dev` passes `cf-connecting-ip` through, so each test
 * gets its own rate-limit bucket (5 requests / 60 s) and tests stay independent.
 */
export function uniqueIp(): string {
  ipCounter += 1;
  // Synthetic local IPv6 identities: keep both the worker PID and counter inside
  // the /64 prefix, since the production limiter deliberately groups IPv6 hosts
  // by network. Clock modulo arithmetic reused buckets and could overflow IPv4.
  if (process.pid > 0xffffff || ipCounter > 0xffffffff) throw new Error("E2E IP namespace exhausted");
  return `${(0xfd00 | (process.pid >>> 16)).toString(16)}:${(process.pid & 0xffff).toString(16)}:${(ipCounter >>> 16).toString(16)}:${(ipCounter & 0xffff).toString(16)}::1`;
}

export function uniqueEmail(label: string): string {
  return `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

export async function useClientIp(page: Page, ip = uniqueIp()): Promise<string> {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": ip });
  return ip;
}

/** The E2E Worker (`wrangler dev`); same default port as playwright.config.ts. */
const E2E_ORIGIN = `http://127.0.0.1:${Number(process.env.KALCODE_E2E_PORT ?? 8788)}`;
/** Wrangler's Local Explorer API: queries D1 inside the running `wrangler dev` itself. */
const D1_EXPLORER = `${E2E_ORIGIN}/cdn-cgi/local/explorer/api/d1/database`;

// Runs in a child node so d1Local stays synchronous for the specs. Reads {url, sql, params} on
// stdin, finds the DB binding's database, runs the statement and prints its rows as objects.
const D1_QUERY_SCRIPT = `
const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
(async () => {
  const call = async (url, init) => {
    const response = await fetch(url, init);
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) throw new Error(url + " answered " + response.status + " " + JSON.stringify(body?.errors ?? body));
    return body.result;
  };
  const databases = await call(input.url);
  const db = databases.find((d) => d.name === "DB") ?? (databases.length === 1 ? databases[0] : undefined);
  if (!db) throw new Error("no DB binding in " + JSON.stringify(databases));
  const [result] = await call(input.url + "/" + db.uuid + "/raw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql: input.sql, params: input.params }),
  });
  const { columns = [], rows = [] } = result?.results ?? {};
  process.stdout.write(JSON.stringify(rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])))));
})().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  process.exit(1);
});
`;

/**
 * Runs one SQL statement with bound parameters against the local E2E D1 database, inside the
 * running `wrangler dev` through Wrangler's Local Explorer API, and returns its rows.
 *
 * It deliberately never opens the database from a second process. `wrangler d1 execute --local`
 * starts another Miniflare on the same SQLite file: two of those at once fail with "internal
 * error", each call takes seconds, and the Worker's own D1 does not wait for a lock another process
 * holds, so a request that writes while such a call (or any outside write) is in progress answers
 * 500 ("Something went wrong") or 503 ("We can't send more emails today"). Going through the
 * server, the statement is serialised with the Worker's own queries. The explorer binds string
 * parameters only (it answers 400 for anything else), so numbers go in as text or in the SQL.
 */
export function d1Local<T>(sql: string, ...params: string[]): T[] {
  const output = execFileSync(process.execPath, ["-e", D1_QUERY_SCRIPT], {
    input: JSON.stringify({ url: D1_EXPLORER, sql, params }),
    encoding: "utf8",
    windowsHide: true,
  });
  return JSON.parse(output) as T[];
}

export interface EarlyAccessRow {
  email: string;
  source: string | null;
  consent_version: string;
  status: string;
}

/** Reads rows from the local E2E D1 database. */
export function queryEarlyAccess(email: string): EarlyAccessRow[] {
  return d1Local<EarlyAccessRow>(
    "SELECT email, source, consent_version, status FROM early_access WHERE email = ?",
    email,
  );
}

/** Number of stored links (confirmation and removal) for an address. */
export function countLinks(email: string): number {
  const [row] = d1Local<{ n: number }>(
    "SELECT COUNT(*) AS n FROM early_access_tokens WHERE early_access_id IN " +
      "(SELECT id FROM early_access WHERE email = ?)",
    email,
  );
  return row?.n ?? 0;
}

/** Makes every link of an address expire now (for the expired-link tests). */
export function expireLinks(email: string): void {
  d1Local(
    "UPDATE early_access_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE early_access_id IN " +
      "(SELECT id FROM early_access WHERE email = ?)",
    email,
  );
}

/**
 * Gives back the marketing emails earlier tests used from the site's daily email budget once more
 * than half of it is spent. The budget is enforced in D1 (migrations/0005: at most 60 marketing
 * emails per UTC day), so in a persisted E2E database every run spends from the same day's
 * allowance, and a repeated or parallel run would see "We can't send more emails today" instead
 * of the flow under test. Only finished sends are dropped (a send in flight in another worker
 * keeps its claim) and the day's counter is recomputed from the rows that remain: two short
 * writes, made only when needed.
 */
export function resetEmailBudget(): void {
  const [used] = d1Local<{ n: number }>(
    "SELECT COUNT(*) AS n FROM marketing_email_dispatches WHERE claimed_day = ? AND state != 'rejected'",
    new Date().toISOString().slice(0, 10),
  );
  if ((used?.n ?? 0) <= 30) return;
  d1Local("DELETE FROM marketing_email_dispatches WHERE state != 'claimed'");
  d1Local(
    "UPDATE email_send_budget SET sent = " +
      "(SELECT COUNT(*) FROM marketing_email_dispatches m WHERE m.claimed_day = email_send_budget.day AND m.state != 'rejected') + " +
      "(SELECT COUNT(*) FROM account_email_dispatches a WHERE a.claimed_day = email_send_budget.day AND a.state != 'rejected')",
  );
}

export interface CapturedEmail {
  from: string;
  to: string[];
  reply_to: string;
  subject: string;
  text: string;
  html: string;
}

/** Emails the Worker sent to `email`, oldest first. */
export async function mailTo(request: APIRequestContext, email: string): Promise<CapturedEmail[]> {
  const response = await request.get(`${MAIL_SINK}/messages?to=${encodeURIComponent(email)}`);
  return (await response.json()) as CapturedEmail[];
}

/**
 * Makes the next `count` sends to `email` fail as if the provider answered 500 (0 clears it).
 * Scoped to one address: the sink serves every test, and with more than one worker an unscoped
 * failure is taken by whichever send comes next, failing another test and sparing this one.
 */
export async function failNextEmails(request: APIRequestContext, email: string, count: number): Promise<void> {
  const response = await request.post(`${MAIL_SINK}/fail`, { data: { count, to: email } });
  if (!response.ok()) throw new Error(`mail sink /fail answered ${response.status()}`);
}

/** The path and query of the first link in `text` to `pagePath` (e.g. /early-access/confirm?token=…). */
export function linkIn(text: string, pagePath: string): string {
  for (const [href] of text.matchAll(/https?:\/\/\S+/g)) {
    const url = new URL(href);
    if (url.pathname === pagePath && url.searchParams.has("token")) return `${url.pathname}${url.search}`;
  }
  throw new Error(`no ${pagePath} link in the email`);
}
