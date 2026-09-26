-- Bind each social authorization attempt to its initiating client. Existing GitHub and OIDC
-- attempts predate website social sign-in and remain desktop attempts by construction.
ALTER TABLE oauth_attempts
  ADD COLUMN client_kind TEXT NOT NULL DEFAULT 'desktop'
  CHECK (client_kind IN ('desktop', 'website'));

-- Rollback is application-compatible: older code ignores this additive column. Leave it in place
-- so in-flight attempts retain their client binding while they expire naturally.
