import {
  OPEN_FINDING_STATUSES,
  SEVERITY_ORDER,
  taskContextKey,
  type Completeness,
  type CoverageCaveat,
  type FindingListItem,
  type FindingStatus,
  type Outcome,
  type RunStatus,
  type Severity,
  type SnapshotFinding,
} from "@kw/schema";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import { getCoverage, getEventsByIds } from "../repo/runs";

/**
 * Presentation-only projections of persisted findings. Everything here READS findings/events/coverage rows; nothing
 * writes them, generates findings, or influences collection or enforcement.
 */

const OPEN = new Set<FindingStatus>(OPEN_FINDING_STATUSES);
export const isOpenStatus = (s: FindingStatus): boolean => OPEN.has(s);

export function maxSeverity(values: readonly (Severity | null)[]): Severity | null {
  let best: Severity | null = null;
  for (const s of values) if (s !== null && (best === null || SEVERITY_ORDER[s] > SEVERITY_ORDER[best])) best = s;
  return best;
}

/** run id -> task context key, for the given runs (one query). */
export function taskKeysForRuns(db: Db, runIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (runIds.length === 0) return out;
  for (const r of stmt(db, "SELECT id, repository_id, task_description FROM runs WHERE id IN (SELECT value FROM json_each(?))").all(
    JSON.stringify([...new Set(runIds)]),
  )) {
    out.set(r.id as string, taskContextKey((r.repository_id as string | null) ?? null, r.task_description as string));
  }
  return out;
}

const sortedUnique = (values: Iterable<Outcome>): Outcome[] => [...new Set(values)].sort();

/**
 * Converts list items into SnapshotFindings: task key from the run, outcomes split by event basis (reported vs
 * observed; derived events are not counted as either). One events query for all findings.
 */
export function toSnapshotFindings(db: Db, items: readonly FindingListItem[]): SnapshotFinding[] {
  const taskKeys = taskKeysForRuns(
    db,
    items.map((f) => f.run_id),
  );
  const events = new Map(getEventsByIds(db, [...new Set(items.flatMap((f) => f.related_event_ids))]).map((e) => [e.id, e]));
  return items.map((f) => {
    const linked = f.related_event_ids.flatMap((id) => events.get(id) ?? []);
    return {
      id: f.id,
      run_id: f.run_id,
      run_label: f.run_label,
      task_key: taskKeys.get(f.run_id)!,
      is_fixture: f.is_fixture,
      category: f.category,
      title: f.title,
      severity: f.severity,
      confidence: f.confidence,
      status: f.status,
      created_at: f.created_at,
      updated_at: f.updated_at,
      missing_information: f.missing_information,
      evidence_ids: f.evidence_ids,
      related_event_ids: f.related_event_ids,
      reported_outcomes: sortedUnique(linked.filter((e) => e.basis === "reported").map((e) => e.outcome)),
      observed_outcomes: sortedUnique(linked.filter((e) => e.basis === "observed").map((e) => e.outcome)),
    };
  });
}

export interface CaveatRun {
  id: string;
  status: RunStatus;
  coverage_status: string;
}

/**
 * Completeness caveats from recorded coverage reports, collector errors, and run status. Absence of a caveat is
 * reported as "no_known_gaps", never as "complete".
 */
export function completeness(db: Db, runs: readonly CaveatRun[], scopeCaveats: readonly CoverageCaveat[] = []): Completeness {
  const caveats: CoverageCaveat[] = [];
  for (const run of runs) {
    const coverage = getCoverage(db, run.id);
    const level = coverage?.level ?? run.coverage_status;
    if (!coverage) {
      caveats.push({ kind: "coverage_unknown", run_id: run.id, detail: "No coverage report was recorded for this run." });
    } else if (level === "unknown") {
      caveats.push({ kind: "coverage_unknown", run_id: run.id, detail: "Coverage level is unknown." });
    } else if (level === "partial" || level === "minimal") {
      const missing = coverage.categories.filter((c) => c.status !== "observed").map((c) => c.category);
      const detail = missing.length ? `Coverage is ${level}; not fully observed: ${[...new Set(missing)].join(", ")}.` : `Coverage is ${level}.`;
      caveats.push({ kind: "coverage_partial", run_id: run.id, detail });
    }
    const errors = coverage?.sources.flatMap((s) => s.errors.map((e) => `${s.source}: ${e}`)) ?? [];
    if (errors.length) caveats.push({ kind: "collector_errors", run_id: run.id, detail: errors.join("; ") });
    if (run.status === "pending" || run.status === "running") {
      caveats.push({ kind: "run_in_progress", run_id: run.id, detail: `Run is ${run.status}; more events and findings may follow.` });
    } else if (run.status === "failed" || run.status === "aborted") {
      caveats.push({ kind: "run_ended_abnormally", run_id: run.id, detail: `Run ${run.status}; its record may be incomplete.` });
    }
  }
  caveats.push(...scopeCaveats);
  const status: Completeness["status"] = runs.length === 0 ? "no_runs" : caveats.length ? "has_gaps" : "no_known_gaps";
  return { status, caveats };
}
