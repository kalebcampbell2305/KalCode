-- Persist the provider-native reasoning effort selected for a thread. NULL preserves the
-- historical provider-default behavior. Provider adapters validate their own supported levels;
-- this storage boundary keeps the value short, lowercase, and inert.

ALTER TABLE threads ADD COLUMN effort TEXT CHECK (
  effort IS NULL OR (
    length(effort) BETWEEN 1 AND 32
    AND effort = lower(effort)
    AND effort NOT GLOB '*[^a-z0-9_-]*'
  )
);
