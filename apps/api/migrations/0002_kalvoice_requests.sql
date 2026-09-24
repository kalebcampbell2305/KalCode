-- KalVoice Request usage ledger (docs/BILLING.md §7, docs/DATA_MODEL.md §4).
--
-- One row per counted top-level KalVoice request. It stores only an opaque client request id and
-- when the request was recorded: never request text, transcripts, audio, model names or provider
-- output. Provider model tokens are not KalVoice Requests and are never recorded here.
--
-- Invariants:
--   * At most once per (account, client request id): retries and offline replays are idempotent.
--   * Append-only: a counted request is never edited or removed.
--   * The allowance check and the insert happen in one statement (apps/api/worker/lib/store.ts),
--     so concurrent requests cannot both take the last unit of an allowance.

CREATE TABLE kalvoice_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  client_request_id TEXT NOT NULL CHECK (
    length(client_request_id) BETWEEN 8 AND 128
    AND client_request_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  recorded_at TEXT NOT NULL CHECK (recorded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  -- 'online': checked against the allowance before the request ran.
  -- 'offline_replay': served on the device while offline, reported afterwards (docs/BILLING.md §7).
  source TEXT NOT NULL CHECK (source IN ('online', 'offline_replay')),
  -- 1 when an offline replay landed beyond the cycle's allowance (kept so overruns are visible).
  over_allowance INTEGER NOT NULL DEFAULT 0 CHECK (over_allowance IN (0, 1)),
  UNIQUE (account_id, client_request_id)
);

CREATE INDEX kalvoice_requests_account_time ON kalvoice_requests (account_id, recorded_at);

CREATE TRIGGER kalvoice_requests_append_only_update
BEFORE UPDATE ON kalvoice_requests
BEGIN
  SELECT RAISE(ABORT, 'kalvoice_requests is append-only');
END;

CREATE TRIGGER kalvoice_requests_append_only_delete
BEFORE DELETE ON kalvoice_requests
BEGIN
  SELECT RAISE(ABORT, 'kalvoice_requests is append-only');
END;
