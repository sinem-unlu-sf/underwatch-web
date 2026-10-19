-- Storage-boundary secret redaction (ISSUE 3; apps/server/src/ingest/sanitize.ts). One row per record written by
-- persistRunBundle: whether its free-text fields were clean, redacted, or replaced by "[REDACTION_FAILED]" because
-- redaction itself failed (fail closed). Holds detector ids and field names only, never values.
-- (Evidence rows additionally carry evidence.redaction_status.)
CREATE TABLE record_redactions (
  table_name      TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('clean', 'redacted', 'failed')),
  detectors       TEXT NOT NULL DEFAULT '[]',
  fields          TEXT NOT NULL DEFAULT '[]',
  ruleset_version TEXT NOT NULL,
  scanned_at      TEXT NOT NULL,
  PRIMARY KEY (table_name, record_id)
);
CREATE INDEX record_redactions_status ON record_redactions (status) WHERE status != 'clean';
