/**
 * Finding neighborhood for GET /api/findings/:id/graph plus the graph-only multi-hop queries (process ancestry, same
 * resource across runs) shared with the graph EvidenceRetriever. Neo4j first; when it is unavailable the relational
 * store builds an equivalent (shallower) graph and the response says so (source = "relational", insights = null).
 * The backend chooses every query; nothing here accepts Cypher or labels from callers.
 */
import { isGraphUnavailable, normalizeResource, resourceKindForEventType, verificationOutcomeProps, type GraphError, type GraphResult, type KwGraph } from "@kw/graph";
import type {
  Event,
  FindingGraphResponse,
  GraphAncestry,
  GraphBasis,
  GraphCrossRunMatch,
  GraphEdge,
  GraphInsights,
  GraphNode,
  GraphNodeLabel,
} from "@kw/schema";
import { GraphNodeLabel as GraphNodeLabelEnum } from "@kw/schema";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import { getEvidenceByIds } from "../repo/evidence";
import { requireFinding } from "../repo/findings";
import { getEventsByIds, getRun } from "../repo/runs";
import { planAddendum } from "./addendum";
import { getRunRow as getVerificationRunRow } from "../verification/repo";

const MAX_NODES = 200;
const MAX_STRING = 400;
const LABELS = new Set<string>(GraphNodeLabelEnum.options);
const BASES = new Set<string>(["reported", "observed", "derived", "inferred", "ai", "user"]);

type PropMap = GraphNode["props"];

function cleanProps(p: Record<string, unknown>): PropMap {
  const out: PropMap = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "ts" || k === "owner_run" || k === "key") continue;
    if (v === null || v === undefined) out[k] = null;
    else if (typeof v === "string") out[k] = v.length > MAX_STRING ? `${v.slice(0, MAX_STRING - 1)}…` : v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.map(String).join(", ").slice(0, MAX_STRING);
    else out[k] = String(v).slice(0, MAX_STRING);
  }
  return out;
}

const s = (p: PropMap, k: string): string | null => (typeof p[k] === "string" && p[k] !== "" ? (p[k] as string) : null);

/** Schema label for a set of Neo4j labels (AgentEvent nodes are shown as AgentAction, the addendum's name). */
export function labelFor(labels: readonly string[]): GraphNodeLabel | null {
  if (labels.includes("AgentEvent") || labels.includes("AgentAction")) return "AgentAction";
  for (const l of ["ObservedEvent", "DerivedEvent", "Investigation", "SafeguardVersion", "VerificationRun", "Safeguard", "Finding", "Evidence", "Process", "Resource", "PolicyVersion", "Policy", "Task", "Run"]) {
    if (labels.includes(l) && LABELS.has(l)) return l as GraphNodeLabel;
  }
  return null;
}

function nodeBasis(label: GraphNodeLabel, p: PropMap): GraphBasis | null {
  switch (label) {
    case "AgentAction":
      return "reported";
    case "ObservedEvent":
      return "observed";
    case "DerivedEvent":
      return "derived";
    case "Finding":
      return p.confidence === "high" ? "derived" : "inferred";
    case "Investigation":
      return "ai";
    case "SafeguardVersion":
      return p.author === "ai" ? "ai" : p.author === "user" ? "user" : "derived";
    case "Run":
    case "Task":
    case "Policy":
    case "PolicyVersion":
    case "Safeguard":
    case "VerificationRun":
      return "derived";
    default:
      return null;
  }
}

function titleFor(label: GraphNodeLabel, p: PropMap, id: string): string {
  switch (label) {
    case "Finding":
    case "Safeguard":
      return s(p, "title") ?? id;
    case "Process":
      return `${s(p, "name") ?? "process"} (pid ${p.pid ?? "?"})`;
    case "Resource":
      return s(p, "key") ?? s(p, "display") ?? id;
    case "PolicyVersion":
      return `${s(p, "name") ?? s(p, "policy_id") ?? "policy"} v${s(p, "version") ?? "?"}`;
    case "Run":
      return s(p, "label") ?? id;
    case "Task":
      return (s(p, "description") ?? "task").slice(0, 80);
    case "VerificationRun":
      return s(p, "security_outcome") && s(p, "task_outcome")
        ? `Verification ${s(p, "verification_status") ?? ""}: security ${s(p, "security_outcome")} · task ${s(p, "task_outcome")}`
        : `Verification ${s(p, "verification_status") ?? s(p, "result") ?? s(p, "status") ?? ""}`.trim();
    case "Evidence":
      return `${s(p, "source_type") ?? "evidence"}: ${s(p, "source_reference") ?? id}`;
    case "Investigation":
      return `Ask Witness (${p.turn_count ?? 0} turn${p.turn_count === 1 ? "" : "s"})`;
    case "SafeguardVersion":
      return `v${p.version ?? "?"} (${s(p, "author") ?? "?"})`;
    default:
      return s(p, "summary") ?? `${s(p, "event_type") ?? "event"} ${s(p, "outcome") ?? ""}`.trim();
  }
}

function toNode(labels: readonly string[], raw: Record<string, unknown>): GraphNode | null {
  const label = labelFor(labels);
  if (!label) return null;
  const props = cleanProps(raw);
  const id = String(raw.id);
  return { id, label, title: titleFor(label, props, id), basis: nodeBasis(label, props), is_fixture: props.is_fixture === true, props };
}

function toEdge(type: string, from: string, to: string, raw: Record<string, unknown>): GraphEdge {
  const basis = typeof raw.basis === "string" && BASES.has(raw.basis) ? (raw.basis as GraphBasis) : null;
  return { id: `${type}:${String(raw.key ?? `${from}->${to}`)}`, from, to, type, basis };
}

// ---------------------------------------------------------------------------------------------------------------
// Multi-hop queries
// ---------------------------------------------------------------------------------------------------------------

/** For each observed event cited by the finding: SPAWNED chain back to the agent tool call that started it. */
export async function ancestryForEvents(kw: KwGraph, events: readonly Event[]): Promise<GraphResult<GraphAncestry[]>> {
  const out: GraphAncestry[] = [];
  for (const e of events.filter((x) => x.basis === "observed" && x.process_id !== null).slice(0, 6)) {
    const r = await kw.processAncestry(e.id);
    if (!r.ok) return r;
    if (!r.value.found) continue;
    const a = r.value;
    out.push({
      event_id: e.id,
      event_summary: e.summary.slice(0, 200),
      chain: a.chain.map((h) => ({ process_id: h.process.id, pid: h.process.pid ?? null, name: h.process.name, spawned_basis: (h.spawned_by?.basis as GraphBasis | undefined) ?? null })),
      origin_tool_call: a.origin_tool_call
        ? {
            event_id: a.origin_tool_call.agent_event.id,
            summary: a.origin_tool_call.agent_event.summary.slice(0, 200),
            tool_name: a.origin_tool_call.agent_event.tool_name,
            relation_basis: a.origin_tool_call.relation.basis as GraphBasis,
            hops_to_event_process: a.origin_tool_call.hops_to_event_process,
          }
        : null,
      unresolved_reason: a.unresolved_reason,
    });
  }
  return { ok: true, value: out };
}

/** Findings in OTHER runs whose cited events touched a Resource that this finding's events touched (5-hop pattern). */
export async function crossRunMatches(kw: KwGraph, findingId: string, limit = 10): Promise<GraphResult<GraphCrossRunMatch[]>> {
  const n = Math.max(1, Math.min(50, Math.trunc(limit)));
  return kw.client.read(
    `MATCH (f:Finding {id: $id})-[:SUPPORTED_BY]->(:Event)-[:TARGETS|REPORTS]->(res:Resource)
     MATCH (res)<-[:TARGETS|REPORTS]-(e2:Event)<-[:SUPPORTED_BY]-(f2:Finding)
     WHERE f2.run_id <> f.run_id AND res.kind IN ['file', 'host'] // executables (e.g. /bin/bash) are not shared targets
     OPTIONAL MATCH (:Run {id: f.run_id})-[:UNDER_POLICY]->(pv1:PolicyVersion)
     OPTIONAL MATCH (:Run {id: f2.run_id})-[:UNDER_POLICY]->(pv2:PolicyVersion)
     WITH f, res, f2, pv1, pv2, collect(DISTINCT e2.id) AS eids, collect(DISTINCT e2.basis) AS bases
     RETURN res.id AS rid, res.key AS rkey, f2{.id, .title, .status, .run_id, .is_fixture} AS f2, eids, bases,
            pv1.id AS pv1, pv2.id AS pv2, EXISTS { MATCH (f)-[:RECURRED_AS*1..5]-(f2) } AS linked
     ORDER BY rkey, f2.run_id, f2.id
     LIMIT ${n}`,
    { id: findingId },
    (rec) => {
      const f2 = rec.get("f2") as Record<string, unknown>;
      return {
        resource_id: String(rec.get("rid")),
        resource_key: String(rec.get("rkey")),
        finding_id: String(f2.id),
        finding_title: String(f2.title ?? f2.id),
        finding_status: String(f2.status ?? "unknown"),
        run_id: String(f2.run_id),
        event_ids: (rec.get("eids") as string[]).sort(),
        event_bases: (rec.get("bases") as string[]).sort(),
        policy_version_id: (rec.get("pv2") as string | null) ?? null,
        this_policy_version_id: (rec.get("pv1") as string | null) ?? null,
        linked_by_recurrence: rec.get("linked") as boolean,
        is_fixture: f2.is_fixture === true,
      };
    },
  );
}

/** Investigation / Safeguard / SafeguardVersion / VerificationRun nodes attached to the finding (addendum edges). */
async function addendumSubgraph(kw: KwGraph, findingId: string): Promise<GraphResult<{ nodes: GraphNode[]; edges: GraphEdge[] }>> {
  const r = await kw.client.read(
    `MATCH (f:Finding {id: $id})
     CALL (f) {
       MATCH p = (f)<-[:INVESTIGATES]-(:Investigation) RETURN p
       UNION MATCH p = (f)<-[:INVESTIGATES]-(:Investigation)-[:USES_EVIDENCE]->() RETURN p
       UNION MATCH p = (f)<-[:ADDRESSES]-(:Safeguard)-[:HAS_VERSION]->(:SafeguardVersion) RETURN p
       UNION MATCH p = (f)<-[:ADDRESSES]-(:Safeguard)-[:CURRENT_VERSION]->(:SafeguardVersion) RETURN p
       UNION MATCH p = (f)<-[:ADDRESSES]-(:Safeguard)-[:HAS_VERSION]->(:SafeguardVersion)-[:PREVIOUS_VERSION|FROM_INVESTIGATION]->() RETURN p
       UNION MATCH p = (f)<-[:ADDRESSES]-(:Safeguard)<-[:TESTS]-(:VerificationRun) RETURN p
       UNION MATCH p = (f)<-[:ADDRESSES]-(:Safeguard)<-[:TESTS]-(:VerificationRun)-[:TESTS_VERSION]->() RETURN p
     }
     WITH collect(p) AS ps
     RETURN [n IN reduce(a = [], p IN ps | a + nodes(p)) | {labels: labels(n), props: properties(n)}] AS nodes,
            [r IN reduce(a = [], p IN ps | a + relationships(p)) | {type: type(r), source: startNode(r).id, target: endNode(r).id, props: properties(r)}] AS rels`,
    { id: findingId },
    (rec) => ({
      nodes: rec.get("nodes") as { labels: string[]; props: Record<string, unknown> }[],
      rels: rec.get("rels") as { type: string; source: string; target: string; props: Record<string, unknown> }[],
    }),
  );
  if (!r.ok) return r;
  const row = r.value[0] ?? { nodes: [], rels: [] };
  return {
    ok: true,
    value: {
      nodes: row.nodes.flatMap((n) => toNode(n.labels, n.props) ?? []),
      edges: row.rels.map((e) => toEdge(e.type, e.source, e.target, e.props)),
    },
  };
}

function dedupe(nodes: GraphNode[], edges: GraphEdge[]): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
  const n = new Map<string, GraphNode>();
  for (const x of nodes) if (!n.has(x.id)) n.set(x.id, x);
  let truncated = false;
  let kept = [...n.values()];
  if (kept.length > MAX_NODES) {
    truncated = true;
    kept = kept.slice(0, MAX_NODES);
  }
  const ids = new Set(kept.map((x) => x.id));
  const e = new Map<string, GraphEdge>();
  for (const x of edges) if (ids.has(x.from) && ids.has(x.to) && !e.has(x.id)) e.set(x.id, x);
  return { nodes: kept.sort((a, b) => a.id.localeCompare(b.id)), edges: [...e.values()].sort((a, b) => a.id.localeCompare(b.id)), truncated };
}

export type Neo4jGraphOutcome = { ok: true; value: FindingGraphResponse } | { ok: false; error: GraphError };

export async function findingGraphFromNeo4j(kw: KwGraph, db: Db, findingId: string): Promise<Neo4jGraphOutcome> {
  const hood = await kw.findingNeighborhood(findingId, 2, { maxPaths: 3000 });
  if (!hood.ok) return hood;
  if (!hood.value.found) {
    return { ok: false, error: { kind: "query_failed", message: "finding is not in the graph projection yet", code: null, retryable: true } };
  }
  const add = await addendumSubgraph(kw, findingId);
  if (!add.ok) return add;
  const finding = requireFinding(db, findingId);
  const ancestry = await ancestryForEvents(kw, getEventsByIds(db, finding.related_event_ids));
  if (!ancestry.ok) return ancestry;
  const cross = await crossRunMatches(kw, findingId);
  if (!cross.ok) return cross;
  const nodes = hood.value.nodes.flatMap((n) => toNode(n.labels, n.props) ?? []);
  const edges = hood.value.edges.map((e) => toEdge(e.type, e.source, e.target, e.props));
  const d = dedupe([...nodes, ...add.value.nodes], [...edges, ...add.value.edges]);
  const insights: GraphInsights = { ancestry: ancestry.value, cross_run: cross.value };
  return {
    ok: true,
    value: {
      finding_id: findingId,
      source: "neo4j",
      detail: `Neo4j projection: ${d.nodes.length} node(s), ${d.edges.length} relationship(s) within 2 hops of the finding, plus Ask Witness / safeguard records.`,
      nodes: d.nodes,
      edges: d.edges,
      truncated: d.truncated || hood.value.truncated,
      insights,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Relational fallback (same ids and labels; no process ancestry / cross-run traversal)
// ---------------------------------------------------------------------------------------------------------------

const EVENT_LABEL: Record<Event["basis"], GraphNodeLabel> = { reported: "AgentAction", observed: "ObservedEvent", derived: "DerivedEvent" };

export function findingGraphFromDb(db: Db, findingId: string, why: string): FindingGraphResponse {
  const finding = requireFinding(db, findingId);
  const run = getRun(db, finding.run_id);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const add = (label: GraphNodeLabel, id: string, raw: Record<string, unknown>) => {
    const n = toNode([label === "AgentAction" ? "AgentEvent" : label], { ...raw, id });
    if (n) nodes.push(n);
  };
  const link = (type: string, from: string, to: string, basis: GraphBasis | null) => edges.push({ id: `${type}:${from}->${to}`, from, to, type, basis });

  add("Finding", finding.id, finding as unknown as Record<string, unknown>);
  if (run) {
    add("Run", run.id, run as unknown as Record<string, unknown>);
    link("HAS_FINDING", run.id, finding.id, "derived");
    if (run.policy_version) {
      const pv = stmt(db, "SELECT id, policy_id, version, name, is_fixture FROM policy_versions WHERE id = ?").get(run.policy_version);
      if (pv) {
        add("PolicyVersion", pv.id as string, { ...pv, is_fixture: pv.is_fixture === 1 });
        link("UNDER_POLICY", run.id, pv.id as string, "derived");
      }
    }
  }
  const fBasis: GraphBasis = finding.confidence === "high" ? "derived" : "inferred";
  const events = getEventsByIds(db, finding.related_event_ids);
  for (const e of events) {
    add(EVENT_LABEL[e.basis], e.id, e as unknown as Record<string, unknown>);
    link("SUPPORTED_BY", finding.id, e.id, fBasis);
    if (e.target_resource && e.target_resource.trim() !== "") {
      const r = normalizeResource(e.target_resource, resourceKindForEventType(e.event_type));
      add("Resource", r.id, { kind: r.kind, key: r.key });
      link(e.basis === "reported" ? "REPORTS" : "TARGETS", e.id, r.id, e.basis);
    }
  }
  const evIds = [...new Set([...finding.evidence_ids, ...events.flatMap((e) => (e.evidence_id ? [e.evidence_id] : []))])];
  for (const ev of getEvidenceByIds(db, evIds)) {
    const { excerpt: _omit, ...rest } = ev as unknown as Record<string, unknown> & { excerpt?: unknown };
    add("Evidence", ev.id, rest);
  }
  for (const e of events) if (e.evidence_id && evIds.includes(e.evidence_id)) link("SUPPORTED_BY", e.id, e.evidence_id, e.basis);
  for (const id of finding.evidence_ids) link("SUPPORTED_BY", finding.id, id, fBasis);

  const plan = planAddendum(db, finding.run_id);
  for (const sg of plan.safeguards.filter((x) => x.finding_id === finding.id)) {
    const row = stmt(db, "SELECT id, title, type, approval_status, application_status, verification_status, is_fixture FROM safeguards WHERE id = ?").get(sg.id);
    add("Safeguard", sg.id, { ...(row ?? {}), ...sg.props, is_fixture: row?.is_fixture === 1 });
    link("ADDRESSES", sg.id, finding.id, "derived");
    for (const v of plan.versions.filter((x) => x.safeguard_id === sg.id)) {
      add("SafeguardVersion", v.id, v.props);
      link("HAS_VERSION", sg.id, v.id, "derived");
      if (v.prev) link("PREVIOUS_VERSION", v.id, v.prev, "derived");
    }
    for (const vr of plan.verifications.filter((x) => x.safeguard_id === sg.id)) {
      const row2 = stmt(db, "SELECT id, scenario_id, status, result, is_fixture FROM verification_runs WHERE id = ?").get(vr.id);
      // Issue 4: security_outcome and task_outcome as separate props (with basis/evidence), never one merged verdict.
      const full = getVerificationRunRow(db, vr.id);
      add("VerificationRun", vr.id, { ...(row2 ?? {}), ...(full ? verificationOutcomeProps(full) : {}), verification_status: vr.verification_status, is_fixture: row2?.is_fixture === 1 });
      link("TESTS", vr.id, sg.id, "derived");
      if (vr.version_id) link("TESTS_VERSION", vr.id, vr.version_id, "derived");
    }
  }
  for (const inv of plan.investigations.filter((x) => x.finding_id === finding.id)) {
    add("Investigation", inv.id, inv.props);
    link("INVESTIGATES", inv.id, finding.id, "derived");
    for (const c of inv.cited) link("USES_EVIDENCE", inv.id, c, "ai");
  }
  const d = dedupe(nodes, edges);
  return { finding_id: findingId, source: "relational", detail: why, nodes: d.nodes, edges: d.edges, truncated: d.truncated, insights: null };
}

export function unavailableDetail(e: GraphError): string {
  return isGraphUnavailable(e)
    ? `Neo4j unavailable (${e.kind}); built from the relational store. Process ancestry and cross-run traversal need Neo4j.`
    : `Neo4j query failed (${e.kind}: ${e.message.slice(0, 160)}); built from the relational store.`;
}
