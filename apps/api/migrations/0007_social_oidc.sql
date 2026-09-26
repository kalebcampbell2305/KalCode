-- Extend the canonical KalCode account authority to Google and Microsoft OpenID Connect.
-- Existing GitHub identities and in-flight GitHub PKCE attempts retain their exact identity,
-- account, and one-use state. OIDC nonce values remain outside D1; only SHA-256 hashes are stored.

ALTER TABLE oauth_attempts
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'github'
  CHECK (provider IN ('github', 'google', 'microsoft'));

ALTER TABLE oauth_attempts
  ADD COLUMN nonce_hash TEXT
  CHECK (
    (provider = 'github' AND nonce_hash IS NULL)
    OR (
      provider IN ('google', 'microsoft')
      AND nonce_hash IS NOT NULL
      AND length(nonce_hash) = 43
      AND nonce_hash NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  );

ALTER TABLE account_identities RENAME TO account_identities_github_only;

CREATE TABLE account_identities (
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google', 'microsoft')),
  subject TEXT NOT NULL CHECK (
    (provider = 'github' AND length(subject) BETWEEN 1 AND 64 AND subject NOT GLOB '*[^0-9]*')
    OR (provider = 'google' AND length(subject) BETWEEN 1 AND 255)
    OR (provider = 'microsoft' AND length(subject) BETWEEN 3 AND 320)
  ),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject),
  UNIQUE (provider, account_id)
);

INSERT INTO account_identities (provider, subject, account_id, created_at)
SELECT provider, subject, account_id, created_at FROM account_identities_github_only;

DROP TABLE account_identities_github_only;

-- Rollback is deliberately backup-based because a downgrade cannot represent Google or Microsoft
-- identities or nonce-bound attempts. Before restoring a pre-0007 D1 backup, prove there are no
-- rows where provider <> 'github', stop account writes, restore the backup, and re-run the GitHub
-- sign-in/session probes. Never drop social identities in-place: that could orphan account access.
