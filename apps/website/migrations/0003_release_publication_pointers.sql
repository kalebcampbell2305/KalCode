-- Immutable release descriptors and the only authoritative mutable channel pointer.
-- Release tooling first claims an immutable (channel, version) row, then advances the channel
-- with a monotonic atomic UPSERT. Public Worker routes join through these tables and fail closed.
CREATE TABLE release_publication_versions (
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta', 'dev')),
  version TEXT NOT NULL CHECK (length(version) BETWEEN 5 AND 256),
  precedence_key TEXT NOT NULL CHECK (length(precedence_key) BETWEEN 7 AND 1024),
  updater_descriptor_key TEXT NOT NULL,
  download_descriptor_key TEXT NOT NULL,
  updater_descriptor_sha256 TEXT NOT NULL CHECK (
    length(updater_descriptor_sha256) = 64
    AND updater_descriptor_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  download_descriptor_sha256 TEXT NOT NULL CHECK (
    length(download_descriptor_sha256) = 64
    AND download_descriptor_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  published_at TEXT NOT NULL CHECK (length(published_at) BETWEEN 20 AND 32),
  PRIMARY KEY (channel, version),
  UNIQUE (channel, version, precedence_key),
  CHECK (
    updater_descriptor_key =
      'releases/updater/' || channel || '/' || version || '/' || updater_descriptor_sha256 || '.json'
  ),
  CHECK (
    download_descriptor_key =
      'releases/' || version || '/' || download_descriptor_sha256 || '.json'
  )
) STRICT;

CREATE TABLE release_publication_pointers (
  channel TEXT PRIMARY KEY CHECK (channel IN ('stable', 'beta', 'dev')),
  version TEXT NOT NULL,
  precedence_key TEXT NOT NULL CHECK (length(precedence_key) BETWEEN 7 AND 1024),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  FOREIGN KEY (channel, version, precedence_key)
    REFERENCES release_publication_versions (channel, version, precedence_key)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER release_publication_versions_no_update
BEFORE UPDATE ON release_publication_versions
BEGIN
  SELECT RAISE(ABORT, 'release publication versions are immutable');
END;

-- SQLite's REPLACE conflict policy deletes the old row after BEFORE INSERT triggers run. With
-- recursive_triggers disabled (D1's default), that implicit delete does not invoke the DELETE
-- trigger below. Admit an exact idempotent claim, but reject a conflicting descriptor before
-- conflict handling can replace the immutable row.
CREATE TRIGGER release_publication_versions_no_conflicting_insert
BEFORE INSERT ON release_publication_versions
WHEN EXISTS (
  SELECT 1
  FROM release_publication_versions
  WHERE channel = NEW.channel
    AND version = NEW.version
    AND (
      precedence_key IS NOT NEW.precedence_key
      OR updater_descriptor_key IS NOT NEW.updater_descriptor_key
      OR download_descriptor_key IS NOT NEW.download_descriptor_key
      OR updater_descriptor_sha256 IS NOT NEW.updater_descriptor_sha256
      OR download_descriptor_sha256 IS NOT NEW.download_descriptor_sha256
      OR published_at IS NOT NEW.published_at
    )
)
BEGIN
  SELECT RAISE(ABORT, 'release publication versions are immutable');
END;

CREATE TRIGGER release_publication_versions_no_delete
BEFORE DELETE ON release_publication_versions
BEGIN
  SELECT RAISE(ABORT, 'release publication versions are immutable');
END;

CREATE TRIGGER release_publication_pointers_match_version_insert
BEFORE INSERT ON release_publication_pointers
WHEN NOT EXISTS (
  SELECT 1
  FROM release_publication_versions
  WHERE channel = NEW.channel
    AND version = NEW.version
    AND precedence_key = NEW.precedence_key
)
BEGIN
  SELECT RAISE(ABORT, 'release publication pointer must match immutable version precedence');
END;

CREATE TRIGGER release_publication_pointers_no_regression_insert
BEFORE INSERT ON release_publication_pointers
WHEN EXISTS (
  SELECT 1
  FROM release_publication_pointers
  WHERE channel = NEW.channel
    AND (
      precedence_key > NEW.precedence_key
      OR (precedence_key = NEW.precedence_key AND version <> NEW.version)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'release publication pointer insert cannot regress or change equal precedence');
END;

CREATE TRIGGER release_publication_pointers_match_version_update
BEFORE UPDATE ON release_publication_pointers
WHEN NOT EXISTS (
  SELECT 1
  FROM release_publication_versions
  WHERE channel = NEW.channel
    AND version = NEW.version
    AND precedence_key = NEW.precedence_key
)
BEGIN
  SELECT RAISE(ABORT, 'release publication pointer must match immutable version precedence');
END;

CREATE TRIGGER release_publication_pointers_no_regression
BEFORE UPDATE ON release_publication_pointers
WHEN NEW.precedence_key < OLD.precedence_key
  OR (NEW.precedence_key = OLD.precedence_key AND NEW.version <> OLD.version)
BEGIN
  SELECT RAISE(ABORT, 'release publication pointer cannot regress or change equal precedence');
END;

CREATE TRIGGER release_publication_pointers_no_delete
BEFORE DELETE ON release_publication_pointers
BEGIN
  SELECT RAISE(ABORT, 'release publication pointer withdrawal requires an audited migration');
END;
