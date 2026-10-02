-- Daily recurring-revenue snapshots for the private owner dashboard (docs/OWNER_ANALYTICS.md).
-- One row per UTC day, overwritten during that day and frozen after it. Values come from live-mode
-- Stripe at capture time: active paid subscriptions only, never failed or test-mode payments.
-- Aggregates only: no account, customer, email or subscription id is stored.
CREATE TABLE owner_metric_snapshots (
  day TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  captured_at TEXT NOT NULL CHECK (captured_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  paid_subscribers INTEGER NOT NULL CHECK (paid_subscribers >= 0),
  -- Normalized monthly recurring revenue in USD cents (yearly plans count as amount / 12).
  mrr_cents INTEGER NOT NULL CHECK (mrr_cents >= 0),
  -- {"pro": {"subscribers": n, "mrrCents": n}, "max": …, "max2x": …}
  by_plan TEXT NOT NULL CHECK (json_valid(by_plan))
) STRICT;
