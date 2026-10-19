-- Ask Witness scopes: an investigation is about ONE finding (v1), ONE agent run, or the whole Kernel Witness workspace
-- (all of KW's own records). Rebuilds `investigations` so finding_id/run_id can be NULL for the new scopes; existing rows
-- become scope_kind 'finding' unchanged. investigation_turns is untouched (it references investigations by name).
-- Rows are re-inserted AFTER the rename so the deferred foreign-key counter for investigation_turns returns to zero.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE investigations_scoped (
  id         TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL DEFAULT 'finding' CHECK (scope_kind IN ('finding', 'run', 'workspace')),
  -- finding id (finding scope), run id (run scope), NULL (workspace scope)
  scope_id   TEXT,
  finding_id TEXT REFERENCES findings (id),
  run_id     TEXT REFERENCES runs (id),
  status     TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (scope_kind = 'finding' AND finding_id IS NOT NULL AND run_id IS NOT NULL AND scope_id = finding_id)
    OR (scope_kind = 'run' AND finding_id IS NULL AND run_id IS NOT NULL AND scope_id = run_id)
    OR (scope_kind = 'workspace' AND finding_id IS NULL AND run_id IS NULL AND scope_id IS NULL)
  )
);

CREATE TEMP TABLE investigations_copy AS SELECT id, finding_id, run_id, status, created_at, updated_at FROM investigations;
DROP TABLE investigations;
ALTER TABLE investigations_scoped RENAME TO investigations;
INSERT INTO investigations (id, scope_kind, scope_id, finding_id, run_id, status, created_at, updated_at)
  SELECT id, 'finding', finding_id, finding_id, run_id, status, created_at, updated_at FROM investigations_copy;
DROP TABLE investigations_copy;

CREATE INDEX investigations_finding ON investigations (finding_id);
CREATE INDEX investigations_scope ON investigations (scope_kind, scope_id);
