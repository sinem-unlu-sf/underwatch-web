import { buildEvidenceBundle, type BundleItem } from "@kw/inference";
import type { BundleEvidenceRef, Event, EventBasis, Finding, VerificationRun } from "@kw/schema";
import type { ServerContext } from "../context";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import * as t from "../db/tables";
import { getFinding, getFindingDetail } from "../repo/findings";
import { getEvidenceByIds as getFindingDetailEvidence } from "../repo/evidence";
import { getCoverage, getEventsByIds } from "../repo/runs";
import type { EvidenceBundleResult, EvidenceRetriever, RetrievalInfo } from "./types";
import { recordedOutcomesFromRow } from "../verification/repo";

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function summaryFor(item: BundleItem): string {
  const f = item.fields;
  switch (item.kind) {
    case "event":
      return str(f.summary) ?? `${String(f.event_type)} ${String(f.outcome)}`;
    case "finding":
      return str(f.title) ?? item.evidence_id;
    case "policy_rule":
      return `${String(f.effect)} ${String(f.action)} ${String(f.resource_pattern)}`;
    case "coverage":
      return `Observation coverage: ${String(f.coverage_level)}; ${String(f.observed_events_on_targets_in_run)} observed event(s) on the finding's targets`;
    case "safeguard":
      return `${String(f.type)}: ${str(f.title) ?? item.evidence_id} (verification ${String(f.verification_status)})`;
    case "related_finding":
      return `Other run: ${str(f.title) ?? item.evidence_id} (${String(f.status)})`;
    default:
      return str(f.source_reference) ?? str(f.source_type) ?? item.evidence_id;
  }
}

function refFor(item: BundleItem, runId: string, basis: EventBasis | null): BundleEvidenceRef {
  return {
    evidence_id: item.evidence_id,
    kind: item.kind,
    basis,
    source: item.source,
    timestamp: item.timestamp,
    summary: summaryFor(item).slice(0, 300),
    run_id: item.kind === "policy_rule" || item.kind === "safeguard" ? null : item.kind === "related_finding" ? String(item.fields.run_id) : runId,
  };
}

/** Questions that explicitly ask about other runs; only these widen retrieval to related findings (summaries only). */
const CROSS_RUN_QUESTION = /\b(other|previous|prior|earlier|similar|related|past)\b[^?]{0,60}\b(runs?|findings?|sessions?|incidents?|times?)\b|\brecurr|\bhappened (again|before)|\belsewhere\b|\bbefore\b.*\b(runs?|sessions?)\b/i;

export function questionWantsRelatedRuns(question: string | null): boolean {
  return question !== null && CROSS_RUN_QUESTION.test(question);
}

const MAX_EXTRA_EVENTS = 10;
const MAX_RELATED_FINDINGS = 5;

/** Observed events of the same run that touch one of the finding's targets but are not already linked to it. */
function observedEventsOnTargets(db: Db, runId: string, targets: string[], exclude: Set<string>): Event[] {
  if (targets.length === 0) return [];
  const ids = stmt(
    db,
    `SELECT id FROM events WHERE run_id = ? AND basis = 'observed' AND target_resource IN (SELECT value FROM json_each(?))
     ORDER BY julianday(timestamp), id LIMIT ?`,
  )
    .all(runId, JSON.stringify(targets), MAX_EXTRA_EVENTS + exclude.size)
    .map((r) => r.id as string);
  return getEventsByIds(db, ids.filter((id) => !exclude.has(id)).slice(0, MAX_EXTRA_EVENTS));
}

function relatedFindingsInOtherRuns(db: Db, finding: Finding, targets: string[]): Array<{ finding: Finding; shared_targets: string[] }> {
  if (targets.length === 0) return [];
  const rows = stmt(
    db,
    `SELECT fe.finding_id AS finding_id, json_group_array(DISTINCT e.target_resource) AS shared
     FROM finding_events fe JOIN events e ON e.id = fe.event_id JOIN findings f ON f.id = fe.finding_id
     WHERE f.run_id != ? AND e.target_resource IN (SELECT value FROM json_each(?))
     GROUP BY fe.finding_id ORDER BY MAX(julianday(f.created_at)) DESC, fe.finding_id LIMIT ?`,
  ).all(finding.run_id, JSON.stringify(targets), MAX_RELATED_FINDINGS);
  return rows.flatMap((r) => {
    const f = getFinding(db, r.finding_id as string);
    return f ? [{ finding: f, shared_targets: (JSON.parse(String(r.shared)) as string[]).slice(0, 5) }] : [];
  });
}

function verificationRun(db: Db, id: string | null): VerificationRun | null {
  if (id === null) return null;
  const row = stmt(db, `SELECT ${t.verificationRuns.selectColumns}, security_outcome, task_outcome, reported_task_claim FROM verification_runs WHERE id = ?`).get(id);
  // Issue 4: carry harness-recorded security/task outcomes (absent for historical rows; derived as legacy downstream).
  return row ? { ...t.verificationRuns.fromRow(row), ...recordedOutcomesFromRow(row) } : null;
}

/** Collects secrets the server knows so they can never leak into a prompt even if they appear in evidence. */
export function knownSecrets(env: NodeJS.ProcessEnv): string[] {
  return ["AIAND_API_KEY", "NEO4J_PASSWORD", "CLAUDE_CODE_OAUTH_TOKEN", "KW_API_TOKEN"].flatMap((k) => {
    const v = env[k]?.trim();
    return v && v.length >= 8 ? [v] : [];
  });
}

/** How a bundle's extra context was chosen (stored with the turn metadata and shown on the bundle result). */
export interface ExtraContext {
  /** Additional events of the SAME run (already ordered by priority; capped by the caller). */
  extraEvents: Event[];
  /** Null = the question did not ask about other runs (never widened). */
  relatedFindings: Array<{ finding: Finding; shared_targets: string[] }>;
  retrieval: RetrievalInfo;
}

/**
 * Seals the finding's bundle: the finding, its related events (reported / observed / derived kept distinct) and their
 * evidence excerpts, `extra.extraEvents` (same run only), the policy rule(s), the run's coverage report, existing
 * safeguards with their latest verification, and `extra.relatedFindings` (summaries only). Never other runs' events,
 * whole logs, or repository files. Shared by the relational and graph retrievers.
 */
export function assembleFindingBundle(
  ctx: ServerContext,
  findingId: string,
  pick: (detail: ReturnType<typeof getFindingDetail>, targets: string[]) => ExtraContext,
): EvidenceBundleResult {
  const detail = getFindingDetail(ctx.db, findingId);
  const targets = [...new Set(detail.related_events.flatMap((e) => (e.target_resource ? [e.target_resource] : [])))].slice(0, 20);
  const relatedIds = new Set(detail.related_events.map((e) => e.id));
  const extra = pick(detail, targets);
  const extraEvents = extra.extraEvents.filter((e) => !relatedIds.has(e.id) && e.run_id === detail.run.id).slice(0, MAX_EXTRA_EVENTS);
  const observedOnTargets = [...detail.related_events, ...extraEvents].filter((e) => e.basis === "observed" && e.target_resource && targets.includes(e.target_resource));
  const extraEvidenceIds = new Set(extraEvents.flatMap((e) => (e.evidence_id ? [e.evidence_id] : [])));
  const extraEvidence = extraEvidenceIds.size > 0 ? getFindingDetailEvidence(ctx.db, [...extraEvidenceIds]) : [];
  const bundle = buildEvidenceBundle({
    finding: detail.finding,
    events: detail.related_events,
    additionalEvents: extraEvents,
    evidence: [...detail.evidence, ...extraEvidence.filter((v) => !detail.evidence.some((d) => d.id === v.id))],
    policy: detail.policy,
    coverage: { report: getCoverage(ctx.db, detail.run.id), targets, observed_event_ids_on_targets: observedOnTargets.map((e) => e.id) },
    safeguards: detail.safeguards.map((sg) => ({ safeguard: sg, verification: verificationRun(ctx.db, sg.last_verification_run_id) })),
    relatedFindings: extra.relatedFindings.slice(0, MAX_RELATED_FINDINGS),
    redaction: { knownSecrets: knownSecrets(ctx.env) },
  });
  // Evidence records carry the basis of the events that reference them (observed wins); unlinked records and
  // KW records (policy rules, coverage, safeguards) count as derived.
  const evidenceBasis = new Map<string, EventBasis>();
  for (const item of bundle.items) {
    if (item.kind !== "event" || item.basis === null) continue;
    for (const id of item.links) {
      const prev = evidenceBasis.get(id);
      if (prev !== "observed" && (item.basis === "observed" || prev === undefined || (prev === "derived" && item.basis === "reported"))) {
        evidenceBasis.set(id, item.basis);
      }
    }
  }
  const basisOf = (i: BundleItem): EventBasis | null => (i.kind === "evidence" ? (evidenceBasis.get(i.evidence_id) ?? null) : i.basis);
  const bases = new Map<string, EventBasis | null>(bundle.items.map((i) => [i.evidence_id, basisOf(i)]));
  return {
    finding: detail.finding,
    run: detail.run,
    policy: detail.policy,
    bundle,
    bases,
    refs: bundle.items.map((i) => refFor(i, detail.run.id, basisOf(i))),
    retrieval: extra.retrieval,
  };
}

/** Relational choice of extra context: observed events of the same run on the finding's targets; related findings by SQL join. */
export function relationalExtras(ctx: ServerContext, question: string | null, retrieval: RetrievalInfo) {
  return (detail: ReturnType<typeof getFindingDetail>, targets: string[]): ExtraContext => ({
    extraEvents: observedEventsOnTargets(ctx.db, detail.run.id, targets, new Set(detail.related_events.map((e) => e.id))),
    relatedFindings: questionWantsRelatedRuns(question) ? relatedFindingsInOtherRuns(ctx.db, detail.finding, targets) : [],
    retrieval,
  });
}

/**
 * Relational implementation: the smallest bundle sufficient for questions about one finding, read through the existing
 * repo layer (see assembleFindingBundle). Related findings in other runs are added ONLY when the question asks about
 * other runs. The graph retriever (graph-retriever.ts) is the default and falls back to this one.
 */
export function createRelationalEvidenceRetriever(ctx: ServerContext): EvidenceRetriever {
  return {
    id: "relational",
    async forFinding(findingId: string, question: string | null = null): Promise<EvidenceBundleResult> {
      return assembleFindingBundle(ctx, findingId, relationalExtras(ctx, question, { retriever: "relational", fallback_reason: null, graph: null }));
    },
  };
}
