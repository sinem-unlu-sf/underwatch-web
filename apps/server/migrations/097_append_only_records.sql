-- Auditor 3 (ARCHITECTURE open gates): observed records are append-only, and a finding is CONFIRMED only by a person.
--
-- events / evidence: ingestion writes them with INSERT OR IGNORE keyed on stable ids (run_id, basis, source,
-- source_native_key), so a re-ingest is a no-op and never needs UPDATE/DELETE. These triggers make any later change
-- or removal fail loudly. (INSERT OR IGNORE does not fire UPDATE/DELETE triggers, so idempotent re-ingest still works.)
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events is append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events is append-only');
END;

CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence
BEGIN
  SELECT RAISE(ABORT, 'evidence is append-only');
END;

CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence
BEGIN
  SELECT RAISE(ABORT, 'evidence is append-only');
END;

-- A status change to "confirmed" must be made by a user actor (never "system", never AI).
CREATE TRIGGER finding_confirm_requires_user BEFORE INSERT ON finding_status_history
WHEN NEW.to_status = 'confirmed' AND NEW.actor_type != 'user'
BEGIN
  SELECT RAISE(ABORT, 'only a user actor can confirm a finding');
END;

-- A live (non-fixture) finding can only move to "confirmed" after a user-actor history row recorded that change.
CREATE TRIGGER findings_confirm_requires_user_history BEFORE UPDATE OF status ON findings
WHEN NEW.status = 'confirmed' AND OLD.status != 'confirmed' AND NEW.is_fixture = 0
  AND NOT EXISTS (
    SELECT 1 FROM finding_status_history h
    WHERE h.finding_id = NEW.id AND h.to_status = 'confirmed' AND h.actor_type = 'user'
      AND h.seq = (SELECT MAX(seq) FROM finding_status_history WHERE finding_id = NEW.id)
  )
BEGIN
  SELECT RAISE(ABORT, 'finding status confirmed requires a user-actor status change');
END;

-- Not enforced at INSERT: persistRunBundle inserts a finding row before its status history (FK order), and recorded
-- bundles legitimately carry a user-confirmed history. Insert-time confirmation is guarded by the history trigger above.
