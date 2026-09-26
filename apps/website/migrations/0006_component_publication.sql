-- Signed local-component catalogs. D1 selects one immutable catalog per channel and native
-- target; R2 stores only content-addressed catalog tokens and artifact bytes.
CREATE TABLE component_catalog_versions (
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta', 'dev')),
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'macos')),
  arch TEXT NOT NULL CHECK (arch IN ('x86_64', 'aarch64')),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  catalog_key TEXT NOT NULL,
  catalog_sha256 TEXT NOT NULL CHECK (
    length(catalog_sha256) = 64
    AND catalog_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  catalog_size_bytes INTEGER NOT NULL CHECK (catalog_size_bytes BETWEEN 1 AND 196608),
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  published_at TEXT NOT NULL CHECK (length(published_at) BETWEEN 20 AND 32),
  PRIMARY KEY (channel, platform, arch, sequence),
  CHECK (
    (platform = 'windows' AND arch = 'x86_64')
    OR (platform = 'macos' AND arch = 'aarch64')
  ),
  CHECK (
    catalog_key =
      'components/v1/catalog/' || channel || '/' || platform || '/' || arch || '/' ||
      sequence || '/' || catalog_sha256 || '.jws'
  )
) STRICT;

CREATE TABLE component_catalog_artifacts (
  channel TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('reason-runtime', 'reason-model', 'speech-model')),
  component_id TEXT NOT NULL CHECK (
    length(component_id) BETWEEN 1 AND 128
    AND component_id NOT LIKE '%..%'
    AND component_id NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('runtime', 'model')),
  version TEXT NOT NULL CHECK (
    length(version) BETWEEN 1 AND 64
    AND version NOT LIKE '%..%'
    AND version NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  file TEXT NOT NULL CHECK (
    length(file) BETWEEN 1 AND 160
    AND file NOT LIKE '%..%'
    AND file NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 8589934592),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64
    AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_key TEXT NOT NULL,
  is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
  PRIMARY KEY (channel, platform, arch, sequence, component_id),
  FOREIGN KEY (channel, platform, arch, sequence)
    REFERENCES component_catalog_versions (channel, platform, arch, sequence)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (
    (role = 'reason-runtime' AND kind = 'runtime' AND is_default = 0)
    OR (role = 'reason-model' AND kind = 'model' AND is_default = 0)
    OR (role = 'speech-model' AND kind = 'model')
  ),
  CHECK (
    artifact_key =
      'components/v1/' || kind || '/' || component_id || '/' || version || '/' || sha256 || '/' || file
  )
) STRICT;

CREATE UNIQUE INDEX component_catalog_single_reason_role
ON component_catalog_artifacts (channel, platform, arch, sequence, role)
WHERE role IN ('reason-runtime', 'reason-model');

CREATE UNIQUE INDEX component_catalog_single_default_speech
ON component_catalog_artifacts (channel, platform, arch, sequence)
WHERE role = 'speech-model' AND is_default = 1;

CREATE INDEX component_catalog_artifact_key
ON component_catalog_artifacts (artifact_key);

-- Inserted only by pointer triggers below. This distinguishes catalogs that actually became
-- authoritative from verified-but-abandoned rows left by an interrupted or losing publisher.
CREATE TABLE component_catalog_publications (
  channel TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  activated_at INTEGER NOT NULL CHECK (activated_at > 0),
  PRIMARY KEY (channel, platform, arch, sequence),
  FOREIGN KEY (channel, platform, arch, sequence)
    REFERENCES component_catalog_versions (channel, platform, arch, sequence)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) STRICT;

CREATE TABLE component_catalog_pointers (
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta', 'dev')),
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'macos')),
  arch TEXT NOT NULL CHECK (arch IN ('x86_64', 'aarch64')),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  PRIMARY KEY (channel, platform, arch),
  FOREIGN KEY (channel, platform, arch, sequence)
    REFERENCES component_catalog_versions (channel, platform, arch, sequence)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER component_catalog_versions_no_update
BEFORE UPDATE ON component_catalog_versions
BEGIN
  SELECT RAISE(ABORT, 'component catalog versions are immutable');
END;

CREATE TRIGGER component_catalog_versions_no_conflicting_insert
BEFORE INSERT ON component_catalog_versions
WHEN EXISTS (
  SELECT 1 FROM component_catalog_versions
  WHERE channel = NEW.channel
    AND platform = NEW.platform
    AND arch = NEW.arch
    AND sequence = NEW.sequence
    AND (
      catalog_key IS NOT NEW.catalog_key
      OR catalog_sha256 IS NOT NEW.catalog_sha256
      OR catalog_size_bytes IS NOT NEW.catalog_size_bytes
      OR issued_at IS NOT NEW.issued_at
      OR expires_at IS NOT NEW.expires_at
      OR published_at IS NOT NEW.published_at
    )
)
BEGIN
  SELECT RAISE(ABORT, 'component catalog versions are immutable');
END;

CREATE TRIGGER component_catalog_versions_no_delete
BEFORE DELETE ON component_catalog_versions
BEGIN
  SELECT RAISE(ABORT, 'component catalog versions are immutable');
END;

CREATE TRIGGER component_catalog_artifacts_no_update
BEFORE UPDATE ON component_catalog_artifacts
BEGIN
  SELECT RAISE(ABORT, 'component catalog artifacts are immutable');
END;

CREATE TRIGGER component_catalog_artifacts_no_conflicting_insert
BEFORE INSERT ON component_catalog_artifacts
WHEN EXISTS (
  SELECT 1 FROM component_catalog_artifacts
  WHERE channel = NEW.channel
    AND platform = NEW.platform
    AND arch = NEW.arch
    AND sequence = NEW.sequence
    AND component_id = NEW.component_id
    AND (
      role IS NOT NEW.role
      OR kind IS NOT NEW.kind
      OR version IS NOT NEW.version
      OR file IS NOT NEW.file
      OR size_bytes IS NOT NEW.size_bytes
      OR sha256 IS NOT NEW.sha256
      OR artifact_key IS NOT NEW.artifact_key
      OR is_default IS NOT NEW.is_default
    )
)
BEGIN
  SELECT RAISE(ABORT, 'component catalog artifacts are immutable');
END;

CREATE TRIGGER component_catalog_artifacts_no_insert_after_publish
BEFORE INSERT ON component_catalog_artifacts
WHEN EXISTS (
  SELECT 1 FROM component_catalog_publications
  WHERE channel = NEW.channel
    AND platform = NEW.platform
    AND arch = NEW.arch
    AND sequence = NEW.sequence
)
BEGIN
  SELECT RAISE(ABORT, 'published component catalog artifact sets are immutable');
END;

CREATE TRIGGER component_catalog_artifacts_no_delete
BEFORE DELETE ON component_catalog_artifacts
BEGIN
  SELECT RAISE(ABORT, 'component catalog artifacts are immutable');
END;

CREATE TRIGGER component_catalog_pointer_matches_version_insert
BEFORE INSERT ON component_catalog_pointers
WHEN NOT EXISTS (
  SELECT 1 FROM component_catalog_versions
  WHERE channel = NEW.channel
    AND platform = NEW.platform
    AND arch = NEW.arch
    AND sequence = NEW.sequence
)
BEGIN
  SELECT RAISE(ABORT, 'component catalog pointer must match an immutable version');
END;

CREATE TRIGGER component_catalog_pointer_complete_insert
BEFORE INSERT ON component_catalog_pointers
WHEN
  (SELECT COUNT(*) FROM component_catalog_artifacts
   WHERE channel = NEW.channel AND platform = NEW.platform AND arch = NEW.arch AND sequence = NEW.sequence
     AND role = 'reason-runtime') <> 1
  OR (SELECT COUNT(*) FROM component_catalog_artifacts
      WHERE channel = NEW.channel AND platform = NEW.platform AND arch = NEW.arch AND sequence = NEW.sequence
        AND role = 'reason-model') <> 1
  OR (SELECT COUNT(*) FROM component_catalog_artifacts
      WHERE channel = NEW.channel AND platform = NEW.platform AND arch = NEW.arch AND sequence = NEW.sequence
        AND role = 'speech-model') NOT BETWEEN 1 AND 5
  OR (SELECT COUNT(*) FROM component_catalog_artifacts
      WHERE channel = NEW.channel AND platform = NEW.platform AND arch = NEW.arch AND sequence = NEW.sequence
        AND role = 'speech-model' AND is_default = 1) <> 1
BEGIN
  SELECT RAISE(ABORT, 'component catalog pointer requires a complete role set');
END;

CREATE TRIGGER component_catalog_pointer_no_regression_insert
BEFORE INSERT ON component_catalog_pointers
WHEN EXISTS (
  SELECT 1 FROM component_catalog_pointers
  WHERE channel = NEW.channel
    AND platform = NEW.platform
    AND arch = NEW.arch
    AND sequence > NEW.sequence
)
BEGIN
  SELECT RAISE(ABORT, 'component catalog pointer cannot regress');
END;

CREATE TRIGGER component_catalog_pointer_record_publication_insert
AFTER INSERT ON component_catalog_pointers
BEGIN
  INSERT INTO component_catalog_publications (channel, platform, arch, sequence, activated_at)
  VALUES (NEW.channel, NEW.platform, NEW.arch, NEW.sequence, NEW.updated_at)
  ON CONFLICT(channel, platform, arch, sequence) DO NOTHING;
END;

CREATE TRIGGER component_catalog_pointer_matches_version_update
BEFORE UPDATE ON component_catalog_pointers
WHEN NOT EXISTS (
  SELECT 1 FROM component_catalog_versions
  WHERE channel = NEW.channel
    AND platform = NEW.platform
    AND arch = NEW.arch
    AND sequence = NEW.sequence
)
BEGIN
  SELECT RAISE(ABORT, 'component catalog pointer must match an immutable version');
END;

CREATE TRIGGER component_catalog_pointer_track_no_update
BEFORE UPDATE ON component_catalog_pointers
WHEN NEW.channel IS NOT OLD.channel
  OR NEW.platform IS NOT OLD.platform
  OR NEW.arch IS NOT OLD.arch
BEGIN
  SELECT RAISE(ABORT, 'component catalog pointer track is immutable');
END;

CREATE TRIGGER component_catalog_pointer_complete_update
BEFORE UPDATE ON component_catalog_pointers
WHEN
  (SELECT COUNT(*) FROM component_catalog_artifacts
   WHERE channel = NEW.channel AND platform = NEW.platform AND arch = NEW.arch AND sequence = NEW.sequence
     AND role = 'reason-runtime') <> 1
  OR (SELECT COUNT(*) FROM component_catalog_artifacts
      WHERE channel = NEW.channel AND platform = NEW.platform AND arch = NEW.arch AND sequence = NEW.sequence
        AND role = 'reason-model') <> 1
  OR (SELECT COUNT(*) FROM component_catalog_artifacts
      WHERE channel = NEW.channel AND platform = NEW.platform AND arch = NEW.arch AND sequence = NEW.sequence
        AND role = 'speech-model') NOT BETWEEN 1 AND 5
  OR (SELECT COUNT(*) FROM component_catalog_artifacts
      WHERE channel = NEW.channel AND platform = NEW.platform AND arch = NEW.arch AND sequence = NEW.sequence
        AND role = 'speech-model' AND is_default = 1) <> 1
BEGIN
  SELECT RAISE(ABORT, 'component catalog pointer requires a complete role set');
END;

CREATE TRIGGER component_catalog_pointer_no_regression_update
BEFORE UPDATE ON component_catalog_pointers
WHEN NEW.sequence < OLD.sequence
BEGIN
  SELECT RAISE(ABORT, 'component catalog pointer cannot regress');
END;

CREATE TRIGGER component_catalog_pointer_record_publication_update
AFTER UPDATE ON component_catalog_pointers
BEGIN
  INSERT INTO component_catalog_publications (channel, platform, arch, sequence, activated_at)
  VALUES (NEW.channel, NEW.platform, NEW.arch, NEW.sequence, NEW.updated_at)
  ON CONFLICT(channel, platform, arch, sequence) DO NOTHING;
END;

-- Only pointer activation may append publication history. During either pointer AFTER trigger the
-- exact new pointer row already exists, while an orphan or historical direct insert cannot pass.
CREATE TRIGGER component_catalog_publications_require_current_pointer
BEFORE INSERT ON component_catalog_publications
WHEN NOT EXISTS (
  SELECT 1 FROM component_catalog_pointers
  WHERE channel = NEW.channel
    AND platform = NEW.platform
    AND arch = NEW.arch
    AND sequence = NEW.sequence
)
BEGIN
  SELECT RAISE(ABORT, 'component catalog publication must be activated by its pointer');
END;

CREATE TRIGGER component_catalog_publications_no_conflicting_insert
BEFORE INSERT ON component_catalog_publications
WHEN EXISTS (
  SELECT 1 FROM component_catalog_publications
  WHERE channel = NEW.channel
    AND platform = NEW.platform
    AND arch = NEW.arch
    AND sequence = NEW.sequence
    AND activated_at IS NOT NEW.activated_at
)
BEGIN
  SELECT RAISE(ABORT, 'component catalog publication history is immutable');
END;

CREATE TRIGGER component_catalog_publications_no_update
BEFORE UPDATE ON component_catalog_publications
BEGIN
  SELECT RAISE(ABORT, 'component catalog publication history is immutable');
END;

CREATE TRIGGER component_catalog_publications_no_delete
BEFORE DELETE ON component_catalog_publications
BEGIN
  SELECT RAISE(ABORT, 'component catalog publication history is immutable');
END;

CREATE TRIGGER component_catalog_pointers_no_delete
BEFORE DELETE ON component_catalog_pointers
BEGIN
  SELECT RAISE(ABORT, 'component catalog pointer withdrawal requires an audited migration');
END;
