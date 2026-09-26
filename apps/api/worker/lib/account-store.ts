export interface OAuthAttempt {
  stateHash: string;
  codeChallenge: string;
  expiresAt: string;
  consumedAt: string | null;
}

export type AccountIdentityProvider = "github" | "google" | "microsoft";

export interface OpenIdAttempt extends OAuthAttempt {
  provider: Exclude<AccountIdentityProvider, "github">;
  nonceHash: string;
  clientKind: "desktop" | "website";
}

export interface AccountProfile {
  id: string;
  email: string;
  activatedAt: string | null;
}

export interface EmailAttempt {
  verifyHash: string;
  pollHash: string;
  email: string;
  clientKind: "desktop" | "website";
  purpose: "signin" | "delete";
  codeChallenge: string | null;
  expiresAt: string;
  verifiedAt: string | null;
  accountId: string | null;
  consumedAt: string | null;
}

export interface SessionInfo {
  accountId: string;
  clientKind: "desktop" | "website";
  expiresAt: string;
}

interface OAuthAttemptRow {
  state_hash: string;
  code_challenge: string;
  expires_at: string;
  consumed_at: string | null;
}

interface OpenIdAttemptRow extends OAuthAttemptRow {
  provider: "google" | "microsoft";
  nonce_hash: string;
  client_kind: "desktop" | "website";
}

export function d1AccountStore(db: D1Database) {
  return {
    async allowRateLimit(input: {
      bucketHash: string;
      action:
        | "oauth_start"
        | "oauth_complete"
        | "email_start"
        | "email_verify"
        | "email_poll"
        | "session_refresh"
        | "account_delete";
      now: string;
      windowStart: string;
      retentionStart: string;
      limit: number;
    }): Promise<boolean> {
      const [, result] = await db.batch([
        db.prepare("DELETE FROM auth_rate_limits WHERE window_started_at < ?1").bind(input.retentionStart),
        db
          .prepare(
            `INSERT INTO auth_rate_limits (bucket_hash, action, window_started_at, request_count)
           VALUES (?1, ?2, ?3, 1)
           ON CONFLICT (bucket_hash, action) DO UPDATE SET
             window_started_at = CASE WHEN window_started_at < ?4 THEN ?3 ELSE window_started_at END,
             request_count = CASE WHEN window_started_at < ?4 THEN 1 ELSE MIN(request_count + 1, 100000) END
           RETURNING request_count`,
          )
          .bind(input.bucketHash, input.action, input.now, input.windowStart),
      ]);
      const row = result?.results[0] as { request_count: number } | undefined;
      return row !== undefined && row.request_count <= input.limit;
    },

    async createOAuthAttempt(input: {
      stateHash: string;
      codeChallenge: string;
      rateBucket: string;
      createdAt: string;
      expiresAt: string;
    }): Promise<void> {
      await db.batch([
        db.prepare("DELETE FROM oauth_attempts WHERE expires_at <= ?1").bind(input.createdAt),
        db
          .prepare(
            `INSERT INTO oauth_attempts (state_hash, code_challenge, rate_bucket, created_at, expires_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
          )
          .bind(input.stateHash, input.codeChallenge, input.rateBucket, input.createdAt, input.expiresAt),
      ]);
    },

    async createOpenIdAttempt(input: {
      stateHash: string;
      provider: "google" | "microsoft";
      codeChallenge: string;
      nonceHash: string;
      rateBucket: string;
      createdAt: string;
      expiresAt: string;
      clientKind: "desktop" | "website";
    }): Promise<void> {
      await db.batch([
        db.prepare("DELETE FROM oauth_attempts WHERE expires_at <= ?1").bind(input.createdAt),
        db
          .prepare(
            `INSERT INTO oauth_attempts
               (state_hash, code_challenge, rate_bucket, created_at, expires_at, provider, nonce_hash, client_kind)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
          )
          .bind(
            input.stateHash,
            input.codeChallenge,
            input.rateBucket,
            input.createdAt,
            input.expiresAt,
            input.provider,
            input.nonceHash,
            input.clientKind,
          ),
      ]);
    },

    async oauthAttempt(stateHash: string): Promise<OAuthAttempt | null> {
      const row = await db
        .prepare("SELECT state_hash, code_challenge, expires_at, consumed_at FROM oauth_attempts WHERE state_hash = ?1")
        .bind(stateHash)
        .first<OAuthAttemptRow>();
      return row
        ? {
            stateHash: row.state_hash,
            codeChallenge: row.code_challenge,
            expiresAt: row.expires_at,
            consumedAt: row.consumed_at,
          }
        : null;
    },

    async openIdAttempt(stateHash: string, provider: "google" | "microsoft"): Promise<OpenIdAttempt | null> {
      const row = await db
        .prepare(
          `SELECT state_hash, provider, code_challenge, nonce_hash, client_kind, expires_at, consumed_at
           FROM oauth_attempts WHERE state_hash = ?1 AND provider = ?2`,
        )
        .bind(stateHash, provider)
        .first<OpenIdAttemptRow>();
      return row
        ? {
            stateHash: row.state_hash,
            provider: row.provider,
            codeChallenge: row.code_challenge,
            nonceHash: row.nonce_hash,
            clientKind: row.client_kind,
            expiresAt: row.expires_at,
            consumedAt: row.consumed_at,
          }
        : null;
    },

    /** Call only after PKCE has been verified against the loaded challenge. */
    async consumeOAuthAttempt(input: {
      stateHash: string;
      codeChallenge: string;
      consumedAt: string;
    }): Promise<boolean> {
      const result = await db
        .prepare(
          `UPDATE oauth_attempts SET consumed_at = ?3
           WHERE state_hash = ?1 AND code_challenge = ?2 AND consumed_at IS NULL AND expires_at > ?3`,
        )
        .bind(input.stateHash, input.codeChallenge, input.consumedAt)
        .run();
      return (result.meta.changes ?? 0) === 1;
    },

    /** Call only after PKCE and the raw nonce have been verified against the loaded hashes. */
    async consumeOpenIdAttempt(input: {
      stateHash: string;
      provider: "google" | "microsoft";
      codeChallenge: string;
      nonceHash: string;
      clientKind: "desktop" | "website";
      consumedAt: string;
    }): Promise<boolean> {
      const result = await db
        .prepare(
          `UPDATE oauth_attempts SET consumed_at = ?6
           WHERE state_hash = ?1 AND provider = ?2 AND code_challenge = ?3 AND nonce_hash = ?4
             AND client_kind = ?5 AND consumed_at IS NULL AND expires_at > ?6`,
        )
        .bind(input.stateHash, input.provider, input.codeChallenge, input.nonceHash, input.clientKind, input.consumedAt)
        .run();
      return (result.meta.changes ?? 0) === 1;
    },

    async identityAccount(provider: AccountIdentityProvider, subject: string): Promise<string | null> {
      const row = await db
        .prepare(
          `SELECT i.account_id FROM account_identities i JOIN accounts a ON a.id = i.account_id
           WHERE i.provider = ?1 AND i.subject = ?2 AND a.deleted_at IS NULL`,
        )
        .bind(provider, subject)
        .first<{ account_id: string }>();
      return row?.account_id ?? null;
    },

    async createOrGetGitHubAccount(input: {
      accountId: string;
      subject: string;
      email: string;
      now: string;
    }): Promise<string | null> {
      const reconcile = async (accountId: string): Promise<string | null> => {
        const profile = await this.accountProfile(accountId);
        if (!profile) return null;
        if (profile.email === input.email) return accountId;

        try {
          await db.batch([
            db
              .prepare(
                `UPDATE accounts SET email = ?3, email_verified_at = ?4
                 WHERE id = ?1 AND email = ?2 AND deleted_at IS NULL AND email_verified_at <= ?4
                   AND EXISTS (
                     SELECT 1 FROM account_identities
                     WHERE provider = 'github' AND subject = ?5 AND account_id = ?1
                   )`,
              )
              .bind(accountId, profile.email, input.email, input.now, input.subject),
            db
              .prepare(
                `DELETE FROM email_signin_attempts
                 WHERE consumed_at IS NULL AND (email = ?2 OR account_id = ?1)
                   AND EXISTS (
                     SELECT 1 FROM accounts
                     WHERE id = ?1 AND email = ?3 AND email_verified_at = ?4 AND deleted_at IS NULL
                   )`,
              )
              .bind(accountId, profile.email, input.email, input.now),
            db
              .prepare(
                `UPDATE account_sessions SET revoked_at = ?2
                 WHERE account_id = ?1 AND revoked_at IS NULL
                   AND EXISTS (
                     SELECT 1 FROM accounts
                     WHERE id = ?1 AND email = ?3 AND email_verified_at = ?2 AND deleted_at IS NULL
                   )`,
              )
              .bind(accountId, input.now, input.email),
          ]);
        } catch {
          return null;
        }

        const reconciled = await this.accountProfile(accountId);
        return reconciled?.email === input.email ? accountId : null;
      };

      const existing = await this.identityAccount("github", input.subject);
      if (existing) return reconcile(existing);
      try {
        await db.batch([
          db
            .prepare(
              `INSERT INTO accounts (id, email, email_verified_at, created_at)
               SELECT ?1, ?2, ?3, ?3
               WHERE NOT EXISTS (
                 SELECT 1 FROM account_identities WHERE provider = 'github' AND subject = ?4
               )
               ON CONFLICT (id) DO NOTHING`,
            )
            .bind(input.accountId, input.email, input.now, input.subject),
          db
            .prepare(
              `INSERT INTO account_identities (provider, subject, account_id, created_at)
               VALUES ('github', ?1, ?2, ?3) ON CONFLICT (provider, subject) DO NOTHING`,
            )
            .bind(input.subject, input.accountId, input.now),
        ]);
      } catch {
        const raced = await this.identityAccount("github", input.subject);
        return raced ? reconcile(raced) : null;
      }
      const created = await this.identityAccount("github", input.subject);
      return created ? reconcile(created) : null;
    },

    async createOrGetOpenIdAccount(input: {
      accountId: string;
      provider: "google" | "microsoft";
      subject: string;
      email: string;
      now: string;
    }): Promise<string | null> {
      const reconcile = async (accountId: string): Promise<string | null> => {
        const profile = await this.accountProfile(accountId);
        if (!profile) return null;
        if (profile.email === input.email) return accountId;

        try {
          await db.batch([
            db
              .prepare(
                `UPDATE accounts SET email = ?3, email_verified_at = ?4
                 WHERE id = ?1 AND email = ?2 AND deleted_at IS NULL AND email_verified_at <= ?4
                   AND EXISTS (
                     SELECT 1 FROM account_identities
                     WHERE provider = ?5 AND subject = ?6 AND account_id = ?1
                   )`,
              )
              .bind(accountId, profile.email, input.email, input.now, input.provider, input.subject),
            db
              .prepare(
                `DELETE FROM email_signin_attempts
                 WHERE consumed_at IS NULL AND (email = ?2 OR account_id = ?1)
                   AND EXISTS (
                     SELECT 1 FROM accounts
                     WHERE id = ?1 AND email = ?3 AND email_verified_at = ?4 AND deleted_at IS NULL
                   )`,
              )
              .bind(accountId, profile.email, input.email, input.now),
            db
              .prepare(
                `UPDATE account_sessions SET revoked_at = ?2
                 WHERE account_id = ?1 AND revoked_at IS NULL
                   AND EXISTS (
                     SELECT 1 FROM accounts
                     WHERE id = ?1 AND email = ?3 AND email_verified_at = ?2 AND deleted_at IS NULL
                   )`,
              )
              .bind(accountId, input.now, input.email),
          ]);
        } catch {
          return null;
        }

        const reconciled = await this.accountProfile(accountId);
        return reconciled?.email === input.email ? accountId : null;
      };

      const existing = await this.identityAccount(input.provider, input.subject);
      if (existing) return reconcile(existing);
      try {
        await db.batch([
          db
            .prepare(
              `INSERT INTO accounts (id, email, email_verified_at, created_at)
               SELECT ?1, ?2, ?3, ?3
               WHERE NOT EXISTS (
                 SELECT 1 FROM account_identities WHERE provider = ?4 AND subject = ?5
               )
               ON CONFLICT (id) DO NOTHING`,
            )
            .bind(input.accountId, input.email, input.now, input.provider, input.subject),
          db
            .prepare(
              `INSERT INTO account_identities (provider, subject, account_id, created_at)
               VALUES (?1, ?2, ?3, ?4) ON CONFLICT (provider, subject) DO NOTHING`,
            )
            .bind(input.provider, input.subject, input.accountId, input.now),
        ]);
      } catch {
        const raced = await this.identityAccount(input.provider, input.subject);
        return raced ? reconcile(raced) : null;
      }
      const created = await this.identityAccount(input.provider, input.subject);
      return created ? reconcile(created) : null;
    },

    async accountProfile(accountId: string): Promise<AccountProfile | null> {
      const row = await db
        .prepare("SELECT id, email, activated_at FROM accounts WHERE id = ?1 AND deleted_at IS NULL")
        .bind(accountId)
        .first<{ id: string; email: string; activated_at: string | null }>();
      return row ? { id: row.id, email: row.email, activatedAt: row.activated_at } : null;
    },

    async createEmailAttempt(input: {
      verifyHash: string;
      pollHash: string;
      email: string;
      clientKind: "desktop" | "website";
      purpose: "signin" | "delete";
      accountId: string | null;
      codeChallenge: string | null;
      createdAt: string;
      expiresAt: string;
    }): Promise<void> {
      await db.batch([
        db.prepare("DELETE FROM email_signin_attempts WHERE expires_at <= ?1").bind(input.createdAt),
        db
          .prepare(
            `INSERT INTO email_signin_attempts
               (verify_hash, poll_hash, email, client_kind, purpose, code_challenge, account_id, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
          )
          .bind(
            input.verifyHash,
            input.pollHash,
            input.email,
            input.clientKind,
            input.purpose,
            input.codeChallenge,
            input.accountId,
            input.createdAt,
            input.expiresAt,
          ),
      ]);
    },

    async deleteEmailAttempt(verifyHash: string): Promise<void> {
      await db
        .prepare("DELETE FROM email_signin_attempts WHERE verify_hash = ?1 AND consumed_at IS NULL")
        .bind(verifyHash)
        .run();
    },

    async emailAttempt(kind: "verify" | "poll", hash: string): Promise<EmailAttempt | null> {
      const column = kind === "verify" ? "verify_hash" : "poll_hash";
      const row = await db
        .prepare(
          `SELECT verify_hash, poll_hash, email, client_kind, purpose, code_challenge, expires_at,
                  verified_at, account_id, consumed_at
           FROM email_signin_attempts WHERE ${column} = ?1`,
        )
        .bind(hash)
        .first<{
          verify_hash: string;
          poll_hash: string;
          email: string;
          client_kind: "desktop" | "website";
          purpose: "signin" | "delete";
          code_challenge: string | null;
          expires_at: string;
          verified_at: string | null;
          account_id: string | null;
          consumed_at: string | null;
        }>();
      return row
        ? {
            verifyHash: row.verify_hash,
            pollHash: row.poll_hash,
            email: row.email,
            clientKind: row.client_kind,
            purpose: row.purpose,
            codeChallenge: row.code_challenge,
            expiresAt: row.expires_at,
            verifiedAt: row.verified_at,
            accountId: row.account_id,
            consumedAt: row.consumed_at,
          }
        : null;
    },

    async markEmailVerified(input: {
      verifyHash: string;
      accountId: string;
      now: string;
    }): Promise<EmailAttempt | null> {
      const attempt = await this.emailAttempt("verify", input.verifyHash);
      if (!attempt || attempt.consumedAt || attempt.expiresAt <= input.now) return null;
      await db
        .prepare(
          `INSERT INTO accounts (id, email, email_verified_at, created_at)
           VALUES (?1, ?2, ?3, ?3) ON CONFLICT (email) DO NOTHING`,
        )
        .bind(input.accountId, attempt.email, input.now)
        .run();
      const account = await db
        .prepare("SELECT id FROM accounts WHERE email = ?1 AND deleted_at IS NULL")
        .bind(attempt.email)
        .first<{ id: string }>();
      if (!account) return null;
      const updated = await db
        .prepare(
          `UPDATE email_signin_attempts SET verified_at = COALESCE(verified_at, ?2), account_id = ?3
           WHERE verify_hash = ?1 AND consumed_at IS NULL AND expires_at > ?2
           RETURNING verify_hash`,
        )
        .bind(input.verifyHash, input.now, account.id)
        .first<{ verify_hash: string }>();
      return updated ? this.emailAttempt("verify", input.verifyHash) : null;
    },

    async consumeEmailAttempt(input: {
      verifyHash: string;
      consumeNonce: string;
      tokenHash: string;
      createdAt: string;
      expiresAt: string;
    }): Promise<SessionInfo | null> {
      const [, insert] = await db.batch([
        db
          .prepare(
            `UPDATE email_signin_attempts SET consumed_at = ?3, consume_nonce = ?2
             WHERE verify_hash = ?1 AND verified_at IS NOT NULL AND account_id IS NOT NULL
               AND consumed_at IS NULL AND expires_at > ?3`,
          )
          .bind(input.verifyHash, input.consumeNonce, input.createdAt),
        db
          .prepare(
            `INSERT INTO account_sessions
               (token_hash, account_id, created_at, expires_at, client_kind)
             SELECT ?2, e.account_id, ?3, ?4, e.client_kind FROM email_signin_attempts e
             JOIN accounts a ON a.id = e.account_id
             WHERE e.verify_hash = ?1 AND e.consume_nonce = ?5 AND a.deleted_at IS NULL
             RETURNING account_id, client_kind, expires_at`,
          )
          .bind(input.verifyHash, input.tokenHash, input.createdAt, input.expiresAt, input.consumeNonce),
      ]);
      const row = insert?.results[0] as
        | { account_id: string; client_kind: "desktop" | "website"; expires_at: string }
        | undefined;
      return row ? { accountId: row.account_id, clientKind: row.client_kind, expiresAt: row.expires_at } : null;
    },

    async createSession(input: {
      tokenHash: string;
      accountId: string;
      createdAt: string;
      expiresAt: string;
      clientKind: "desktop" | "website";
    }): Promise<boolean> {
      const [, insert] = await db.batch([
        db
          .prepare("DELETE FROM account_sessions WHERE expires_at <= ?1 OR revoked_at IS NOT NULL")
          .bind(input.createdAt),
        db
          .prepare(
            `INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at, client_kind)
             SELECT ?1, id, ?3, ?4, ?5 FROM accounts WHERE id = ?2 AND deleted_at IS NULL`,
          )
          .bind(input.tokenHash, input.accountId, input.createdAt, input.expiresAt, input.clientKind),
      ]);
      return (insert?.meta.changes ?? 0) === 1;
    },

    async sessionInfo(tokenHash: string, now: string): Promise<SessionInfo | null> {
      const row = await db
        .prepare(
          `SELECT s.account_id, s.client_kind, s.expires_at FROM account_sessions s
           JOIN accounts a ON a.id = s.account_id
           WHERE s.token_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2 AND a.deleted_at IS NULL`,
        )
        .bind(tokenHash, now)
        .first<{ account_id: string; client_kind: "desktop" | "website"; expires_at: string }>();
      return row ? { accountId: row.account_id, clientKind: row.client_kind, expiresAt: row.expires_at } : null;
    },

    async activeSession(tokenHash: string, now: string): Promise<string | null> {
      return (await this.sessionInfo(tokenHash, now))?.accountId ?? null;
    },

    async rotateSession(input: {
      oldTokenHash: string;
      newTokenHash: string;
      now: string;
      expiresAt: string;
    }): Promise<SessionInfo | null> {
      const [, insert] = await db.batch([
        db
          .prepare(
            `UPDATE account_sessions SET revoked_at = ?3, rotated_to_hash = ?2
             WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?3`,
          )
          .bind(input.oldTokenHash, input.newTokenHash, input.now),
        db
          .prepare(
            `INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at, client_kind)
             SELECT ?2, s.account_id, ?3, ?4, s.client_kind FROM account_sessions s
             JOIN accounts a ON a.id = s.account_id
             WHERE s.token_hash = ?1 AND s.rotated_to_hash = ?2 AND a.deleted_at IS NULL
             RETURNING account_id, client_kind, expires_at`,
          )
          .bind(input.oldTokenHash, input.newTokenHash, input.now, input.expiresAt),
      ]);
      const row = insert?.results[0] as
        | { account_id: string; client_kind: "desktop" | "website"; expires_at: string }
        | undefined;
      return row ? { accountId: row.account_id, clientKind: row.client_kind, expiresAt: row.expires_at } : null;
    },

    async activateFree(accountId: string, now: string): Promise<boolean> {
      const result = await db
        .prepare("UPDATE accounts SET activated_at = COALESCE(activated_at, ?2) WHERE id = ?1 AND deleted_at IS NULL")
        .bind(accountId, now)
        .run();
      return (result.meta.changes ?? 0) === 1;
    },

    async softDeleteAccount(input: {
      verifyHash: string;
      accountId: string;
      consumeNonce: string;
      now: string;
    }): Promise<boolean> {
      const attempt = await this.emailAttempt("verify", input.verifyHash);
      if (
        attempt?.purpose !== "delete" ||
        attempt.accountId !== input.accountId ||
        attempt.consumedAt ||
        attempt.expiresAt <= input.now
      ) {
        return false;
      }
      const redactedEmail = `${input.accountId}@deleted.invalid`;
      // Claim fresh proof in the same transaction as every destructive write. A timestamp
      // cannot fence concurrent attempts: two requests can have the same `now` value.
      const [, account] = await db.batch([
        db
          .prepare(
            `UPDATE email_signin_attempts
             SET verified_at = COALESCE(verified_at, ?3), consumed_at = ?3, consume_nonce = ?4
             WHERE verify_hash = ?1 AND account_id = ?2 AND purpose = 'delete'
               AND client_kind = 'website' AND consumed_at IS NULL AND expires_at > ?3
               AND EXISTS (
                 SELECT 1 FROM accounts
                 WHERE id = ?2 AND deleted_at IS NULL AND email = email_signin_attempts.email
               )
               AND NOT EXISTS (
                 SELECT 1 FROM billing_subscriptions
                 WHERE account_id = ?2 AND status NOT IN ('canceled', 'incomplete_expired')
               )
               AND NOT EXISTS (
                 SELECT 1 FROM entitlement_grants
                 WHERE account_id = ?2 AND tier = 'owner' AND revoked_at IS NULL
               )
               AND NOT EXISTS (
                 SELECT 1 FROM billing_checkout_intents
                 WHERE account_id = ?2 AND expires_at > ?3
               )`,
          )
          .bind(input.verifyHash, input.accountId, input.now, input.consumeNonce),
        db
          .prepare(
            `UPDATE accounts SET email = ?3, deleted_at = ?2, activated_at = NULL
             WHERE id = ?1 AND deleted_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM email_signin_attempts
                 WHERE verify_hash = ?4 AND account_id = ?1 AND consume_nonce = ?5
               )`,
          )
          .bind(input.accountId, input.now, redactedEmail, input.verifyHash, input.consumeNonce),
        db
          .prepare(
            `UPDATE account_sessions SET revoked_at = ?2
             WHERE account_id = ?1 AND revoked_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM email_signin_attempts
                 WHERE verify_hash = ?3 AND account_id = ?1 AND consume_nonce = ?4
               )`,
          )
          .bind(input.accountId, input.now, input.verifyHash, input.consumeNonce),
        db
          .prepare(
            `INSERT INTO audit_log (occurred_at, actor, action, account_id, details)
             SELECT ?2, 'account', 'account.deleted', ?1, json_object('mode', 'soft-delete')
             WHERE EXISTS (
               SELECT 1 FROM email_signin_attempts
               WHERE verify_hash = ?3 AND account_id = ?1 AND consume_nonce = ?4
             )`,
          )
          .bind(input.accountId, input.now, input.verifyHash, input.consumeNonce),
        db
          .prepare(
            `DELETE FROM email_signin_attempts
             WHERE email = ?3 AND verify_hash <> ?2
               AND EXISTS (
                 SELECT 1 FROM email_signin_attempts proof
                 WHERE proof.verify_hash = ?2 AND proof.account_id = ?1 AND proof.consume_nonce = ?4
               )`,
          )
          .bind(input.accountId, input.verifyHash, attempt.email, input.consumeNonce),
        db
          .prepare(
            `DELETE FROM email_signin_attempts
             WHERE verify_hash = ?1 AND account_id = ?2 AND consume_nonce = ?3`,
          )
          .bind(input.verifyHash, input.accountId, input.consumeNonce),
      ]);
      return (account?.meta.changes ?? 0) === 1;
    },

    async revokeSession(tokenHash: string, now: string): Promise<boolean> {
      const result = await db
        .prepare(
          "UPDATE account_sessions SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2",
        )
        .bind(tokenHash, now)
        .run();
      return (result.meta.changes ?? 0) === 1;
    },
  };
}

export type AccountStore = ReturnType<typeof d1AccountStore>;
