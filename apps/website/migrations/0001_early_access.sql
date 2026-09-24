-- Early-access list for kalcoded.com (docs/DATA_MODEL.md §3).
-- Stores only what the form collects: the email address, when it was added, the page it was
-- submitted from, and the version of the consent text shown. No IP addresses or user agents.
CREATE TABLE IF NOT EXISTS early_access (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL,
  source TEXT,
  consent_version TEXT NOT NULL
);
