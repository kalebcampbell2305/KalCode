-- KalCode schema v5: event correlation (lead platform task L-1). Owner: native-core events.
-- Append-only. Never edit after release; add a new numbered migration instead.
--
-- Optional correlation ids added to the Event Protocol envelope in protocol v1
-- (docs/EVENT_PROTOCOL.md §6: adding optional correlation fields is non-breaking). Existing rows
-- keep NULL. Partial indexes, like the v1 correlation indexes, so rows without an id cost nothing.

ALTER TABLE events ADD COLUMN agent_id TEXT;
ALTER TABLE events ADD COLUMN task_id TEXT;
ALTER TABLE events ADD COLUMN automation_id TEXT;
-- Id of the event that directly caused this one (Time Machine causality, automation loop checks).
ALTER TABLE events ADD COLUMN causation_id TEXT;

CREATE INDEX events_agent_id_idx      ON events (agent_id)      WHERE agent_id IS NOT NULL;
CREATE INDEX events_task_id_idx       ON events (task_id)       WHERE task_id IS NOT NULL;
CREATE INDEX events_automation_id_idx ON events (automation_id) WHERE automation_id IS NOT NULL;
CREATE INDEX events_causation_id_idx  ON events (causation_id)  WHERE causation_id IS NOT NULL;
-- `request_id` had no index in v1; `events_query` filters on it (approvals, KalVoice requests).
CREATE INDEX events_request_id_idx    ON events (request_id)    WHERE request_id IS NOT NULL;
