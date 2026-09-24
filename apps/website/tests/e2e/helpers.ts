import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PERSIST_DIR = ".wrangler/e2e-state";

let ipCounter = 0;
/**
 * A fresh client IP per test. `wrangler dev` passes `cf-connecting-ip` through, so each test
 * gets its own rate-limit bucket (5 requests / 60 s) and tests stay independent.
 */
export function uniqueIp(): string {
  ipCounter += 1;
  return `198.51.100.${(Date.now() % 200) + ipCounter}`;
}

export function uniqueEmail(label: string): string {
  return `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

export async function useClientIp(page: Page, ip = uniqueIp()): Promise<string> {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": ip });
  return ip;
}

/** Reads rows from the local E2E D1 database (the same one `wrangler dev` serves). */
export function queryEarlyAccess(email: string): { email: string; source: string | null; consent_version: string }[] {
  const safe = email.replace(/'/g, "''");
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
      `SELECT email, source, consent_version FROM early_access WHERE email = '${safe}'`,
    ],
    { cwd: APP_ROOT, encoding: "utf8" },
  );
  const parsed = JSON.parse(output.slice(output.indexOf("["))) as { results: never[] }[];
  return parsed[0]?.results ?? [];
}
