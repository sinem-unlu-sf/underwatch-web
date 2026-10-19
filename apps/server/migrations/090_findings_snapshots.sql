-- Findings presentation modes (docs/PRD-addendum-findings-modes.md, docs/FINDINGS-MODES.md). Mirrors
-- packages/schema/src/findings-views.ts. Presentation-only: nothing here is read by ingestion, finding generation, or
-- enforcement. A snapshot stores finding REFERENCES (ids + status/severity at snapshot time + grouping + summary),
-- never new findings; the findings/events/evidence tables stay the single source of truth.
-- Append-only: a refresh appends version N+1; old versions stay readable. No scheduler writes here - a digest version
-- is created lazily when a day is first opened, or when the user explicitly refreshes it.

CREATE TABLE finding_snapshots (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('digest', 'current')),
  -- digest: "YYYY-MM-DD@<IANA tz>", e.g. "2026-10-17@Asia/Tokyo"; current: "current"
  scope_key    TEXT NOT NULL,
  version      INTEGER NOT NULL CHECK (version >= 1),
  created_at   TEXT NOT NULL,
  -- sha256 hex of the canonical JSON of content_json (generation timestamps excluded), used for newer_available
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  -- 1 when any referenced finding/run is fixture data, so a snapshot can never pass synthetic data off as live
  contains_fixture_data INTEGER NOT NULL CHECK (contains_fixture_data IN (0, 1)),
  UNIQUE (kind, scope_key, version)
);
CREATE INDEX finding_snapshots_scope ON finding_snapshots (kind, scope_key, version DESC);

CREATE TRIGGER finding_snapshots_no_update BEFORE UPDATE ON finding_snapshots
BEGIN
  SELECT RAISE(ABORT, 'finding_snapshots is append-only');
END;

CREATE TRIGGER finding_snapshots_no_delete BEFORE DELETE ON finding_snapshots
BEGIN
  SELECT RAISE(ABORT, 'finding_snapshots is append-only');
END;
