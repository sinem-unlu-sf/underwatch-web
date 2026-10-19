import neo4j from "neo4j-driver";
import {
  outcomesFromFlatProps,
  type Confidence,
  type EventBasis,
  type EventType,
  type Outcome,
  type ReportedTaskClaim,
  type RunOutcomes,
  type SecurityOutcome,
  type TaskOutcome,
  type VerificationResult,
  type VerificationRunStatus,
} from "@kw/schema";
import { fail, ok, type GraphClient, type GraphResult } from "./client";
import type { RecordBasis, RelBasis, ResourceKind } from "./model";

// ---------------------------------------------------------------------------------------------------------------
// Shared row shapes
// ---------------------------------------------------------------------------------------------------------------

export interface EventRef {
  id: string;
  run_id: string;
  basis: EventBasis;
  event_type: EventType;
  source: string;
  timestamp: string;
  outcome: Outcome;
  summary: string;
  target_resource: string | null;
  process_id: number | null;
  parent_process_id: number | null;
  process_name: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  is_fixture: boolean;
}

/** Provenance carried by every relationship (see model.ts RelBasis). */
export interface RelInfo {
  basis: RelBasis;
  rule: string;
  confidence: Confidence | null;
  record_basis: RecordBasis;
}

export interface ProcessRef {
  id: string;
  run_id: string;
  pid: number;
  name: string | null;
  names: string[];
}

export interface PolicyVersionRef {
  id: string;
  policy_id: string;
  version: string;
  name: string;
  created_at: string;
  rule_ids: string[];
  is_fixture: boolean;
}

export interface FindingRef {
  id: string;
  run_id: string;
  category: string;
  title: string;
  severity: string;
  confidence: Confidence;
  status: string;
  policy_version_id: string | null;
  policy_rule_id: string | null;
  is_fixture: boolean;
}

export interface SafeguardRef {
  id: string;
  finding_id: string;
  type: string;
  title: string;
  approval_status: string;
  application_status: string;
  verification_status: string;
  created_at: string;
  is_fixture: boolean;
}

const EVENT = (v: string) =>
  `${v}{.id, .run_id, .basis, .event_type, .source, .timestamp, .outcome, .summary, .target_resource, .process_id, .parent_process_id, .process_name, .tool_name, .tool_use_id, .is_fixture}`;
const REL = (v: string) => `CASE WHEN ${v} IS NULL THEN null ELSE ${v}{.basis, .rule, .confidence, .record_basis} END`;
const PROC = (v: string) => `CASE WHEN ${v} IS NULL THEN null ELSE ${v}{.id, .run_id, .pid, .name, .names} END`;
const PV = (v: string) => `CASE WHEN ${v} IS NULL THEN null ELSE ${v}{.id, .policy_id, .version, .name, .created_at, .rule_ids, .is_fixture} END`;
const FINDING = (v: string) => `${v}{.id, .run_id, .category, .title, .severity, .confidence, .status, .policy_version_id, .policy_rule_id, .is_fixture}`;
const SAFEGUARD = (v: string) =>
  `${v}{.id, .finding_id, .type, .title, .approval_status, .application_status, .verification_status, .created_at, .is_fixture}`;

const nullable = <T>(x: unknown): T | null => (x === undefined || x === null ? null : (x as T));
const procRef = (x: unknown): ProcessRef | null => {
  const p = nullable<ProcessRef>(x);
  return p ? { ...p, name: p.name ?? null, names: p.names ?? [] } : null;
};
const eventRef = (x: unknown): EventRef => {
  const e = x as Record<string, unknown>;
  const keys = ["target_resource", "process_id", "parent_process_id", "process_name", "tool_name", "tool_use_id"] as const;
  const out = { ...e } as Record<string, unknown>;
  for (const k of keys) out[k] = e[k] ?? null;
  return out as unknown as EventRef;
};
const relInfo = (x: unknown): RelInfo | null => {
  const r = nullable<Record<string, unknown>>(x);
  return r ? { basis: r.basis as RelBasis, rule: String(r.rule), confidence: nullable(r.confidence), record_basis: nullable(r.record_basis) } : null;
};
const pvRef = (x: unknown): PolicyVersionRef | null => {
  const p = nullable<PolicyVersionRef>(x);
  return p ? { ...p, rule_ids: p.rule_ids ?? [] } : null;
};
const findingRef = (x: unknown): FindingRef => {
  const f = x as FindingRef;
  return { ...f, policy_version_id: f.policy_version_id ?? null, policy_rule_id: f.policy_rule_id ?? null };
};

async function exists(g: GraphClient, label: "Finding" | "Event" | "Run" | "Safeguard", id: string): Promise<GraphResult<boolean>> {
  const r = await g.read(`MATCH (n:${label} {id: $id}) RETURN count(n) > 0 AS e`, { id }, (rec) => rec.get("e") as boolean);
  return r.ok ? ok(r.value[0] ?? false) : r;
}

/** Wraps a query whose empty result is ambiguous: distinguishes "entity not in graph" from "no rows". */
export type Lookup<T> = { found: false; id: string } | ({ found: true } & T);

// ---------------------------------------------------------------------------------------------------------------
// FR-8 Q1: Which observed events support this finding?
// ---------------------------------------------------------------------------------------------------------------

export interface SupportingEventRow {
  event: EventRef;
  /** Basis of the cited event: observed | reported | derived. */
  role: string;
  relation: RelInfo;
  /** Evidence records the event was captured from (event.evidence_id). */
  evidence_ids: string[];
}

export async function eventsSupportingFinding(
  g: GraphClient,
  findingId: string,
  opts: { includeNonObserved?: boolean } = {},
): Promise<GraphResult<Lookup<{ finding_id: string; rows: SupportingEventRow[]; cited_evidence_ids: string[] }>>> {
  const r = await g.read(
    `MATCH (f:Finding {id: $id})
     OPTIONAL MATCH (f)-[s:SUPPORTED_BY]->(e:Event)
     WHERE $all OR e:ObservedEvent
     OPTIONAL MATCH (e)-[:SUPPORTED_BY]->(ev:Evidence)
     WITH f, s, e, collect(DISTINCT ev.id) AS evidence_ids
     ORDER BY e.ts, e.id
     WITH f, collect(CASE WHEN e IS NULL THEN null ELSE {event: ${EVENT("e")}, role: s.role, rel: ${REL("s")}, evidence_ids: evidence_ids} END) AS rows
     OPTIONAL MATCH (f)-[:SUPPORTED_BY]->(fev:Evidence)
     RETURN rows, collect(DISTINCT fev.id) AS cited`,
    { id: findingId, all: opts.includeNonObserved === true },
    (rec) => ({ rows: rec.get("rows") as Record<string, unknown>[], cited: rec.get("cited") as string[] }),
  );
  if (!r.ok) return r;
  const first = r.value[0];
  if (!first) return ok({ found: false, id: findingId });
  return ok({
    found: true,
    finding_id: findingId,
    rows: first.rows.map((x) => ({ event: eventRef(x.event), role: String(x.role), relation: relInfo(x.rel)!, evidence_ids: (x.evidence_ids as string[]).sort() })),
    cited_evidence_ids: first.cited.sort(),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// FR-8 Q2: Which agent report was compared against each observed event?
// ---------------------------------------------------------------------------------------------------------------

export interface ReportComparison {
  agent_event: EventRef;
  correlation_id: string;
  match: string;
  confidence: Confidence;
  basis: RelBasis;
}

export interface ObservedComparisonRow {
  observed: EventRef;
  /** Agent reports paired with this observed event by correlation (OBSERVED_AS). */
  compared_reports: ReportComparison[];
  /** Agent reports this observed event contradicts, per a finding (CONTRADICTS). */
  contradicted_reports: { agent_event: EventRef; finding_id: string; basis: RelBasis; confidence: Confidence | null }[];
  /** paired: >=1 report paired. observed_only: the correlator recorded no matching report. not_correlated: no correlation record at all. */
  status: "paired" | "observed_only" | "not_correlated";
  correlation_states: string[];
}

export async function reportsComparedToObserved(
  g: GraphClient,
  runId: string,
  opts: { observedEventId?: string } = {},
): Promise<GraphResult<Lookup<{ run_id: string; rows: ObservedComparisonRow[] }>>> {
  const r = await g.read(
    `MATCH (:Run {id: $runId})-[:HAS_EVENT]->(o:ObservedEvent)
     WHERE $eid IS NULL OR o.id = $eid
     OPTIONAL MATCH (a:AgentEvent)-[c:OBSERVED_AS]->(o)
     WITH o, collect(CASE WHEN a IS NULL THEN null ELSE {agent_event: ${EVENT("a")}, correlation_id: c.correlation_id, match: c.match, confidence: c.confidence, basis: c.basis} END) AS compared
     OPTIONAL MATCH (o)-[x:CONTRADICTS]->(a2:AgentEvent)
     WITH o, compared, collect(CASE WHEN a2 IS NULL THEN null ELSE {agent_event: ${EVENT("a2")}, finding_id: x.finding_id, basis: x.basis, confidence: x.confidence} END) AS contradicted
     RETURN ${EVENT("o")} AS observed, compared, contradicted, coalesce(o.correlation_states, []) AS states
     ORDER BY o.ts, o.id`,
    { runId, eid: opts.observedEventId ?? null },
    (rec) => ({
      observed: eventRef(rec.get("observed")),
      compared: rec.get("compared") as Record<string, unknown>[],
      contradicted: rec.get("contradicted") as Record<string, unknown>[],
      states: rec.get("states") as string[],
    }),
  );
  if (!r.ok) return r;
  if (r.value.length === 0) {
    const e = await exists(g, "Run", runId);
    if (!e.ok) return e;
    if (!e.value) return ok({ found: false, id: runId });
  }
  return ok({
    found: true,
    run_id: runId,
    rows: r.value.map((row) => {
      const compared_reports = row.compared
        .map((c) => ({ ...(c as unknown as ReportComparison), agent_event: eventRef(c.agent_event) }))
        .sort((a, b) => a.correlation_id.localeCompare(b.correlation_id));
      return {
        observed: row.observed,
        compared_reports,
        contradicted_reports: row.contradicted.map((c) => ({
          agent_event: eventRef(c.agent_event),
          finding_id: String(c.finding_id),
          basis: c.basis as RelBasis,
          confidence: nullable<Confidence>(c.confidence),
        })),
        status: compared_reports.length > 0 ? "paired" : row.states.includes("observed_only") ? "observed_only" : "not_correlated",
        correlation_states: row.states,
      };
    }),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// FR-8 Q3: Which process generated a particular event?
// ---------------------------------------------------------------------------------------------------------------

export interface ProcessForEvent {
  event_id: string;
  process: ProcessRef | null;
  attribution: RelInfo | null;
  parent: ProcessRef | null;
  parent_relation: RelInfo | null;
  /** process_exec observed events performed by that process (the command that started it). */
  exec_event_ids: string[];
  /** Why process is null, when it is. */
  unavailable_reason: string | null;
}

export async function processForEvent(g: GraphClient, eventId: string): Promise<GraphResult<Lookup<ProcessForEvent>>> {
  const r = await g.read(
    `MATCH (e:Event {id: $id})
     OPTIONAL MATCH (e)-[pb:PERFORMED_BY]->(p:Process)
     OPTIONAL MATCH (parent:Process)-[sp:SPAWNED]->(p)
     OPTIONAL MATCH (x:ObservedEvent {event_type: 'process_exec'})-[:PERFORMED_BY]->(p)
     RETURN e.process_id AS pid, e.unavailable_fields AS unavailable, ${PROC("p")} AS p, ${REL("pb")} AS pb,
            ${PROC("parent")} AS parent, ${REL("sp")} AS sp, collect(DISTINCT x.id) AS execs`,
    { id: eventId },
    (rec) => ({
      pid: nullable<number>(rec.get("pid")),
      unavailable: (rec.get("unavailable") as string[] | null) ?? [],
      p: procRef(rec.get("p")),
      pb: relInfo(rec.get("pb")),
      parent: procRef(rec.get("parent")),
      sp: relInfo(rec.get("sp")),
      execs: rec.get("execs") as string[],
    }),
  );
  if (!r.ok) return r;
  const row = r.value[0];
  if (!row) return ok({ found: false, id: eventId });
  return ok({
    found: true,
    event_id: eventId,
    process: row.p,
    attribution: row.pb,
    parent: row.parent,
    parent_relation: row.sp,
    exec_event_ids: row.execs.sort(),
    unavailable_reason: row.p
      ? null
      : row.unavailable.includes("process_id")
        ? "source could not provide process_id (listed in unavailable_fields)"
        : "event carries no process_id (not applicable or not captured by this source)",
  });
}

// ---------------------------------------------------------------------------------------------------------------
// FR-8 Q4: Which policy was in effect when the action occurred?
// ---------------------------------------------------------------------------------------------------------------

export interface PolicyInEffect {
  event_id: string;
  event_timestamp: string;
  run_id: string;
  policy_version: PolicyVersionRef | null;
  relation: RelInfo | null;
  /** false would mean the snapshot postdates the action (data problem); null when unknown. */
  snapshot_created_before_event: boolean | null;
  violations: { policy_version_id: string; policy_rule_id: string | null; finding_id: string | null; relation: RelInfo }[];
  unavailable_reason: string | null;
}

export async function policyInEffect(g: GraphClient, eventId: string): Promise<GraphResult<Lookup<PolicyInEffect>>> {
  const r = await g.read(
    `MATCH (e:Event {id: $id})<-[:HAS_EVENT]-(run:Run)
     OPTIONAL MATCH (run)-[up:UNDER_POLICY]->(pv:PolicyVersion)
     OPTIONAL MATCH (e)-[v:VIOLATES]->(vpv:PolicyVersion)
     RETURN e.timestamp AS ts, run.id AS run_id, ${PV("pv")} AS pv, ${REL("up")} AS up,
            CASE WHEN pv IS NULL THEN null ELSE datetime(pv.created_at) <= datetime(e.timestamp) END AS before,
            collect(CASE WHEN v IS NULL THEN null ELSE {pv: vpv.id, rule: v.policy_rule_id, finding: v.finding_id, rel: ${REL("v")}} END) AS viol`,
    { id: eventId },
    (rec) => ({
      ts: String(rec.get("ts")),
      run_id: String(rec.get("run_id")),
      pv: pvRef(rec.get("pv")),
      up: relInfo(rec.get("up")),
      before: nullable<boolean>(rec.get("before")),
      viol: rec.get("viol") as Record<string, unknown>[],
    }),
  );
  if (!r.ok) return r;
  const row = r.value[0];
  if (!row) return ok({ found: false, id: eventId });
  return ok({
    found: true,
    event_id: eventId,
    event_timestamp: row.ts,
    run_id: row.run_id,
    policy_version: row.pv,
    relation: row.up,
    snapshot_created_before_event: row.before,
    violations: row.viol
      .map((v) => ({ policy_version_id: String(v.pv), policy_rule_id: nullable<string>(v.rule), finding_id: nullable<string>(v.finding), relation: relInfo(v.rel)! }))
      .sort((a, b) => String(a.finding_id).localeCompare(String(b.finding_id))),
    unavailable_reason: row.pv ? null : "run has no policy_version recorded",
  });
}

// ---------------------------------------------------------------------------------------------------------------
// FR-8 Q5: Which safeguard was created from an incident?
// ---------------------------------------------------------------------------------------------------------------

export async function safeguardsFromIncident(
  g: GraphClient,
  findingId: string,
): Promise<GraphResult<Lookup<{ finding_id: string; safeguards: { safeguard: SafeguardRef; relation: RelInfo; verification_run_ids: string[] }[] }>>> {
  const r = await g.read(
    `MATCH (f:Finding {id: $id})
     OPTIONAL MATCH (f)-[p:PROPOSED_AS]->(s:Safeguard)
     OPTIONAL MATCH (s)-[:VERIFIED_BY]->(vr:VerificationRun)
     WITH f, p, s, collect(DISTINCT vr.id) AS vrs
     ORDER BY s.created_at, s.id
     // grouped by f: an unknown finding yields no row (a bare collect() would yield one empty row -> found:true)
     WITH f, collect(CASE WHEN s IS NULL THEN null ELSE {s: ${SAFEGUARD("s")}, rel: ${REL("p")}, vrs: vrs} END) AS rows
     RETURN rows`,
    { id: findingId },
    (rec) => rec.get("rows") as Record<string, unknown>[],
  );
  if (!r.ok) return r;
  const rows = r.value[0];
  if (!rows) return ok({ found: false, id: findingId });
  return ok({
    found: true,
    finding_id: findingId,
    safeguards: rows.map((x) => ({ safeguard: x.s as SafeguardRef, relation: relInfo(x.rel)!, verification_run_ids: (x.vrs as string[]).sort() })),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// FR-8 Q6: Did a subsequent verification run reproduce or prevent the behavior?
// ---------------------------------------------------------------------------------------------------------------

export type VerificationVerdict =
  /** prohibited behavior was attempted and blocked. */
  | "prevented"
  /** attempted and not blocked, or a recurrence of the finding was recorded in the executed run. */
  | "reproduced"
  /** record says not attempted: the scenario did not trigger the behavior, so prevention is NOT shown. */
  | "not_triggered"
  /** the recorded fields disagree (e.g. blocked, but a recurrence finding exists in the executed run). */
  | "conflicting_evidence"
  | "pending"
  | "error"
  /** tri-state fields are null: evidence does not establish an answer. */
  | "not_established";

export interface VerificationOutcomeRow {
  verification_run_id: string;
  safeguard_id: string;
  finding_id: string;
  scenario_id: string;
  status: VerificationRunStatus;
  /** Result as recorded by the verification pipeline (not recomputed). */
  recorded_result: VerificationResult | null;
  prohibited_behavior_attempted: boolean | null;
  prohibited_behavior_blocked: boolean | null;
  legitimate_behavior_worked: boolean | null;
  executed_run_id: string | null;
  /** Findings in the executed run linked from the original finding by RECURRED_AS (any depth up to 5). */
  recurrence_finding_ids: string[];
  /** Issue 4: did enforcement let the prohibited action through? Independent of the task. */
  security_outcome: SecurityOutcome;
  /** Issue 4: was the legitimate task done, per independent completion checks only? Independent of enforcement. */
  task_outcome: TaskOutcome;
  /** The agent's own claim (basis "reported"); never sets task_outcome. */
  reported_task_claim: ReportedTaskClaim | null;
  outcome_origin: RunOutcomes["outcome_origin"];
  /** Disagreements between the recorded outcomes and the graph (e.g. blocked, but the finding recurred in the executed run). */
  outcome_conflicts: string[];
  /**
   * LEGACY enforcement-only verdict computed from prohibited_behavior_attempted/blocked. It says nothing about the
   * task: "prevented" is NOT a task success. Kept for compatibility; use security_outcome + task_outcome.
   */
  legacy_verdict: VerificationVerdict;
  legacy_verdict_reason: string;
  /** @deprecated alias of legacy_verdict (enforcement only, not a task outcome). */
  verdict: VerificationVerdict;
  /** @deprecated alias of legacy_verdict_reason. */
  verdict_reason: string;
}

type OutcomeFields = "security_outcome" | "task_outcome" | "reported_task_claim" | "outcome_origin" | "outcome_conflicts" | "legacy_verdict" | "legacy_verdict_reason" | "verdict" | "verdict_reason";

/** Rebuilds the separate outcomes from the flattened VerificationRun node properties (see verificationOutcomeProps). */
export function outcomesFromNodeProps(p: Record<string, unknown>): RunOutcomes {
  return outcomesFromFlatProps(p);
}

export function verdictFor(row: Omit<VerificationOutcomeRow, OutcomeFields>): { verdict: VerificationVerdict; reason: string } {
  if (row.status === "pending" || row.status === "running") return { verdict: "pending", reason: `verification status is ${row.status}` };
  if (row.status === "error") return { verdict: "error", reason: "verification run errored" };
  const recurred = row.recurrence_finding_ids.length > 0;
  const a = row.prohibited_behavior_attempted;
  const b = row.prohibited_behavior_blocked;
  if (a === true && b === true) {
    return recurred
      ? { verdict: "conflicting_evidence", reason: "record says attempted+blocked, but a RECURRED_AS finding exists in the executed run" }
      : { verdict: "prevented", reason: "prohibited_behavior_attempted=true and prohibited_behavior_blocked=true" };
  }
  if (a === true && b === false) return { verdict: "reproduced", reason: "prohibited_behavior_attempted=true and prohibited_behavior_blocked=false" };
  if (recurred) return { verdict: "reproduced", reason: "a RECURRED_AS finding exists in the executed run" };
  if (a === false) return { verdict: "not_triggered", reason: "prohibited_behavior_attempted=false: the scenario did not exercise the behavior" };
  return { verdict: "not_established", reason: "attempted/blocked are not established by evidence (null)" };
}

export async function verificationOutcomes(
  g: GraphClient,
  by: { findingId: string } | { safeguardId: string },
): Promise<GraphResult<VerificationOutcomeRow[]>> {
  const findingId = "findingId" in by ? by.findingId : null;
  const safeguardId = "safeguardId" in by ? by.safeguardId : null;
  const r = await g.read(
    `MATCH (f:Finding)-[:PROPOSED_AS]->(s:Safeguard)-[:VERIFIED_BY]->(vr:VerificationRun)
     WHERE ($fid IS NOT NULL AND f.id = $fid) OR ($sid IS NOT NULL AND s.id = $sid)
     OPTIONAL MATCH (vr)-[:EXECUTED_AS]->(run:Run)
     OPTIONAL MATCH (f)-[:RECURRED_AS*1..5]->(rf:Finding)<-[:HAS_FINDING]-(run)
     RETURN vr{.*} AS vr,
            collect(DISTINCT rf.id) AS rec
     ORDER BY vr.started_at, vr.id`,
    { fid: findingId, sid: safeguardId },
    (rec) => ({ vr: rec.get("vr") as Record<string, unknown>, rec: rec.get("rec") as string[] }),
  );
  if (!r.ok) return r;
  return ok(
    r.value.map(({ vr, rec }) => {
      const base = {
        verification_run_id: String(vr.id),
        safeguard_id: String(vr.safeguard_id),
        finding_id: String(vr.finding_id),
        scenario_id: String(vr.scenario_id),
        status: vr.status as VerificationRunStatus,
        recorded_result: nullable<VerificationResult>(vr.result),
        prohibited_behavior_attempted: nullable<boolean>(vr.prohibited_behavior_attempted),
        prohibited_behavior_blocked: nullable<boolean>(vr.prohibited_behavior_blocked),
        legitimate_behavior_worked: nullable<boolean>(vr.legitimate_behavior_worked),
        executed_run_id: nullable<string>(vr.executed_run_id),
        recurrence_finding_ids: rec.sort(),
      };
      const v = verdictFor(base);
      const o = outcomesFromNodeProps(vr);
      const outcome_conflicts =
        base.recurrence_finding_ids.length > 0 && o.security_outcome.value === "blocked"
          ? [`security_outcome is blocked, but RECURRED_AS finding(s) exist in the executed run: ${base.recurrence_finding_ids.join(", ")}`]
          : [];
      return {
        ...base,
        ...o,
        outcome_conflicts,
        legacy_verdict: v.verdict,
        legacy_verdict_reason: v.reason,
        verdict: v.verdict,
        verdict_reason: v.reason,
      };
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Multi-hop 1: process ancestry from an observed event back to the originating tool call (SPAWNED paths).
// A flat event list would need a recursive self-join over (pid, ppid) plus a join through correlations.
// ---------------------------------------------------------------------------------------------------------------

export interface AncestryHop {
  process: ProcessRef;
  /** Relation from the previous (parent) hop to this one; null for the root. */
  spawned_by: (RelInfo & { event_ids: string[] }) | null;
}

export interface ProcessAncestry {
  event_id: string;
  /** Root first, the event's own process last. Empty when the event has no process. */
  chain: AncestryHop[];
  /** True when the walk stopped at maxDepth before reaching a process without a known parent. */
  depth_limited: boolean;
  origin_tool_call: {
    agent_event: EventRef;
    /** Process in the chain the tool call is linked to (via correlation with its process_exec). */
    via_process_id: string;
    /** Hops from that process down to the event's process. */
    hops_to_event_process: number;
    relation: RelInfo;
  } | null;
  unresolved_reason: string | null;
}

export async function processAncestry(g: GraphClient, eventId: string, opts: { maxDepth?: number } = {}): Promise<GraphResult<Lookup<ProcessAncestry>>> {
  const maxDepth = opts.maxDepth ?? 12;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 50) return fail("invalid_input", "maxDepth must be an integer in 1..50");
  const r = await g.read(
    `MATCH (e:Event {id: $id})
     OPTIONAL MATCH (e)-[:PERFORMED_BY]->(p:Process)
     OPTIONAL MATCH path = (anc:Process)-[:SPAWNED*0..${maxDepth}]->(p)
     WITH e, p, path ORDER BY length(path) DESC
     WITH e, p, head(collect(path)) AS path
     WITH e, p, path, CASE WHEN path IS NULL THEN [] ELSE nodes(path) END AS ns
     WITH e, p, path, ns, head(ns) AS root
     WITH e, p, path, ns, root IS NOT NULL AND EXISTS { MATCH (:Process)-[:SPAWNED]->(root) } AS rootHasParent
     OPTIONAL MATCH (tc:AgentEvent)-[ts:SPAWNED]->(o:Process) WHERE o IN ns
     WITH e, p, path, ns, rootHasParent, collect(CASE WHEN tc IS NULL THEN null ELSE {tc: ${EVENT("tc")}, rel: ${REL("ts")}, via: o.id} END) AS origins
     RETURN p IS NOT NULL AS has_process,
            [n IN ns | n{.id, .run_id, .pid, .name, .names}] AS chain,
            CASE WHEN path IS NULL THEN [] ELSE [r IN relationships(path) | r{.basis, .rule, .confidence, .record_basis, .event_ids}] END AS rels,
            CASE WHEN path IS NULL THEN false ELSE length(path) = ${maxDepth} AND rootHasParent END AS limited,
            origins`,
    { id: eventId },
    (rec) => ({
      has: rec.get("has_process") as boolean,
      chain: rec.get("chain") as Record<string, unknown>[],
      rels: rec.get("rels") as Record<string, unknown>[],
      limited: rec.get("limited") as boolean,
      origins: rec.get("origins") as Record<string, unknown>[],
    }),
  );
  if (!r.ok) return r;
  const row = r.value[0];
  if (!row) return ok({ found: false, id: eventId });
  const chain: AncestryHop[] = row.chain.map((n, i) => {
    const rel = i === 0 ? null : row.rels[i - 1];
    return {
      process: procRef(n)!,
      spawned_by: rel ? { ...relInfo(rel)!, event_ids: (rel.event_ids as string[] | null) ?? [] } : null,
    };
  });
  const index = new Map(chain.map((h, i) => [h.process.id, i]));
  const origins = row.origins
    .map((o) => ({ agent_event: eventRef(o.tc), relation: relInfo(o.rel)!, via_process_id: String(o.via), idx: index.get(String(o.via)) ?? -1 }))
    .sort((a, b) => b.idx - a.idx || a.agent_event.id.localeCompare(b.agent_event.id));
  const best = origins[0];
  return ok({
    found: true,
    event_id: eventId,
    chain,
    depth_limited: row.limited,
    origin_tool_call: best
      ? { agent_event: best.agent_event, via_process_id: best.via_process_id, hops_to_event_process: chain.length - 1 - best.idx, relation: best.relation }
      : null,
    unresolved_reason: !row.has
      ? "event has no attributed process"
      : best
        ? null
        : "no reported tool call is correlated with a process_exec of any process in the ancestry",
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Multi-hop 2: cross-run recurrence. Findings in different runs whose cited observed events touched the same
// Resource while the runs were under different policy versions (did a policy change actually help?).
// ---------------------------------------------------------------------------------------------------------------

export interface CrossRunRecurrenceRow {
  resource: { id: string; kind: ResourceKind; key: string };
  earlier: { finding: FindingRef; run_id: string; policy_version: PolicyVersionRef; event_ids: string[] };
  later: { finding: FindingRef; run_id: string; policy_version: PolicyVersionRef; event_ids: string[] };
  /** Both versions belong to the same logical policy (a policy edit) vs. two unrelated policies. */
  same_logical_policy: boolean;
  /** Whether analysis also linked the two findings with RECURRED_AS. */
  linked_by_recurrence: boolean;
}

export async function crossRunResourceRecurrence(
  g: GraphClient,
  filter: { resourceId?: string; findingId?: string; limit?: number } = {},
): Promise<GraphResult<CrossRunRecurrenceRow[]>> {
  const limit = filter.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return fail("invalid_input", "limit must be an integer in 1..1000");
  const r = await g.read(
    `MATCH (r1:Run)-[:HAS_FINDING]->(f1:Finding)-[:SUPPORTED_BY]->(e1:ObservedEvent)-[:TARGETS]->(res:Resource)
           <-[:TARGETS]-(e2:ObservedEvent)<-[:SUPPORTED_BY]-(f2:Finding)<-[:HAS_FINDING]-(r2:Run)
     WHERE r1 <> r2 AND (r1.ts < r2.ts OR (r1.ts = r2.ts AND r1.id < r2.id))
       AND ($rid IS NULL OR res.id = $rid)
       AND ($fid IS NULL OR f1.id = $fid OR f2.id = $fid)
     MATCH (r1)-[:UNDER_POLICY]->(pv1:PolicyVersion)
     MATCH (r2)-[:UNDER_POLICY]->(pv2:PolicyVersion)
     WHERE pv1 <> pv2
     WITH res, f1, r1, pv1, f2, r2, pv2, collect(DISTINCT e1.id) AS e1s, collect(DISTINCT e2.id) AS e2s
     RETURN res{.id, .kind, .key} AS resource,
            ${FINDING("f1")} AS fnd1, r1.id AS run1, ${PV("pv1")} AS pol1, e1s,
            ${FINDING("f2")} AS fnd2, r2.id AS run2, ${PV("pv2")} AS pol2, e2s,
            pv1.policy_id = pv2.policy_id AS same_policy,
            EXISTS { MATCH (f1)-[:RECURRED_AS*1..5]->(f2) } AS linked
     ORDER BY res.key, r1.ts, f1.id, f2.id
     LIMIT $limit`,
    { rid: filter.resourceId ?? null, fid: filter.findingId ?? null, limit: neo4j.int(limit) },
    (rec) => ({
      resource: rec.get("resource") as CrossRunRecurrenceRow["resource"],
      earlier: { finding: findingRef(rec.get("fnd1")), run_id: String(rec.get("run1")), policy_version: pvRef(rec.get("pol1"))!, event_ids: (rec.get("e1s") as string[]).sort() },
      later: { finding: findingRef(rec.get("fnd2")), run_id: String(rec.get("run2")), policy_version: pvRef(rec.get("pol2"))!, event_ids: (rec.get("e2s") as string[]).sort() },
      same_logical_policy: rec.get("same_policy") as boolean,
      linked_by_recurrence: rec.get("linked") as boolean,
    }),
  );
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// UI graph panel: neighborhood of a finding.
// ---------------------------------------------------------------------------------------------------------------

export interface GraphNode {
  /** Same id as the relational record (or the synthetic prc_/res_/task_/plc_ id). */
  id: string;
  labels: string[];
  /** Most specific label, for styling: AgentEvent | ObservedEvent | DerivedEvent | Run | Finding | ... */
  kind: string;
  display: string;
  is_fixture: boolean | null;
  props: Record<string, string | number | boolean | null | string[] | number[]>;
}

export interface GraphEdge {
  /** `${type}:${key}`, stable across rebuilds. */
  id: string;
  type: string;
  source: string;
  target: string;
  basis: RelBasis;
  rule: string;
  confidence: Confidence | null;
  record_basis: RecordBasis;
  props: Record<string, string | number | boolean | null | string[] | number[]>;
}

export interface Subgraph {
  center_id: string;
  depth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the path limit was hit and the neighborhood is incomplete. */
  truncated: boolean;
}

/** Traversed relationship types. Structural hub edges (Run-HAS_EVENT/HAS_EVIDENCE) are excluded so depth stays meaningful; the finding's own Run (and its policy) is always included. */
const NEIGHBORHOOD_RELS =
  "SUPPORTED_BY|OBSERVED_AS|SPAWNED|PERFORMED_BY|TARGETS|REPORTS|VIOLATES|CONTRADICTS|PROPOSED_AS|VERIFIED_BY|RECURRED_AS|EXECUTED_AS|VERSION_OF";
const KIND_PRIORITY = ["AgentEvent", "ObservedEvent", "DerivedEvent"];

function cleanProps(p: Record<string, unknown>): GraphNode["props"] {
  const out: GraphNode["props"] = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "ts" || k === "owner_run") continue;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v as string[];
    else if (Array.isArray(v) && v.every((x) => typeof x === "number")) out[k] = v as number[];
    else out[k] = String(v);
  }
  return out;
}

function displayFor(kind: string, p: GraphNode["props"]): string {
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : null);
  switch (kind) {
    case "Finding":
    case "Safeguard":
      return s("title") ?? s("id")!;
    case "Process":
      return `${s("name") ?? "process"} (pid ${p.pid ?? "?"})`;
    case "Resource":
      return s("key") ?? s("id")!;
    case "PolicyVersion":
      return `${s("name") ?? s("policy_id")} v${s("version") ?? "?"}`;
    case "Policy":
      return s("policy_id") ?? s("id")!;
    case "Run":
      return s("label") ?? s("id")!;
    case "Task":
      return (s("description") ?? "task").slice(0, 80);
    case "VerificationRun":
      // Two separate outcomes, never one merged verdict (issue 4). Falls back to the legacy result for old projections.
      return s("security_outcome") && s("task_outcome")
        ? `${s("scenario_id") ?? "verification"}: security ${s("security_outcome")} · task ${s("task_outcome")}`
        : `${s("scenario_id") ?? "verification"}: ${s("result") ?? s("status") ?? ""} (legacy)`.trim();
    case "Evidence":
      return `${s("source_type")}: ${s("source_reference")}`;
    default:
      return s("summary") ?? s("id")!;
  }
}

export async function findingNeighborhood(
  g: GraphClient,
  findingId: string,
  depth: number = 2,
  opts: { maxPaths?: number } = {},
): Promise<GraphResult<Lookup<Subgraph>>> {
  if (!Number.isInteger(depth) || depth < 1 || depth > 3) return fail("invalid_input", "depth must be 1, 2 or 3");
  const maxPaths = opts.maxPaths ?? 2000;
  if (!Number.isInteger(maxPaths) || maxPaths < 1 || maxPaths > 20000) return fail("invalid_input", "maxPaths must be an integer in 1..20000");
  const r = await g.read(
    `MATCH (f:Finding {id: $id})
     CALL (f) {
       MATCH p = (f)-[:${NEIGHBORHOOD_RELS}*1..${depth}]-(n)
       RETURN p LIMIT $maxPaths
     }
     WITH f, collect(p) AS ps
     OPTIONAL MATCH home = (f)<-[:HAS_FINDING]-(:Run)-[:UNDER_POLICY|HAS_TASK]->()
     WITH f, ps, collect(home) AS homes
     WITH f, size(ps) AS pathCount, ps + homes AS all
     WITH f, pathCount,
          reduce(acc = [f], p IN all | acc + nodes(p)) AS ns,
          reduce(acc = [], p IN all | acc + relationships(p)) AS rs
     UNWIND ns AS n
     WITH pathCount, rs, collect(DISTINCT n) AS nodes
     UNWIND (CASE WHEN size(rs) = 0 THEN [null] ELSE rs END) AS r
     WITH pathCount, nodes, collect(DISTINCT r) AS rels
     RETURN pathCount,
            [n IN nodes | {labels: labels(n), props: properties(n)}] AS nodes,
            [r IN rels | {type: type(r), source: startNode(r).id, target: endNode(r).id, props: properties(r)}] AS rels`,
    { id: findingId, maxPaths: neo4j.int(maxPaths) },
    (rec) => ({
      pathCount: Number(rec.get("pathCount")),
      nodes: rec.get("nodes") as { labels: string[]; props: Record<string, unknown> }[],
      rels: rec.get("rels") as { type: string; source: string; target: string; props: Record<string, unknown> }[],
    }),
  );
  if (!r.ok) return r;
  const row = r.value[0];
  if (!row) return ok({ found: false, id: findingId });
  const nodes: GraphNode[] = row.nodes
    .map((n) => {
      const props = cleanProps(n.props);
      const kind = KIND_PRIORITY.find((k) => n.labels.includes(k)) ?? n.labels.find((l) => l !== "Event") ?? n.labels[0] ?? "Unknown";
      return {
        id: String(props.id),
        labels: [...n.labels].sort(),
        kind,
        display: displayFor(kind, props),
        is_fixture: typeof props.is_fixture === "boolean" ? props.is_fixture : null,
        props,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges: GraphEdge[] = row.rels
    .map((e) => {
      const props = cleanProps(e.props);
      return {
        id: `${e.type}:${String(props.key)}`,
        type: e.type,
        source: e.source,
        target: e.target,
        basis: props.basis as RelBasis,
        rule: String(props.rule),
        confidence: (props.confidence as Confidence | null | undefined) ?? null,
        record_basis: (props.record_basis as RecordBasis | undefined) ?? null,
        props,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return ok({ found: true, center_id: findingId, depth, nodes, edges, truncated: row.pathCount >= maxPaths });
}
