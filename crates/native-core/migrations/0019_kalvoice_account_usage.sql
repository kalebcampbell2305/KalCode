-- Account-scoped durable metering outbox. No transcript, bearer, or provider content.
-- Existing unscoped execution rows cannot be attributed to a signed-in account.
CREATE TABLE kalvoice_account_usage (
    account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 128),
    request_id TEXT NOT NULL CHECK(length(request_id) = 36),
    recorded_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('unconfirmed', 'pending', 'synced', 'denied')),
    PRIMARY KEY(account_id, request_id)
);
CREATE INDEX kalvoice_account_usage_pending ON kalvoice_account_usage(account_id, status, recorded_at);
