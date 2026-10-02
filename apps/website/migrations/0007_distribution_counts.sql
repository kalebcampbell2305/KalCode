-- Anonymous distribution counts for the private owner dashboard (docs/OWNER_ANALYTICS.md).
--
-- Recorded server-side from requests the site already serves: installer downloads from a browser,
-- update checks and update downloads from the desktop updater (User-Agent `KalCode/<version>`).
-- Nothing identifies a person or a device: no IP address, no User-Agent string, no cookie, no
-- installation id. Only the UTC day (or event time), the event kind, the platform/architecture
-- implied by the requested file, and the KalCode versions involved.

-- One row per (day, kind, platform, arch, version, from_version) with a running count.
--   download         a browser started an installer download; version = the installer's version
--   update_check     a desktop client fetched the stable update feed; version = the client's version
--   update_download  a desktop client downloaded an update; version = the target, from_version = the
--                    client's version
CREATE TABLE distribution_daily (
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  event TEXT NOT NULL CHECK (event IN ('download', 'update_check', 'update_download')),
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'macos', 'unknown')),
  arch TEXT NOT NULL CHECK (arch IN ('x64', 'arm64', 'unknown')),
  version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 40),
  from_version TEXT NOT NULL DEFAULT '' CHECK (length(from_version) <= 40),
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (day, event, platform, arch, version, from_version)
) STRICT;

-- The recent-activity feed: downloads and update downloads only (never update checks), kept for
-- 90 days by the hourly cron.
CREATE TABLE distribution_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL CHECK (occurred_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  event TEXT NOT NULL CHECK (event IN ('download', 'update_download')),
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'macos', 'unknown')),
  arch TEXT NOT NULL CHECK (arch IN ('x64', 'arm64', 'unknown')),
  version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 40),
  from_version TEXT NOT NULL DEFAULT '' CHECK (length(from_version) <= 40)
) STRICT;

CREATE INDEX distribution_events_time ON distribution_events (occurred_at);
