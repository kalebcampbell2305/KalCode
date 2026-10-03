-- KalCode account display name: a cosmetic, profile-level name the account holder chooses.
-- NULL means no name is set and clients fall back to the name they show today (the email's
-- local part). It is never part of sign-in identity, the account id, the verified email, billing,
-- or any signed entitlement or usage document. Validation (trimmed, 1–64 characters, no control
-- or invisible formatting characters) happens in the Worker; the CHECK bounds what can be stored.
ALTER TABLE accounts ADD COLUMN display_name TEXT
  CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 64);
