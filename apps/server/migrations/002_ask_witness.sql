-- Ask Witness + Safeguard Generation (docs/PRD-addendum-ask-witness.md). Mirrors packages/schema/src/{workspaces,
-- askwitness,safeguards,verification}.ts. Additive only: v1 tables and columns are untouched, new columns are NULLable
-- (NULL = v1/fixture row; v2 state is then derived with lifecycleFromLegacy / verificationStateFromLegacy).
-- Arrays/objects are JSON text. AI output lives ONLY in investigation_turns / safeguard_versions, never in events/evidence.

-- Authorized local workspaces --------------------------------------------------------------------------------------
CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  -- realpath-resolved absolute directory; unique so the same directory cannot be authorized twice
  root_path     TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('demo', 'user')),
  authorized_at TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active', 'missing', 'revoked')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Immutable safeguard versions (edits append a new version) ---------------------------------------------------------
CREATE TABLE safeguard_versions (
  id                      TEXT PRIMARY KEY,
  safeguard_id            TEXT NOT NULL REFERENCES safeguards (id),
  version                 INTEGER NOT NULL CHECK (version >= 1),
  type                    TEXT NOT NULL,
  content                 TEXT NOT NULL,
  target                  TEXT NOT NULL,
  rationale               TEXT NOT NULL,
  intended_effect         TEXT NOT NULL,
  limitations             TEXT NOT NULL,
  verification_plan       TEXT NOT NULL,
  evidence_ids            TEXT NOT NULL,
  author                  TEXT NOT NULL CHECK (author IN ('ai', 'template', 'user')),
  source_investigation_id TEXT,
  model                   TEXT,
  prompt_version          TEXT,
  created_at              TEXT NOT NULL,
  UNIQUE (safeguard_id, version)
);
CREATE INDEX safeguard_versions_safeguard ON safeguard_versions (safeguard_id);

CREATE TRIGGER safeguard_versions_no_update BEFORE UPDATE ON safeguard_versions
BEGIN
  SELECT RAISE(ABORT, 'safeguard_versions is append-only');
END;
CREATE TRIGGER safeguard_versions_no_delete BEFORE DELETE ON safeguard_versions
BEGIN
  SELECT RAISE(ABORT, 'safeguard_versions is append-only');
END;

-- Append-only safeguard history ----------------------------------------------------------------------------------
CREATE TABLE safeguard_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  safeguard_id TEXT NOT NULL REFERENCES safeguards (id),
  version_id   TEXT REFERENCES safeguard_versions (id),
  action       TEXT NOT NULL CHECK (action IN ('proposed', 'edited', 'rejected', 'approved', 'applied', 'application_failed', 'conflict_detected', 'rolled_back')),
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'ai')),
  actor        TEXT NOT NULL,
  note         TEXT,
  details      TEXT,
  at           TEXT NOT NULL
);
CREATE INDEX safeguard_events_safeguard ON safeguard_events (safeguard_id);

CREATE TRIGGER safeguard_events_no_update BEFORE UPDATE ON safeguard_events
BEGIN
  SELECT RAISE(ABORT, 'safeguard_events is append-only');
END;
CREATE TRIGGER safeguard_events_no_delete BEFORE DELETE ON safeguard_events
BEGIN
  SELECT RAISE(ABORT, 'safeguard_events is append-only');
END;

-- v2 state on the existing safeguards row (NULL for v1/fixture rows) ----------------------------------------------
ALTER TABLE safeguards ADD COLUMN lifecycle_status TEXT
  CHECK (lifecycle_status IS NULL OR lifecycle_status IN ('proposed', 'rejected', 'approved', 'applied', 'application_failed', 'rolled_back'));
ALTER TABLE safeguards ADD COLUMN verification_state TEXT
  CHECK (verification_state IS NULL OR verification_state IN ('not_tested', 'running', 'passed', 'failed', 'inconclusive'));
ALTER TABLE safeguards ADD COLUMN current_version_id TEXT REFERENCES safeguard_versions (id);
ALTER TABLE safeguards ADD COLUMN workspace_id TEXT REFERENCES workspaces (id);
ALTER TABLE safeguards ADD COLUMN source_investigation_id TEXT;
-- Groups the safeguards created by one proposal request (one per mechanism).
ALTER TABLE safeguards ADD COLUMN proposal_request_id TEXT;
CREATE INDEX safeguards_proposal_request ON safeguards (proposal_request_id);

-- Applied file writes (content in the BlobStore, data/evidence/blobs) ---------------------------------------------
CREATE TABLE workspace_file_changes (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces (id),
  safeguard_id   TEXT NOT NULL REFERENCES safeguards (id),
  version_id     TEXT NOT NULL REFERENCES safeguard_versions (id),
  rel_path       TEXT NOT NULL,
  before_sha256  TEXT,
  after_sha256   TEXT NOT NULL,
  before_blob    TEXT,
  after_blob     TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back')),
  applied_at     TEXT NOT NULL,
  rolled_back_at TEXT
);
CREATE INDEX workspace_file_changes_safeguard ON workspace_file_changes (safeguard_id);
CREATE INDEX workspace_file_changes_workspace_path ON workspace_file_changes (workspace_id, rel_path);

-- Ask Witness ----------------------------------------------------------------------------------------------------
CREATE TABLE investigations (
  id         TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES findings (id),
  run_id     TEXT NOT NULL REFERENCES runs (id),
  status     TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX investigations_finding ON investigations (finding_id);

CREATE TABLE investigation_turns (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  id                  TEXT NOT NULL UNIQUE,
  investigation_id    TEXT NOT NULL REFERENCES investigations (id),
  -- Globally unique: the first question of a new investigation has no investigation_id yet.
  client_request_id   TEXT NOT NULL UNIQUE,
  -- sha256(finding_id US investigation_id-or-empty US question): same key + different request => 409 conflict.
  request_fingerprint TEXT NOT NULL,
  question            TEXT NOT NULL,
  evidence_ids        TEXT NOT NULL,
  bundle_hash         TEXT,
  model               TEXT NOT NULL,
  prompt_version      TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('answered', 'insufficient_evidence', 'ai_unavailable', 'ai_error', 'invalid_output')),
  answer              TEXT,
  error               TEXT,
  -- InferenceMeta minus anything secret (served_model, attempts, usage, latency, cache_hit...). Not part of the API shape.
  ai_meta             TEXT,
  -- BundleEvidenceRef[] for the evidence_index (redacted one-liners only).
  evidence_index      TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL,
  UNIQUE (investigation_id, client_request_id)
);
CREATE INDEX investigation_turns_investigation ON investigation_turns (investigation_id);

CREATE TRIGGER investigation_turns_no_delete BEFORE DELETE ON investigation_turns
BEGIN
  SELECT RAISE(ABORT, 'investigation_turns are never deleted');
END;

-- Verification v2 columns on the existing verification_runs table ----------------------------------------------------
ALTER TABLE verification_runs ADD COLUMN version_id TEXT REFERENCES safeguard_versions (id);
ALTER TABLE verification_runs ADD COLUMN verification_status TEXT
  CHECK (verification_status IS NULL OR verification_status IN ('not_tested', 'running', 'passed', 'failed', 'inconclusive'));
ALTER TABLE verification_runs ADD COLUMN cases TEXT NOT NULL DEFAULT '[]';
ALTER TABLE verification_runs ADD COLUMN environment TEXT;
ALTER TABLE verification_runs ADD COLUMN artifacts TEXT NOT NULL DEFAULT '[]';
ALTER TABLE verification_runs ADD COLUMN limitations TEXT NOT NULL DEFAULT '[]';
ALTER TABLE verification_runs ADD COLUMN client_request_id TEXT;
CREATE UNIQUE INDEX verification_runs_client_request ON verification_runs (client_request_id) WHERE client_request_id IS NOT NULL;

-- Generic idempotency keys (safeguard proposals: scope 'safeguard_proposal'; others as needed) -----------------------
CREATE TABLE idempotency_keys (
  scope               TEXT NOT NULL,
  client_request_id   TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  -- JSON: what the request produced, e.g. {"safeguard_ids": [...]} - replays re-read these records.
  result_ref          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (scope, client_request_id)
);
