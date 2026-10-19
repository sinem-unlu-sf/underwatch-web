-- Live supervised runs (POST /api/runs; apps/server/src/supervised/). One row per live Run started through the API.
-- The Run itself (and its events/evidence/findings) lives in the normal tables; this row holds the harness state,
-- the host-captured artifact references (BlobStore sha256) and the capture/ingest summaries. No secret values.
CREATE TABLE supervised_runs (
  run_id                    TEXT PRIMARY KEY REFERENCES runs (id),
  client_request_id         TEXT NOT NULL UNIQUE,
  workspace_id              TEXT,
  task                      TEXT NOT NULL,
  model                     TEXT NOT NULL,
  status                    TEXT NOT NULL CHECK (status IN ('running', 'complete', 'partial', 'failed')),
  stage                     TEXT NOT NULL,
  error                     TEXT,
  policy_sha256             TEXT,
  workspace_snapshot_sha256 TEXT,
  artifacts                 TEXT NOT NULL DEFAULT '[]',
  capture                   TEXT,
  ingest                    TEXT,
  limitations               TEXT NOT NULL DEFAULT '[]',
  started_at                TEXT NOT NULL,
  ended_at                  TEXT
);
CREATE INDEX supervised_runs_status ON supervised_runs (status, started_at DESC);
