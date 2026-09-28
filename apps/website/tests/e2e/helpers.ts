import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page } from "@playwright/test";
import type { ReleaseManifest } from "../../src/data/releases";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The committed release manifest: specs assert the state the site is built from. */
export const MANIFEST = JSON.parse(
  readFileSync(resolve(APP_ROOT, "src/data/releases.json"), "utf8"),
) as ReleaseManifest;
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

const PERSIST_DIR = process.env.KALCODE_E2E_PERSIST ?? ".wrangler/e2e-state";
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

/** Runs SQL against the local E2E D1 database (the same one `wrangler dev` serves). */
export function d1Local<T>(sql: string): T[] {
  // Run wrangler's JS entry with node directly: no shell, so the SQL argument is passed intact.
  const output = execFileSync(
    process.execPath,
    [
      resolve(APP_ROOT, "node_modules/wrangler/bin/wrangler.js"),
      "d1",
      "execute",
      "kalcode-web",
      "--local",
      "--persist-to",
      PERSIST_DIR,
      "--json",
      "--command",
      sql,
    ],
    { cwd: APP_ROOT, encoding: "utf8", windowsHide: true },
  );
  const parsed = JSON.parse(output.slice(output.indexOf("["))) as { results: T[] }[];
  return parsed[0]?.results ?? [];
}

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

export interface EarlyAccessRow {
  email: string;
  source: string | null;
  consent_version: string;
  status: string;
}

/** Reads rows from the local E2E D1 database. */
export function queryEarlyAccess(email: string): EarlyAccessRow[] {
  return d1Local<EarlyAccessRow>(
    `SELECT email, source, consent_version, status FROM early_access WHERE email = ${sqlString(email)}`,
  );
}

/** Number of stored links (confirmation and removal) for an address. */
export function countLinks(email: string): number {
  const [row] = d1Local<{ n: number }>(
    "SELECT COUNT(*) AS n FROM early_access_tokens WHERE early_access_id IN " +
      `(SELECT id FROM early_access WHERE email = ${sqlString(email)})`,
  );
  return row?.n ?? 0;
}

/** Makes every link of an address expire now (for the expired-link tests). */
export function expireLinks(email: string): void {
  d1Local(
    "UPDATE early_access_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE early_access_id IN " +
      `(SELECT id FROM early_access WHERE email = ${sqlString(email)})`,
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

/** Makes the next `count` sends fail as if the provider answered 500 (0 clears it). */
export async function failNextEmails(request: APIRequestContext, count: number): Promise<void> {
  await request.post(`${MAIL_SINK}/fail`, { data: { count } });
}

/** The path and query of the first link in `text` to `pagePath` (e.g. /early-access/confirm?token=…). */
export function linkIn(text: string, pagePath: string): string {
  for (const [href] of text.matchAll(/https?:\/\/\S+/g)) {
    const url = new URL(href);
    if (url.pathname === pagePath && url.searchParams.has("token")) return `${url.pathname}${url.search}`;
  }
  throw new Error(`no ${pagePath} link in the email`);
}
