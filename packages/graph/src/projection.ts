import { outcomesForRun, type Event, type Finding, type PolicyVersion, type VerificationRun } from "@kw/schema";
import type { RunBundle } from "./bundle";
import {
  basisFromConfidence,
  basisFromCorrelation,
  basisFromRecord,
  normalizeResource,
  policyNodeId,
  processId,
  resourceKindForEventType,
  taskId,
  type EventSubLabel,
  type PrimaryLabel,
  type RelProps,
  type RelType,
} from "./model";

export type PropValue = string | number | boolean | null | string[] | number[];
export type Props = Record<string, PropValue>;

export interface NodeRow {
  primary: PrimaryLabel;
  extra: EventSubLabel | null;
  id: string;
  /** Owned nodes are replaced wholesale (SET n = props); shared nodes (Resource, Policy, PolicyVersion) are merged (SET n += props). */
  shared: boolean;
  /** ISO timestamp mirrored into a native `ts` datetime property for ordering; null when the entity has none. */
  ts: string | null;
  props: Props;
}

export interface RelRow {
  type: RelType;
  fromLabel: PrimaryLabel;
  from: string;
  toLabel: PrimaryLabel;
  to: string;
  /** Deterministic identity of the relationship (MERGE key), stable across re-projection. */
  key: string;
  props: RelProps & { key: string; owner_run: string | null };
}

/** Relationship properties as supplied by mapping code; confidence/record_basis default to null. */
type RelInput = { basis: RelProps["basis"]; rule: string; confidence?: RelProps["confidence"]; record_basis?: RelProps["record_basis"] } & {
  [extra: string]: string | number | boolean | null | string[] | undefined;
};

export interface ProjectionPlan {
  runId: string;
  nodes: NodeRow[];
  rels: RelRow[];
  /** Finding ids of this run, for linking later-projected findings that recur from them (RECURRED_AS reverse link). */
  findingIds: string[];
}

const EVENT_LABEL: Record<Event["basis"], EventSubLabel> = {
  reported: "AgentEvent",
  observed: "ObservedEvent",
  derived: "DerivedEvent",
};

/** Owned primary labels: deleted and re-created when a run is re-projected (mode "replace"). */
export const OWNED_LABELS = ["Run", "Task", "Event", "Process", "Finding", "Evidence", "Safeguard", "VerificationRun"] as const satisfies readonly PrimaryLabel[];
export const SHARED_LABELS = ["Resource", "Policy", "PolicyVersion"] as const satisfies readonly PrimaryLabel[];

const CONTRADICTION_CATEGORIES = new Set<Finding["category"]>(["outcome_mismatch", "change_mismatch"]);

/**
 * Pure mapping from a run bundle to graph rows. No I/O; deterministic for a given bundle (rows are sorted), which
 * is what makes re-projection idempotent and lets this be unit-tested without Neo4j.
 */
export function planProjection(b: RunBundle): ProjectionPlan {
  const runId = b.run.id;
  const isFixture = b.run.is_fixture;
  const nodes = new Map<string, NodeRow>();
  const rels = new Map<string, RelRow>();

  const node = (n: NodeRow) => {
    const k = `${n.primary}|${n.id}`;
    const prev = nodes.get(k);
    nodes.set(k, prev ? { ...prev, props: { ...prev.props, ...n.props } } : n);
  };
  const rel = (
    type: RelType,
    fromLabel: PrimaryLabel,
    from: string,
    toLabel: PrimaryLabel,
    to: string,
    key: string,
    props: RelInput,
    ownerRun: string | null = runId,
  ) => {
    const k = `${type}|${key}`;
    if (rels.has(k)) return;
    rels.set(k, {
      type,
      fromLabel,
      from,
      toLabel,
      to,
      key,
      props: { confidence: null, record_basis: null, ...props, key, owner_run: ownerRun } as RelRow["props"],
    });
  };

  // Run + Task -----------------------------------------------------------------------------------------------
  node({
    primary: "Run",
    extra: null,
    id: runId,
    shared: false,
    ts: b.run.started_at,
    props: {
      id: runId,
      owner_run: runId,
      is_fixture: isFixture,
      fixture_id: b.fixture_id ?? null,
      label: b.run.label,
      agent_type: b.run.agent_type,
      adapter: b.run.adapter,
      status: b.run.status,
      coverage_status: b.run.coverage_status,
      repository_id: b.run.repository_id,
      repository_revision: b.run.repository_revision,
      policy_version_id: b.run.policy_version,
      started_at: b.run.started_at,
      ended_at: b.run.ended_at,
    },
  });
  const tId = taskId(runId);
  node({
    primary: "Task",
    extra: null,
    id: tId,
    shared: false,
    ts: null,
    props: { id: tId, run_id: runId, owner_run: runId, is_fixture: isFixture, description: b.run.task_description, derived_from: "run.task_description" },
  });
  rel("HAS_TASK", "Run", runId, "Task", tId, `has_task:${runId}`, { basis: "derived", rule: "run.task_description" });

  // Policy ---------------------------------------------------------------------------------------------------
  const pv: PolicyVersion | null = b.policy_version;
  if (pv) {
    const plc = policyNodeId(pv.policy_id);
    node({ primary: "Policy", extra: null, id: plc, shared: true, ts: null, props: { id: plc, policy_id: pv.policy_id } });
    node({
      primary: "PolicyVersion",
      extra: null,
      id: pv.id,
      shared: true,
      ts: pv.created_at,
      props: {
        id: pv.id,
        is_fixture: pv.is_fixture,
        policy_id: pv.policy_id,
        version: pv.version,
        name: pv.name,
        description: pv.description,
        source_reference: pv.source_reference,
        content_sha256: pv.content_sha256,
        created_at: pv.created_at,
        rule_ids: pv.rules.map((r) => r.id),
        rule_effects: pv.rules.map((r) => r.effect),
        rule_actions: pv.rules.map((r) => r.action),
        rule_patterns: pv.rules.map((r) => r.resource_pattern),
      },
    });
    rel("VERSION_OF", "PolicyVersion", pv.id, "Policy", plc, `version_of:${pv.id}`, { basis: "derived", rule: "policy_version.policy_id" }, null);
  }
  if (b.run.policy_version) {
    // Runs keep an immutable policy snapshot, so "policy in effect" for any action in the run is this version.
    rel("UNDER_POLICY", "Run", runId, "PolicyVersion", b.run.policy_version, `under_policy:${runId}`, { basis: "derived", rule: "run.policy_version" });
  }

  // Evidence -------------------------------------------------------------------------------------------------
  for (const ev of b.evidence) {
    node({
      primary: "Evidence",
      extra: null,
      id: ev.id,
      shared: false,
      ts: ev.timestamp,
      props: {
        id: ev.id,
        run_id: ev.run_id,
        owner_run: runId,
        is_fixture: ev.is_fixture,
        source_type: ev.source_type,
        source_reference: ev.source_reference,
        timestamp: ev.timestamp,
        integrity_sha256: ev.integrity_metadata.sha256,
        integrity_size_bytes: ev.integrity_metadata.size_bytes,
        captured_by: ev.integrity_metadata.captured_by,
        redaction_status: ev.redaction_status,
        // excerpt deliberately not projected: the graph is not an evidence store; the UI fetches /api/evidence/:id.
      },
    });
    rel("HAS_EVIDENCE", "Run", runId, "Evidence", ev.id, `has_evidence:${ev.id}`, { basis: "derived", rule: "evidence.run_id" });
  }

  // Events, processes, resources -----------------------------------------------------------------------------
  const corrByEvent = new Map<string, { ids: string[]; states: string[] }>();
  for (const c of b.correlations) {
    for (const id of [c.reported_event_id, c.observed_event_id]) {
      if (!id) continue;
      const u = corrByEvent.get(id) ?? { ids: [], states: [] };
      u.ids.push(c.id);
      u.states.push(c.match);
      corrByEvent.set(id, u);
    }
  }
  const eventById = new Map(b.events.map((e) => [e.id, e]));
  const processNames = new Map<string, Set<string>>();

  const ensureProcess = (pid: number, name: string | null, ts: string) => {
    const id = processId(runId, pid);
    const names = processNames.get(id) ?? new Set<string>();
    if (name) names.add(name);
    processNames.set(id, names);
    const prev = nodes.get(`Process|${id}`);
    const firstSeen = prev && typeof prev.props.first_seen_at === "string" && prev.props.first_seen_at < ts ? prev.props.first_seen_at : ts;
    nodes.set(`Process|${id}`, {
      primary: "Process",
      extra: null,
      id,
      shared: false,
      ts: firstSeen,
      props: {
        id,
        run_id: runId,
        owner_run: runId,
        is_fixture: isFixture,
        pid,
        // Several names for one (run, pid) means exec() replaced the image, or pid reuse (cannot be told apart).
        names: [...names].sort(),
        name: [...names].sort()[0] ?? null,
        first_seen_at: firstSeen,
      },
    });
    return id;
  };

  for (const e of [...b.events].sort((x, y) => x.id.localeCompare(y.id))) {
    const corr = corrByEvent.get(e.id);
    node({
      primary: "Event",
      extra: EVENT_LABEL[e.basis],
      id: e.id,
      shared: false,
      ts: e.timestamp,
      props: {
        id: e.id,
        run_id: e.run_id,
        owner_run: runId,
        is_fixture: e.is_fixture,
        basis: e.basis,
        source: e.source,
        source_native_key: e.source_native_key,
        source_sequence: e.source_sequence,
        event_type: e.event_type,
        timestamp: e.timestamp,
        process_id: e.process_id,
        parent_process_id: e.parent_process_id,
        process_name: e.process_name,
        tool_name: e.tool_name,
        tool_use_id: e.tool_use_id,
        target_resource: e.target_resource,
        outcome: e.outcome,
        evidence_id: e.evidence_id,
        attribution_confidence: e.attribution_confidence,
        collection_status: e.collection_status,
        unavailable_fields: e.unavailable_fields,
        limitations: e.limitations,
        summary: e.summary,
        correlation_ids: corr?.ids ?? [],
        correlation_states: corr?.states ?? [],
      },
    });
    rel("HAS_EVENT", "Run", runId, "Event", e.id, `has_event:${e.id}`, { basis: "derived", rule: "event.run_id" });

    if (e.process_id !== null) {
      const pId = ensureProcess(e.process_id, e.event_type === "process_exec" || e.process_name ? e.process_name : null, e.timestamp);
      const attrib = e.attribution_confidence;
      rel("PERFORMED_BY", "Event", e.id, "Process", pId, `performed_by:${e.id}`, {
        basis: attrib === "low" || attrib === "medium" ? "inferred" : basisFromRecord(e.basis),
        rule: "event.process_id",
        confidence: attrib,
        record_basis: e.basis,
      });
      if (e.parent_process_id !== null && e.parent_process_id !== e.process_id) {
        const parent = ensureProcess(e.parent_process_id, null, e.timestamp);
        const key = `spawn:${parent}->${pId}`;
        const existing = rels.get(`SPAWNED|${key}`);
        if (existing) {
          // Same parent/child pair seen in several records: keep one edge, list every supporting event,
          // and take the strongest source record (observed > derived > reported) as the edge's basis.
          const ids = new Set([...(existing.props.event_ids as string[]), e.id]);
          existing.props.event_ids = [...ids].sort();
          const rank = { reported: 0, derived: 1, observed: 2 } as const;
          const cur = existing.props.record_basis as keyof typeof rank;
          if (rank[e.basis] > rank[cur]) {
            existing.props.record_basis = e.basis;
            existing.props.basis = basisFromRecord(e.basis);
          }
        } else {
          rel("SPAWNED", "Process", parent, "Process", pId, key, {
            basis: basisFromRecord(e.basis),
            rule: "event.parent_process_id",
            record_basis: e.basis,
            event_ids: [e.id],
          });
        }
      }
    }

    if (e.target_resource !== null && e.target_resource.trim() !== "") {
      const r = normalizeResource(e.target_resource, resourceKindForEventType(e.event_type));
      node({ primary: "Resource", extra: null, id: r.id, shared: true, ts: null, props: { id: r.id, kind: r.kind, key: r.key, display: r.key } });
      // An agent's claim about a resource is REPORTS; an independent observation (or derived event) is TARGETS.
      rel(e.basis === "reported" ? "REPORTS" : "TARGETS", "Event", e.id, "Resource", r.id, `target:${e.id}`, {
        basis: basisFromRecord(e.basis),
        rule: "event.target_resource",
        record_basis: e.basis,
        resource_kind: r.kind,
        event_type: e.event_type,
        outcome: e.outcome,
      });
    }

    if (e.evidence_id !== null) {
      rel("SUPPORTED_BY", "Event", e.id, "Evidence", e.evidence_id, `event_evidence:${e.id}`, {
        basis: basisFromRecord(e.basis),
        rule: "event.evidence_id",
        record_basis: e.basis,
        role: "source_record",
      });
    }
  }

  // Correlations ---------------------------------------------------------------------------------------------
  for (const c of b.correlations) {
    if (!c.reported_event_id || !c.observed_event_id) continue;
    if (c.match !== "matched" && c.match !== "uncertain") continue;
    const basis = basisFromCorrelation(c.match, c.confidence);
    rel("OBSERVED_AS", "Event", c.reported_event_id, "Event", c.observed_event_id, `cor:${c.id}`, {
      basis,
      rule: `correlation.match=${c.match}`,
      confidence: c.confidence,
      correlation_id: c.id,
      match: c.match,
      note: c.note,
    });
    // Tool call -> root process of what it ran: lets ancestry walk from any observed descendant back to the call.
    const rep = eventById.get(c.reported_event_id);
    const obs = eventById.get(c.observed_event_id);
    if (rep && obs && (rep.event_type === "tool_call" || rep.event_type === "tool_result") && obs.event_type === "process_exec" && obs.process_id !== null) {
      // Always "inferred" (ARCHITECTURE: the tool_use_id <-> syscall join is time-correlated inside the single claude
      // process; no kernel record names the tool call), even when the correlation itself is matched/high.
      rel("SPAWNED", "Event", rep.id, "Process", processId(runId, obs.process_id), `tool_spawn:${c.id}`, {
        basis: "inferred",
        correlation_basis: basis,
        rule: "correlation(tool_call<->process_exec), time-correlated",
        confidence: c.confidence,
        correlation_id: c.id,
      });
    }
  }

  // Findings -------------------------------------------------------------------------------------------------
  for (const f of b.findings) {
    const history = b.finding_status_history.filter((h) => h.finding_id === f.id);
    node({
      primary: "Finding",
      extra: null,
      id: f.id,
      shared: false,
      ts: f.created_at,
      props: {
        id: f.id,
        run_id: f.run_id,
        owner_run: runId,
        is_fixture: f.is_fixture,
        category: f.category,
        title: f.title,
        description: f.description,
        severity: f.severity,
        confidence: f.confidence,
        status: f.status,
        policy_version_id: f.policy_id,
        policy_rule_id: f.policy_rule_id,
        recommended_next_step: f.recommended_next_step,
        missing_information: f.missing_information,
        recurrence_of_finding_id: f.recurrence_of_finding_id,
        status_change_count: history.length,
        created_at: f.created_at,
        updated_at: f.updated_at,
      },
    });
    rel("HAS_FINDING", "Run", runId, "Finding", f.id, `has_finding:${f.id}`, { basis: "derived", rule: "finding.run_id" });
    const fBasis = basisFromConfidence(f.confidence);

    for (const eid of f.related_event_ids) {
      const ev = eventById.get(eid);
      rel("SUPPORTED_BY", "Finding", f.id, "Event", eid, `finding_event:${f.id}:${eid}`, {
        basis: fBasis,
        rule: "finding.related_event_ids",
        confidence: f.confidence,
        role: ev ? ev.basis : "unknown",
      });
    }
    for (const evd of f.evidence_ids) {
      rel("SUPPORTED_BY", "Finding", f.id, "Evidence", evd, `finding_evidence:${f.id}:${evd}`, {
        basis: fBasis,
        rule: "finding.evidence_ids",
        confidence: f.confidence,
        role: "evidence",
      });
    }

    const rule = f.policy_rule_id && pv && f.policy_id === pv.id ? pv.rules.find((r) => r.id === f.policy_rule_id) ?? null : null;
    const violates = f.policy_id !== null && (f.category === "permission_violation" || rule?.effect === "deny");
    if (violates && f.policy_id) {
      const why = f.category === "permission_violation" ? "finding.category=permission_violation" : "finding.policy_rule_id->rule.effect=deny";
      rel("VIOLATES", "Finding", f.id, "PolicyVersion", f.policy_id, `violates:${f.id}`, {
        basis: fBasis,
        rule: why,
        confidence: f.confidence,
        policy_rule_id: f.policy_rule_id,
        rule_effect: rule?.effect ?? null,
      });
      for (const eid of f.related_event_ids) {
        if (eventById.get(eid)?.basis !== "observed") continue;
        rel("VIOLATES", "Event", eid, "PolicyVersion", f.policy_id, `violates:${f.id}:${eid}`, {
          basis: fBasis,
          rule: `${why} (observed event cited by finding)`,
          confidence: f.confidence,
          policy_rule_id: f.policy_rule_id,
          finding_id: f.id,
        });
      }
    }

    if (CONTRADICTION_CATEGORIES.has(f.category)) {
      const related = f.related_event_ids.map((id) => eventById.get(id)).filter((x): x is Event => !!x);
      const observed = related.filter((x) => x.basis === "observed");
      const reported = related.filter((x) => x.basis === "reported");
      for (const o of observed) {
        for (const a of reported) {
          rel("CONTRADICTS", "Event", o.id, "Event", a.id, `contradicts:${f.id}:${o.id}:${a.id}`, {
            basis: fBasis,
            rule: `finding.category=${f.category}`,
            confidence: f.confidence,
            finding_id: f.id,
          });
        }
      }
    }

    if (f.recurrence_of_finding_id) {
      rel("RECURRED_AS", "Finding", f.recurrence_of_finding_id, "Finding", f.id, `recurrence:${f.id}`, {
        basis: "derived",
        rule: "finding.recurrence_of_finding_id",
      });
    }
  }

  // Safeguards and verification ------------------------------------------------------------------------------
  for (const s of b.safeguards) {
    node({
      primary: "Safeguard",
      extra: null,
      id: s.id,
      shared: false,
      ts: s.created_at,
      props: {
        id: s.id,
        owner_run: runId,
        is_fixture: s.is_fixture,
        finding_id: s.finding_id,
        type: s.type,
        title: s.title,
        application_mechanism: s.application_mechanism,
        target_path: s.target_path,
        intended_effect: s.intended_effect,
        approval_status: s.approval_status,
        application_status: s.application_status,
        verification_status: s.verification_status,
        last_verification_run_id: s.last_verification_run_id,
        created_at: s.created_at,
        approved_at: s.approved_at,
        applied_at: s.applied_at,
      },
    });
    rel("PROPOSED_AS", "Finding", s.finding_id, "Safeguard", s.id, `proposed_as:${s.id}`, { basis: "derived", rule: "safeguard.finding_id" });
  }
  for (const v of b.verification_runs) {
    const vo = verificationOutcomeProps(v);
    node({
      primary: "VerificationRun",
      extra: null,
      id: v.id,
      shared: false,
      ts: v.started_at,
      props: {
        id: v.id,
        owner_run: runId,
        is_fixture: v.is_fixture,
        safeguard_id: v.safeguard_id,
        finding_id: v.finding_id,
        scenario_id: v.scenario_id,
        scenario_description: v.scenario_description,
        environment_id: v.environment_id,
        executed_run_id: v.run_id,
        status: v.status,
        result: v.result,
        prohibited_behavior_attempted: v.prohibited_behavior_attempted,
        prohibited_behavior_blocked: v.prohibited_behavior_blocked,
        legitimate_behavior_worked: v.legitimate_behavior_worked,
        started_at: v.started_at,
        ended_at: v.ended_at,
        ...vo,
      },
    });
    rel("VERIFIED_BY", "Safeguard", v.safeguard_id, "VerificationRun", v.id, `verified_by:${v.id}`, {
      basis: "derived",
      rule: "verification_run.safeguard_id",
      result: v.result,
      status: v.status,
      security_outcome: vo.security_outcome,
      task_outcome: vo.task_outcome,
    });
    if (v.run_id) {
      rel("EXECUTED_AS", "VerificationRun", v.id, "Run", v.run_id, `executed:${v.id}`, { basis: "derived", rule: "verification_run.run_id" });
    }
    for (const eid of v.observed_event_ids) {
      rel("SUPPORTED_BY", "VerificationRun", v.id, "Event", eid, `verification_event:${v.id}:${eid}`, {
        basis: "derived",
        rule: "verification_run.observed_event_ids",
        role: eventById.get(eid)?.basis ?? "unknown",
      });
    }
    for (const evd of v.evidence_ids) {
      rel("SUPPORTED_BY", "VerificationRun", v.id, "Evidence", evd, `verification_evidence:${v.id}:${evd}`, {
        basis: "derived",
        rule: "verification_run.evidence_ids",
        role: "evidence",
      });
    }
  }

  const byKey = <T extends { key?: string; id?: string; primary?: string; type?: string }>(a: T, c: T) =>
    `${a.primary ?? a.type}|${a.id ?? a.key}`.localeCompare(`${c.primary ?? c.type}|${c.id ?? c.key}`);
  return {
    runId,
    nodes: [...nodes.values()].sort(byKey),
    rels: [...rels.values()].sort(byKey),
    findingIds: b.findings.map((f) => f.id).sort(),
  };
}

/**
 * Issue 4: the two separate outcomes of a verification run, flattened into Neo4j-safe node properties (no nested
 * maps). Recorded outcomes are used when present; otherwise they are derived with outcomesForRun (legacy runs:
 * security "inferred", task always "unknown"). The legacy `result` property is kept unchanged alongside.
 */
export function verificationOutcomeProps(v: VerificationRun): Record<string, string | string[] | null> {
  const o = outcomesForRun(v);
  const flat = (prefix: string, x: { value: string; basis: string | null; source: string | null; recorded_at: string | null; evidence_ids: string[]; reason: string }) => ({
    [prefix]: x.value,
    [`${prefix}_basis`]: x.basis,
    [`${prefix}_source`]: x.source,
    [`${prefix}_recorded_at`]: x.recorded_at,
    [`${prefix}_evidence_ids`]: [...x.evidence_ids],
    [`${prefix}_reason`]: x.reason,
  });
  return {
    ...flat("security_outcome", o.security_outcome),
    ...flat("task_outcome", o.task_outcome),
    reported_task_claim: o.reported_task_claim?.claim ?? null,
    reported_task_claim_source: o.reported_task_claim?.source ?? null,
    reported_task_claim_evidence_ids: [...(o.reported_task_claim?.evidence_ids ?? [])],
    outcome_origin: o.outcome_origin,
  };
}
