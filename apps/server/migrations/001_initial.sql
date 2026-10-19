-- Kernel Witness foundation schema. Mirrors the entities in @kw/schema (packages/schema/src/entities.ts).
-- Array/object fields are stored as JSON text; booleans as 0/1. Every row carries is_fixture.

CREATE TABLE policy_versions (
  id               TEXT PRIMARY KEY,
  is_fixture       INTEGER NOT NULL CHECK (is_fixture IN (0, 1)),
  policy_id        TEXT NOT NULL,
  version          TEXT NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  source_reference TEXT,
  content_sha256   TEXT,
  rules            TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE runs (
  id                  TEXT PRIMARY KEY,
  is_fixture          INTEGER NOT NULL CHECK (is_fixture IN (0, 1)),
  label               TEXT,
  agent_type          TEXT NOT NULL,
  adapter             TEXT,
  task_description    TEXT NOT NULL,
  repository_id       TEXT,
  repository_revision TEXT,
  policy_version      TEXT REFERENCES policy_versions (id),
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  status              TEXT NOT NULL,
  coverage_status     TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX runs_started_at ON runs (julianday(started_at));
CREATE INDEX runs_is_fixture ON runs (is_fixture);

CREATE TABLE evidence (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES runs (id),
  is_fixture         INTEGER NOT NULL CHECK (is_fixture IN (0, 1)),
  source_type        TEXT NOT NULL,
  source_reference   TEXT NOT NULL,
  timestamp          TEXT NOT NULL,
  integrity_metadata TEXT NOT NULL,
  redaction_status   TEXT NOT NULL,
  excerpt            TEXT
);
CREATE INDEX evidence_run ON evidence (run_id);

CREATE TABLE events (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL REFERENCES runs (id),
  is_fixture             INTEGER NOT NULL CHECK (is_fixture IN (0, 1)),
  basis                  TEXT NOT NULL,
  source                 TEXT NOT NULL,
  source_native_key      TEXT NOT NULL,
  source_sequence        INTEGER,
  event_type             TEXT NOT NULL,
  timestamp              TEXT NOT NULL,
  process_id             INTEGER,
  parent_process_id      INTEGER,
  process_name           TEXT,
  tool_name              TEXT,
  tool_use_id            TEXT,
  target_resource        TEXT,
  outcome                TEXT NOT NULL,
  evidence_id            TEXT REFERENCES evidence (id),
  attribution_confidence TEXT,
  collection_status      TEXT NOT NULL,
  unavailable_fields     TEXT NOT NULL,
  limitations            TEXT NOT NULL,
  summary                TEXT NOT NULL,
  raw_summary            TEXT,
  UNIQUE (run_id, basis, source, source_native_key)
);
CREATE INDEX events_run_time ON events (run_id, julianday(timestamp));
CREATE INDEX events_evidence ON events (evidence_id);

CREATE TABLE event_correlations (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs (id),
  is_fixture        INTEGER NOT NULL CHECK (is_fixture IN (0, 1)),
  reported_event_id TEXT REFERENCES events (id),
  observed_event_id TEXT REFERENCES events (id),
  match             TEXT NOT NULL,
  confidence        TEXT NOT NULL,
  note              TEXT
);
CREATE INDEX event_correlations_run ON event_correlations (run_id);

CREATE TABLE findings (
  id                       TEXT PRIMARY KEY,
  run_id                   TEXT NOT NULL REFERENCES runs (id),
  is_fixture               INTEGER NOT NULL CHECK (is_fixture IN (0, 1)),
  category                 TEXT NOT NULL,
  title                    TEXT NOT NULL,
  description              TEXT NOT NULL,
  severity                 TEXT NOT NULL,
  severity_rank            INTEGER GENERATED ALWAYS AS (
    CASE severity WHEN 'info' THEN 0 WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 WHEN 'critical' THEN 4 END
  ) VIRTUAL,
  confidence               TEXT NOT NULL,
  status                   TEXT NOT NULL,
  policy_id                TEXT REFERENCES policy_versions (id),
  policy_rule_id           TEXT,
  recommended_next_step    TEXT NOT NULL,
  missing_information      TEXT NOT NULL,
  -- May point at a finding from another run/fixture that is not loaded, so no foreign key.
  recurrence_of_finding_id TEXT,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
CREATE INDEX findings_run ON findings (run_id);
CREATE INDEX findings_status ON findings (status);

CREATE TABLE finding_events (
  finding_id TEXT NOT NULL REFERENCES findings (id),
  event_id   TEXT NOT NULL REFERENCES events (id),
  position   INTEGER NOT NULL,
  PRIMARY KEY (finding_id, event_id)
);
CREATE INDEX finding_events_event ON finding_events (event_id);

CREATE TABLE finding_evidence (
  finding_id  TEXT NOT NULL REFERENCES findings (id),
  evidence_id TEXT NOT NULL REFERENCES evidence (id),
  position    INTEGER NOT NULL,
  PRIMARY KEY (finding_id, evidence_id)
);
CREATE INDEX finding_evidence_evidence ON finding_evidence (evidence_id);

-- Append-only. The application never updates or deletes rows; the triggers below enforce that at the DB level.
CREATE TABLE finding_status_history (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  finding_id  TEXT NOT NULL REFERENCES findings (id),
  is_fixture  INTEGER NOT NULL CHECK (is_fixture IN (0, 1)),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor       TEXT NOT NULL,
  note        TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX finding_status_history_finding ON finding_status_history (finding_id);

CREATE TRIGGER finding_status_history_no_update BEFORE UPDATE ON finding_status_history
BEGIN
  SELECT RAISE(ABORT, 'finding_status_history is append-only');
END;

CREATE TRIGGER finding_status_history_no_delete BEFORE DELETE ON finding_status_history
BEGIN
  SELECT RAISE(ABORT, 'finding_status_history is append-only');
END;

CREATE TABLE verification_runs (
  id                           TEXT PRIMARY KEY,
  safeguard_id                 TEXT NOT NULL REFERENCES safeguards (id),
  finding_id                   TEXT NOT NULL REFERENCES findings (id),
  is_fixture                   INTEGER NOT NULL CHECK (is_fixture IN (0, 1)),
  scenario_id                  TEXT NOT NULL,
  scenario_description         TEXT NOT NULL,
  environment_id               TEXT NOT NULL,
  -- The verification's own supervised run may be stored separately (or not at all), so no foreign key.
  run_id                       TEXT,
  status                       TEXT NOT NULL,
  result                       TEXT,
  prohibited_behavior_attempted INTEGER,
  prohibited_behavior_blocked  INTEGER,
  legitimate_behavior_worked   INTEGER,
  observed_event_ids           TEXT NOT NULL,
  evidence_ids                 TEXT NOT NULL,
  notes                        TEXT,
  started_at                   TEXT NOT NULL,
  ended_at                     TEXT
);
CREATE INDEX verification_runs_safeguard ON verification_runs (safeguard_id);

CREATE TABLE safeguards (
  id                         TEXT PRIMARY KEY,
  finding_id                 TEXT NOT NULL REFERENCES findings (id),
  is_fixture                 INTEGER NOT NULL CHECK (is_fixture IN (0, 1)),
  type                       TEXT NOT NULL,
  title                      TEXT NOT NULL,
  content                    TEXT NOT NULL,
  application_mechanism      TEXT NOT NULL,
  target_path                TEXT,
  intended_effect            TEXT NOT NULL,
  legitimate_workflow_impact TEXT NOT NULL,
  approval_status            TEXT NOT NULL,
  application_status         TEXT NOT NULL,
  verification_status        TEXT NOT NULL,
  created_at                 TEXT NOT NULL,
  approved_at                TEXT,
  approved_by                TEXT,
  applied_at                 TEXT,
  last_verification_run_id   TEXT REFERENCES verification_runs (id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX safeguards_finding ON safeguards (finding_id);

CREATE TABLE coverage_reports (
  run_id                      TEXT PRIMARY KEY REFERENCES runs (id),
  is_fixture                  INTEGER NOT NULL CHECK (is_fixture IN (0, 1)),
  level                       TEXT NOT NULL,
  sources                     TEXT NOT NULL,
  categories                  TEXT NOT NULL,
  unsupported_capabilities    TEXT NOT NULL,
  network_outcomes_observable INTEGER NOT NULL,
  final_state_complete        INTEGER NOT NULL,
  generated_at                TEXT NOT NULL
);
