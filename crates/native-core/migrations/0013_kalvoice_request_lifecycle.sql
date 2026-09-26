-- KalCode schema v13: durable KalVoice request execution lifecycle.
--
-- The v6 row already is the canonical usage claim. These columns distinguish a request that is
-- still executing, one whose executor completed, and one whose executor returned a stable error.
-- Existing v6-v12 rows predate lifecycle tracking and therefore represent completed requests.
-- No request text, transcript, model output, user-facing message, or provider data is stored.

ALTER TABLE kalvoice_requests
  ADD COLUMN execution_state TEXT NOT NULL DEFAULT 'completed'
    CHECK (execution_state IN ('claimed', 'completed', 'failed'));

ALTER TABLE kalvoice_requests
  ADD COLUMN execution_owner TEXT;

ALTER TABLE kalvoice_requests
  ADD COLUMN outcome_code TEXT
    CHECK (outcome_code IS NULL OR (length(outcome_code) BETWEEN 1 AND 128));
