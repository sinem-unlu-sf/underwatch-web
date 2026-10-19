/**
 * Storage-boundary secret redaction (defense in depth, ISSUE 3).
 *
 * Every RunBundle passes through sanitizeRunBundle() inside persistRunBundle() before any row is written, whatever
 * produced it (fixture importer, Claude Code adapter, Tetragon observer, analysis findings, future live ingestion). The
 * adapter and observer already redact at parse time; this pass also covers sources that bypass them (observed argv
 * embedded in finding text, hand-written bundles) and operator-configured patterns / known secrets.
 *
 * Guarantees:
 *  - Only free-text fields change. IDs, timestamps, source, basis, enums and hashes are never touched.
 *  - Fail closed: if redaction throws for a field, the stored value is "[REDACTION_FAILED]", never the original, the
 *    record is marked status "failed" (evidence: redaction_status "withheld") and the failure is logged WITHOUT text.
 *  - Idempotent over earlier placeholders (keepCleanTextVerbatim): re-sanitizing already-redacted text is a no-op.
 *
 * Not covered (by design): policy rule patterns and coverage reports (KW-authored configuration/metadata). Raw records
 * stay in the access-restricted capture files / blob store, which is never served by the API or sent to AI.
 */
import { readFileSync } from "node:fs";
import {
  REDACTION_RULESET_VERSION,
  redactionOptionsFromEnv,
  safeRedact,
  type DetectorId,
  type RedactOptions,
  type SafeRedactStatus,
} from "@kw/redaction";
import type { Event, Evidence, RedactionStatus, Run } from "@kw/schema";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import type { BundleTable, RunBundle } from "./persist";

export interface RecordRedaction {
  table: BundleTable;
  id: string;
  status: SafeRedactStatus;
  /** Detectors that fired (never values). */
  detectors: DetectorId[];
  /** Fields that were changed (redacted or replaced by the failure placeholder). */
  fields: string[];
}

export interface RedactionFailureLog {
  table: BundleTable;
  id: string;
  field: string;
  error: string;
}

export interface SanitizeOptions {
  redaction?: RedactOptions;
  /** Receives failures; never given the original text. Defaults to a one-line console.error. */
  onFailure?: (info: RedactionFailureLog) => void;
}

export interface SanitizeResult {
  bundle: RunBundle;
  records: RecordRedaction[];
  ruleset_version: string;
}

let cachedEnvOptions: RedactOptions | null = null;

/** Redaction options for this process: known secrets from env + $KW_REDACTION_PATTERNS_FILE. Throws on a bad file. */
export function processRedactionOptions(env: NodeJS.ProcessEnv = process.env): RedactOptions {
  if (env !== process.env) return redactionOptionsFromEnv(env, (p) => readFileSync(p, "utf8"));
  cachedEnvOptions ??= redactionOptionsFromEnv(env, (p) => readFileSync(p, "utf8"));
  return cachedEnvOptions;
}

function defaultFailureLog(info: RedactionFailureLog): void {
  console.error(`[kw] redaction failed table=${info.table} id=${info.id} field=${info.field} error=${info.error}; stored [REDACTION_FAILED]`);
}

class RecordScanner {
  status: SafeRedactStatus = "clean";
  readonly detectors = new Set<DetectorId>();
  readonly fields: string[] = [];

  constructor(
    private readonly table: BundleTable,
    private readonly id: string,
    private readonly opts: RedactOptions,
    private readonly onFailure: (info: RedactionFailureLog) => void,
  ) {}

  text<T extends string | null>(field: string, value: T): T {
    if (value === null || value === undefined) return value;
    let failed = false;
    const r = safeRedact(value, {
      ...this.opts,
      keepCleanTextVerbatim: true,
      onFailure: ({ error }) => {
        failed = true;
        this.onFailure({ table: this.table, id: this.id, field, error });
      },
    });
    if (r.status === "clean") return value;
    for (const d of r.detectors) this.detectors.add(d);
    this.fields.push(field);
    if (failed || r.status === "failed") this.status = "failed";
    else if (this.status === "clean") this.status = "redacted";
    return r.text as T;
  }

  list(field: string, values: string[]): string[] {
    return values.map((v, i) => this.text(`${field}[${i}]`, v));
  }

  result(): RecordRedaction {
    return { table: this.table, id: this.id, status: this.status, detectors: [...this.detectors].sort(), fields: this.fields };
  }
}

const EVIDENCE_RANK: Record<RedactionStatus, number> = { not_scanned: 0, no_secrets_detected: 1, redacted: 2, withheld: 3 };

/** Never downgrades an upstream status (e.g. the adapter said "withheld"). */
function evidenceStatus(upstream: RedactionStatus, scan: SafeRedactStatus, hadExcerpt: boolean): RedactionStatus {
  const computed: RedactionStatus = scan === "failed" ? "withheld" : scan === "redacted" ? "redacted" : hadExcerpt ? "no_secrets_detected" : "not_scanned";
  return EVIDENCE_RANK[computed] > EVIDENCE_RANK[upstream] ? computed : upstream;
}

type Scan = <R>(table: BundleTable, id: string, fn: (s: RecordScanner) => R) => R;

function scanner(options: SanitizeOptions, records: RecordRedaction[]): Scan {
  const opts = options.redaction ?? processRedactionOptions();
  const onFailure = options.onFailure ?? defaultFailureLog;
  return (table, id, fn) => {
    const s = new RecordScanner(table, id, opts, onFailure);
    const out = fn(s);
    records.push(s.result());
    return out;
  };
}

const runOf = (scan: Scan, r: Run): Run => scan("runs", r.id, (s) => ({ ...r, label: s.text("label", r.label), task_description: s.text("task_description", r.task_description) }));

const evidenceOf = (scan: Scan, e: Evidence): Evidence =>
  scan("evidence", e.id, (s) => {
    const out = { ...e, source_reference: s.text("source_reference", e.source_reference), excerpt: s.text("excerpt", e.excerpt) };
    return { ...out, redaction_status: evidenceStatus(e.redaction_status, s.status, e.excerpt !== null) };
  });

const eventOf = (scan: Scan, e: Event): Event =>
  scan("events", e.id, (s) => ({
    ...e,
    process_name: s.text("process_name", e.process_name),
    target_resource: s.text("target_resource", e.target_resource),
    summary: s.text("summary", e.summary),
    raw_summary: s.text("raw_summary", e.raw_summary),
    limitations: s.list("limitations", e.limitations),
  }));

/**
 * Same redaction for ingestion paths that write rows directly instead of through persistRunBundle (e.g. the Tetragon
 * observer). Record the outcomes with recordRedactionOutcomes() inside the same transaction.
 */
export function sanitizeRecords(parts: { run?: Run; evidence?: Evidence[]; events?: Event[] }, options: SanitizeOptions = {}) {
  const records: RecordRedaction[] = [];
  const scan = scanner(options, records);
  return {
    run: parts.run ? runOf(scan, parts.run) : undefined,
    evidence: (parts.evidence ?? []).map((e) => evidenceOf(scan, e)),
    events: (parts.events ?? []).map((e) => eventOf(scan, e)),
    records,
  };
}

/** Writes record_redactions rows for records whose row was inserted now (`inserted` holds "table\u001fid" keys). */
export function recordRedactionOutcomes(db: Db, records: readonly RecordRedaction[], inserted: ReadonlySet<string>, scannedAt = new Date().toISOString()): void {
  for (const r of records) {
    if (!inserted.has(redactionKey(r.table, r.id))) continue;
    stmt(
      db,
      `INSERT OR IGNORE INTO record_redactions (table_name, record_id, status, detectors, fields, ruleset_version, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.table, r.id, r.status, JSON.stringify(r.detectors), JSON.stringify(r.fields), REDACTION_RULESET_VERSION, scannedAt);
  }
}

export const redactionKey = (table: BundleTable, id: string) => `${table}\u001f${id}`;

/** Returns a redacted copy of the bundle plus a per-record redaction outcome. Pure apart from the failure log. */
export function sanitizeRunBundle(bundle: RunBundle, options: SanitizeOptions = {}): SanitizeResult {
  const records: RecordRedaction[] = [];
  const scan = scanner(options, records);

  const run = runOf(scan, bundle.run);
  const pv = bundle.policy_version;
  const policy_version = scan("policy_versions", pv.id, (s) => ({ ...pv, name: s.text("name", pv.name), description: s.text("description", pv.description) }));
  const evidence = bundle.evidence.map((e) => evidenceOf(scan, e));
  const events = bundle.events.map((e) => eventOf(scan, e));

  const correlations = bundle.correlations.map((c) => scan("event_correlations", c.id, (s) => ({ ...c, note: s.text("note", c.note) })));

  const findings = bundle.findings.map((f) =>
    scan("findings", f.id, (s) => ({
      ...f,
      title: s.text("title", f.title),
      description: s.text("description", f.description),
      recommended_next_step: s.text("recommended_next_step", f.recommended_next_step),
      missing_information: s.list("missing_information", f.missing_information),
    })),
  );

  const finding_status_history = bundle.finding_status_history.map((h) => scan("finding_status_history", h.id, (s) => ({ ...h, note: s.text("note", h.note) })));

  const safeguards = bundle.safeguards.map((g) =>
    scan("safeguards", g.id, (s) => ({
      ...g,
      title: s.text("title", g.title),
      content: s.text("content", g.content),
      intended_effect: s.text("intended_effect", g.intended_effect),
      legitimate_workflow_impact: s.text("legitimate_workflow_impact", g.legitimate_workflow_impact),
    })),
  );

  const verification_runs = bundle.verification_runs.map((v) =>
    scan("verification_runs", v.id, (s) => ({ ...v, scenario_description: s.text("scenario_description", v.scenario_description), notes: s.text("notes", v.notes) })),
  );

  return {
    bundle: { ...bundle, run, policy_version, evidence, events, correlations, findings, finding_status_history, safeguards, verification_runs },
    records,
    ruleset_version: REDACTION_RULESET_VERSION,
  };
}
