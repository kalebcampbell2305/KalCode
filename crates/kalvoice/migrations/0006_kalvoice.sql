-- KalCode schema v6: KalVoice (campaign Z12). Owned by crates/kalvoice; other code reads these
-- tables through that crate's API.
-- Append-only. Never edit after release; add a new numbered migration instead.

-- Provisional local count of KalVoice Requests (docs/KALVOICE.md). One row per top-level
-- request, keyed by the client request id so a retried request is never counted twice. Rows
-- hold ids and facts only: never the request text, a transcript, or audio. Dictation is never
-- recorded here. The server usage ledger is authoritative once accounts exist; `reconciled`
-- marks rows it has acknowledged.
CREATE TABLE kalvoice_requests (
  request_id   TEXT PRIMARY KEY NOT NULL,
  period_start TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  input        TEXT NOT NULL CHECK (input IN ('voice', 'text')),
  intent       TEXT NOT NULL,
  reconciled   INTEGER NOT NULL DEFAULT 0 CHECK (reconciled IN (0, 1))
) STRICT;

CREATE INDEX kalvoice_requests_period_idx ON kalvoice_requests (period_start);

-- KalVoice preferences: shortcuts, intelligence (reasoning provider) selection, speech model,
-- spoken replies. JSON values, validated by crates/kalvoice.
CREATE TABLE kalvoice_preferences (
  key        TEXT PRIMARY KEY NOT NULL,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL
) STRICT;
