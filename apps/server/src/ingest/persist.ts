import type {
  CoverageReport,
  Event,
  EventCorrelation,
  Evidence,
  Finding,
  FindingStatusChange,
  PolicyVersion,
  Run,
  Safeguard,
  VerificationRun,
} from "@kw/schema";
import type { TableCodec } from "../db/codec";
import { transaction, type Db } from "../db/connection";
import * as t from "../db/tables";
import { recordRedactionOutcomes, redactionKey, sanitizeRunBundle, type SanitizeOptions } from "./sanitize";

/** Everything recorded for one run. A parsed FixtureRunFile satisfies this; a live adapter would produce it too. */
export interface RunBundle {
  run: Run;
  policy_version: PolicyVersion;
  events: Event[];
  evidence: Evidence[];
  correlations: EventCorrelation[];
  findings: Finding[];
  finding_status_history: FindingStatusChange[];
  safeguards: Safeguard[];
  verification_runs: VerificationRun[];
  coverage: CoverageReport;
}

export const BUNDLE_TABLES = [
  "policy_versions",
  "runs",
  "evidence",
  "events",
  "event_correlations",
  "findings",
  "finding_events",
  "finding_evidence",
  "finding_status_history",
  "safeguards",
  "verification_runs",
  "coverage_reports",
] as const;
export type BundleTable = (typeof BUNDLE_TABLES)[number];

export interface TableCounts {
  inserted: number;
  skipped: number;
}

/** A skipped record whose stored copy differs from the incoming one (same stable ID, different content). */
export interface IngestConflict {
  table: BundleTable;
  key: string;
  fields: string[];
}

export interface PersistResult {
  counts: Record<BundleTable, TableCounts>;
  conflicts: IngestConflict[];
}

export function emptyCounts(): Record<BundleTable, TableCounts> {
  return Object.fromEntries(BUNDLE_TABLES.map((name) => [name, { inserted: 0, skipped: 0 }])) as Record<BundleTable, TableCounts>;
}

/**
 * Idempotent: every row is keyed by a stable ID and written with INSERT OR IGNORE, so persisting the same bundle again
 * inserts nothing. Existing rows are never overwritten (a finding's status may since have been changed by a user).
 * All-or-nothing per bundle.
 */
export function persistRunBundle(db: Db, input: RunBundle, options: SanitizeOptions = {}): PersistResult {
  const counts = emptyCounts();
  const conflicts: IngestConflict[] = [];
  // Secret redaction BEFORE anything is written (fail closed; see ./sanitize). Rows inserted earlier by another path
  // are NOT rewritten (INSERT OR IGNORE): such paths must sanitize themselves (supervised start(), Tetragon ingest).
  const { bundle, records } = sanitizeRunBundle(input, options);
  const inserted = new Set<string>();

  const put = <T extends object>(codec: TableCodec<T>, name: BundleTable, value: T, ignore: readonly (keyof T)[] = []) => {
    if (codec.insertOrIgnore(db, value)) {
      counts[name].inserted++;
      const id = (value as { id?: unknown; run_id?: unknown }).id ?? (value as { run_id?: unknown }).run_id;
      if (typeof id === "string") inserted.add(redactionKey(name, id));
      return;
    }
    counts[name].skipped++;
    const existing = codec.findExisting(db, value);
    const fields = existing ? codec.diff(existing, value, ignore) : [];
    if (fields.length > 0) {
      const key = codec.primaryKey.map((k) => String(value[k])).join("/");
      conflicts.push({ table: name, key, fields });
    }
  };

  transaction(db, () => {
    put(t.policyVersions, "policy_versions", bundle.policy_version);
    put(t.runs, "runs", bundle.run);
    for (const e of bundle.evidence) put(t.evidence, "evidence", e);
    for (const e of bundle.events) put(t.events, "events", e);
    for (const c of bundle.correlations) put(t.correlations, "event_correlations", c);
    for (const { related_event_ids, evidence_ids, ...row } of bundle.findings) {
      put(t.findings, "findings", row, t.FINDING_MUTABLE_FIELDS);
      related_event_ids.forEach((event_id, position) => put(t.findingEvents, "finding_events", { finding_id: row.id, event_id, position }));
      evidence_ids.forEach((evidence_id, position) =>
        put(t.findingEvidence, "finding_evidence", { finding_id: row.id, evidence_id, position }),
      );
    }
    // Insertion order defines history order for equal timestamps.
    const history = [...bundle.finding_status_history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (const h of history) put(t.statusHistory, "finding_status_history", h);
    for (const s of bundle.safeguards) put(t.safeguards, "safeguards", s);
    for (const v of bundle.verification_runs) put(t.verificationRuns, "verification_runs", v);
    put(t.coverageReports, "coverage_reports", bundle.coverage);
    // Per-record redaction outcome, only for rows written now (a skipped row keeps the outcome of its first write).
    recordRedactionOutcomes(db, records, inserted);
  });

  return { counts, conflicts };
}
