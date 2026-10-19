/**
 * Finding neighborhood for the evidence graph view (GET /api/findings/:id/graph). Served from Neo4j when the graph
 * projection is available, otherwise built from the relational store (source tells which). Every node and edge keeps
 * its basis so reported, observed, derived (KW analysis), ai (Ask Witness / proposals) and user records stay distinct.
 */
import { z } from "zod";

/** inferred: heuristic / below-high-confidence links (uncertain correlations, low-confidence process attribution). */
export const GraphBasis = z.enum(["reported", "observed", "derived", "inferred", "ai", "user"]);
export type GraphBasis = z.infer<typeof GraphBasis>;

export const GraphNodeLabel = z.enum([
  "Run",
  "AgentAction",
  "ObservedEvent",
  "DerivedEvent",
  "Process",
  "Task",
  "Resource",
  "Policy",
  "PolicyVersion",
  "Finding",
  "Evidence",
  "Safeguard",
  "SafeguardVersion",
  "VerificationRun",
  "Investigation",
]);
export type GraphNodeLabel = z.infer<typeof GraphNodeLabel>;

export const GraphNode = z.object({
  /** The record id (evt_/fnd_/sg_/inv_...) or a resource key ("res:file:/workspace/.env"). */
  id: z.string().min(1),
  label: GraphNodeLabel,
  title: z.string(),
  basis: GraphBasis.nullable(),
  is_fixture: z.boolean(),
  /** Free-form display properties (redacted, no file contents). */
  props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  /** Relationship type, e.g. INVESTIGATES, USES_EVIDENCE, ADDRESSES, TESTS, TARGETS, CORRELATES_WITH, HAS_EVIDENCE. */
  type: z.string().min(1),
  basis: GraphBasis.nullable(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

/**
 * Multi-hop answers computed by graph traversal (Neo4j only; null when the response came from the relational fallback).
 * ancestry: for each observed event cited by the finding, the SPAWNED chain of processes back to the agent tool call
 * correlated with the root process_exec. cross_run: findings in OTHER runs whose events touched the same Resource.
 */
export const GraphAncestryHop = z.object({
  process_id: z.string(),
  pid: z.number().int().nullable(),
  name: z.string().nullable(),
  /** Basis of the SPAWNED edge from the previous hop (null for the root). */
  spawned_basis: GraphBasis.nullable(),
});
export const GraphAncestry = z.object({
  event_id: z.string(),
  event_summary: z.string(),
  chain: z.array(GraphAncestryHop),
  origin_tool_call: z
    .object({ event_id: z.string(), summary: z.string(), tool_name: z.string().nullable(), relation_basis: GraphBasis.nullable(), hops_to_event_process: z.number().int() })
    .nullable(),
  unresolved_reason: z.string().nullable(),
});
export type GraphAncestry = z.infer<typeof GraphAncestry>;
export const GraphCrossRunMatch = z.object({
  resource_id: z.string(),
  resource_key: z.string(),
  finding_id: z.string(),
  finding_title: z.string(),
  finding_status: z.string(),
  run_id: z.string(),
  /** Events of the other finding that touched the resource, with their basis. */
  event_ids: z.array(z.string()),
  event_bases: z.array(z.string()),
  policy_version_id: z.string().nullable(),
  this_policy_version_id: z.string().nullable(),
  linked_by_recurrence: z.boolean(),
  is_fixture: z.boolean(),
});
export type GraphCrossRunMatch = z.infer<typeof GraphCrossRunMatch>;
export const GraphInsights = z.object({ ancestry: z.array(GraphAncestry), cross_run: z.array(GraphCrossRunMatch) });
export type GraphInsights = z.infer<typeof GraphInsights>;

/**
 * Key relationships (Addendum C section 5): the 3-6 most important relationship paths for a finding, in plain
 * language, built ONLY from the graph response (Neo4j query results, or the relational fallback) plus the Kernel
 * Witness records those nodes stand for (policy rule text, stored verification outcomes). Never a new source of truth:
 * every step names a node id that the query returned, every hop keeps its edge basis, and inferred links say so.
 * A relationship supports investigation; it is not proof of an event without the cited evidence.
 */
export const KeyRelationshipKind = z.enum([
  "contradiction",
  "origin_chain",
  "policy",
  "verification",
  "safeguard",
  "cross_run",
  "recurrence",
  "supporting_evidence",
  "investigation",
]);
export type KeyRelationshipKind = z.infer<typeof KeyRelationshipKind>;
export const KeyRelationshipStep = z.object({
  node_id: z.string().min(1),
  label: GraphNodeLabel,
  title: z.string(),
  /** Relationship type that leads INTO this step from the previous one (null for the first step). */
  via: z.string().nullable(),
  via_basis: GraphBasis.nullable(),
  /** True when the node is in this response's `nodes` (it may come from a multi-hop insight query instead). */
  in_graph: z.boolean(),
});
export type KeyRelationshipStep = z.infer<typeof KeyRelationshipStep>;
export const KeyRelationshipLink = z.object({
  kind: z.enum(["finding", "run", "run_event", "evidence", "safeguard", "verification"]),
  id: z.string().min(1),
  /** Web route; null when the record has no page of its own (evidence opens in the evidence inspector). */
  href: z.string().nullable(),
  label: z.string(),
});
export type KeyRelationshipLink = z.infer<typeof KeyRelationshipLink>;
export const KeyRelationship = z.object({
  id: z.string().min(1),
  kind: KeyRelationshipKind,
  /** One plain-language sentence. */
  text: z.string(),
  /** Weakest basis along the path (inferred < reported < ai < user < derived < observed). */
  basis: GraphBasis,
  /** Why that basis, and what it does NOT establish. */
  basis_note: z.string(),
  /** neo4j: from Neo4j query results; kw_records: from Underwatch records (relational store). */
  source: z.enum(["neo4j", "kw_records"]),
  steps: z.array(KeyRelationshipStep),
  links: z.array(KeyRelationshipLink),
});
export type KeyRelationship = z.infer<typeof KeyRelationship>;
export const KeyRelationshipsSummary = z.object({
  finding_id: z.string(),
  source: z.enum(["neo4j", "relational"]),
  /** Where the relationships came from, e.g. "From Underwatch records, Neo4j unavailable (...)". */
  detail: z.string(),
  items: z.array(KeyRelationship).max(6),
  /** Candidate relationships found but not shown (the full graph still has them). */
  omitted: z.number().int().nonnegative(),
  /** Relationship kinds that could not be computed from this source (e.g. process ancestry without Neo4j). */
  unavailable: z.array(z.string()),
  /** Standing caveat: relationships are leads for investigation, not proof. */
  note: z.string(),
});
export type KeyRelationshipsSummary = z.infer<typeof KeyRelationshipsSummary>;

export const FindingGraphResponse = z.object({
  finding_id: z.string(),
  source: z.enum(["neo4j", "relational"]),
  /** Why neo4j was not used, when source = relational. */
  detail: z.string(),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
  truncated: z.boolean(),
  /** Graph-only multi-hop query results (null when source = relational). */
  insights: GraphInsights.nullable(),
  /** Additive (Addendum C): plain-language summary of the most important relationships in this same response. */
  key_relationships: KeyRelationshipsSummary.optional(),
});
export type FindingGraphResponse = z.infer<typeof FindingGraphResponse>;

/** GET /api/findings/:id/graph/summary: the key relationships alone (same data as FindingGraphResponse.key_relationships). */
export const FindingGraphSummaryResponse = KeyRelationshipsSummary;
export type FindingGraphSummaryResponse = KeyRelationshipsSummary;
