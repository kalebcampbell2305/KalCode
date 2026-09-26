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
  persistTo = mkdtempSync(join(tmpdir(), "kalcode-api-social-oidc-migration-"));
  for (const file of [
    "0001_entitlements.sql",
    "0002_kalvoice_requests.sql",
    "0003_no_replace.sql",
    "0004_max_2x.sql",
    "0005_accounts_billing.sql",
    "0006_owner_billing_exclusion.sql",
  ]) {
    apply(file);
  }
  execSql(
    persistTo,
    `INSERT INTO accounts (id, email, email_verified_at, created_at, activated_at)
       VALUES ('acct_github', 'github@example.com', '2026-09-25T11:00:00.000Z',
               '2026-09-25T11:00:00.000Z', '2026-09-25T11:00:00.000Z');
     INSERT INTO account_identities (provider, subject, account_id, created_at)
       VALUES ('github', '123456', 'acct_github', '2026-09-25T11:00:00.000Z');
     INSERT INTO oauth_attempts
       (state_hash, code_challenge, rate_bucket, created_at, expires_at)
       VALUES ('${"s".repeat(43)}', '${"c".repeat(43)}', '${"r".repeat(43)}',
               '2026-09-25T11:00:00.000Z', '2026-09-25T12:10:00.000Z');`,
  );
  apply("0007_social_oidc.sql");
});

afterAll(async () => removeDatabase(persistTo));

describe("social OIDC schema migration", () => {
  it("preserves existing GitHub identity and one-use attempt rows exactly", () => {
    expect(
      execSql(
        persistTo,
        "SELECT provider, subject, account_id, created_at FROM account_identities ORDER BY provider, subject",
      )[0],
    ).toEqual([
      {
        provider: "github",
        subject: "123456",
        account_id: "acct_github",
        created_at: "2026-09-25T11:00:00.000Z",
      },
    ]);
    expect(
      execSql(persistTo, "SELECT state_hash, code_challenge, provider, nonce_hash, consumed_at FROM oauth_attempts")[0],
    ).toEqual([
      {
        state_hash: "s".repeat(43),
        code_challenge: "c".repeat(43),
        provider: "github",
        nonce_hash: null,
        consumed_at: null,
      },
    ]);
    expect(execSql(persistTo, "PRAGMA foreign_key_check")[0]).toEqual([]);
  });

  it("accepts provider-scoped opaque OIDC subjects while preserving one identity per provider per account", () => {
    execSql(
      persistTo,
      `INSERT INTO accounts (id, email, email_verified_at, created_at)
         VALUES ('acct_google', 'google@example.com', '2026-09-25T12:00:00.000Z', '2026-09-25T12:00:00.000Z'),
                ('acct_microsoft', 'microsoft@example.com', '2026-09-25T12:00:00.000Z', '2026-09-25T12:00:00.000Z');
       INSERT INTO account_identities (provider, subject, account_id, created_at)
         VALUES ('google', 'google-subject_123', 'acct_google', '2026-09-25T12:00:00.000Z'),
                ('microsoft', 'aaaabbbb-0000-cccc-1111-dddd2222eeee:opaque-subject',
                 'acct_microsoft', '2026-09-25T12:00:00.000Z');`,
    );
    expect(execSql(persistTo, "SELECT provider, account_id FROM account_identities ORDER BY provider")[0]).toEqual([
      { provider: "github", account_id: "acct_github" },
      { provider: "google", account_id: "acct_google" },
      { provider: "microsoft", account_id: "acct_microsoft" },
    ]);
    expect(() =>
      execSql(
        persistTo,
        `INSERT INTO account_identities (provider, subject, account_id, created_at)
         VALUES ('google', 'another-google-subject', 'acct_google', '2026-09-25T12:01:00.000Z')`,
      ),
    ).toThrow();
  });

  it("requires a nonce hash for OIDC attempts and rejects a nonce on GitHub attempts", () => {
    expect(() =>
      execSql(
        persistTo,
        `INSERT INTO oauth_attempts
           (state_hash, code_challenge, rate_bucket, created_at, expires_at, provider)
         VALUES ('${"a".repeat(43)}', '${"b".repeat(43)}', '${"d".repeat(43)}',
                 '2026-09-25T12:00:00.000Z', '2026-09-25T12:10:00.000Z', 'google')`,
      ),
    ).toThrow();
    expect(() =>
      execSql(
        persistTo,
        `INSERT INTO oauth_attempts
           (state_hash, code_challenge, rate_bucket, created_at, expires_at, provider, nonce_hash)
         VALUES ('${"e".repeat(43)}', '${"f".repeat(43)}', '${"g".repeat(43)}',
                 '2026-09-25T12:00:00.000Z', '2026-09-25T12:10:00.000Z', 'github', '${"n".repeat(43)}')`,
      ),
    ).toThrow();
  });

  it("preserves canonical account email uniqueness across every identity provider", () => {
    expect(() =>
      execSql(
        persistTo,
        `INSERT INTO accounts (id, email, email_verified_at, created_at)
         VALUES ('acct_collision', 'GITHUB@example.com', '2026-09-25T12:00:00.000Z',
                 '2026-09-25T12:00:00.000Z')`,
      ),
    ).toThrow();
  });
});
