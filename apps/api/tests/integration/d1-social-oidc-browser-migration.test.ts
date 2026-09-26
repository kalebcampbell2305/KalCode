import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_DIR, execSql, removeDatabase, wrangler } from "../support/wrangler";

let persistTo: string;

function apply(file: string): void {
  wrangler([
    "d1",
    "execute",
    "kalcode-api",
    "--local",
    "--persist-to",
    persistTo,
    "--file",
    join(API_DIR, "migrations", file),
  ]);
}

beforeAll(() => {
  persistTo = mkdtempSync(join(tmpdir(), "kalcode-api-social-browser-migration-"));
  for (const file of [
    "0001_entitlements.sql",
    "0002_kalvoice_requests.sql",
    "0003_no_replace.sql",
    "0004_max_2x.sql",
    "0005_accounts_billing.sql",
    "0006_owner_billing_exclusion.sql",
    "0007_social_oidc.sql",
    "0008_checkout_retry_binding.sql",
  ]) {
    apply(file);
  }
  execSql(
    persistTo,
    `INSERT INTO oauth_attempts
       (state_hash, code_challenge, rate_bucket, created_at, expires_at, provider, nonce_hash)
     VALUES ('${"s".repeat(43)}', '${"c".repeat(43)}', '${"r".repeat(43)}',
             '2026-09-26T12:00:00.000Z', '2026-09-26T12:10:00.000Z', 'google', '${"n".repeat(43)}');`,
  );
  apply("0009_social_oidc_browser.sql");
});

afterAll(async () => removeDatabase(persistTo));

describe("website social OIDC migration", () => {
  it("preserves in-flight attempts as desktop and admits only the two canonical client kinds", () => {
    expect(execSql(persistTo, "SELECT state_hash, client_kind FROM oauth_attempts")[0]).toEqual([
      { state_hash: "s".repeat(43), client_kind: "desktop" },
    ]);
    expect(() =>
      execSql(
        persistTo,
        `INSERT INTO oauth_attempts
           (state_hash, code_challenge, rate_bucket, created_at, expires_at, provider, nonce_hash, client_kind)
         VALUES ('${"w".repeat(43)}', '${"d".repeat(43)}', '${"b".repeat(43)}',
                 '2026-09-26T12:00:00.000Z', '2026-09-26T12:10:00.000Z', 'google',
                 '${"m".repeat(43)}', 'browser')`,
      ),
    ).toThrow();
    expect(execSql(persistTo, "PRAGMA foreign_key_check")[0]).toEqual([]);
  });
});
