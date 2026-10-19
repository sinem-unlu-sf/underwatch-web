/**
 * Graph-backed EvidenceRetriever (default for Ask Witness and safeguard proposals). Neo4j chooses WHICH records are
 * relevant by traversal; SQLite supplies every payload that goes into the bundle (the graph holds no excerpts):
 *  1. process ancestry: for each observed event cited by the finding, the SPAWNED chain back to the agent tool call
 *     (adds the originating tool call and process_exec events of the chain, same run only);
 *  2. finding neighborhood (2 hops): correlated / contradicting / same-resource events of the same run;
 *  3. only when the question asks about other runs: findings in other runs whose events touched the same Resource.
 * When Neo4j is not configured, unreachable, or the query fails, it falls back to the relational retriever and records
 * why in `retrieval.fallback_reason`. Follow-ups use the same finding scope; nothing here accepts Cypher from anyone.
 */
import type { Event, Finding } from "@kw/schema";
import type { ServerContext } from "../context";
import { ancestryForEvents, crossRunMatches } from "../graph/finding-graph";
import { getFinding } from "../repo/findings";
import { getEventsByIds } from "../repo/runs";
import { assembleFindingBundle, questionWantsRelatedRuns, relationalExtras, type ExtraContext } from "./evidence-retriever";
import type { EvidenceBundleResult, EvidenceRetriever, RetrievalInfo } from "./types";

const PRIORITY_TYPES = new Set(["tool_call", "tool_result", "process_exec", "file_open", "file_read", "file_write"]);

interface GraphPick {
  ancestryIds: string[];
  originIds: string[];
  neighborhoodIds: string[];
  related: Array<{ finding: Finding; shared_targets: string[] }>;
}

async function pickFromGraph(ctx: ServerContext, findingId: string, question: string | null): Promise<{ ok: true; value: GraphPick } | { ok: false; reason: string }> {
  const kw = ctx.graph.kw;
  if (!kw) return { ok: false, reason: "Neo4j is not configured in this server process" };
  const finding = getFinding(ctx.db, findingId);
  if (!finding) return { ok: false, reason: "finding not found" };

  const anc = await ancestryForEvents(kw, getEventsByIds(ctx.db, finding.related_event_ids));
  if (!anc.ok) return { ok: false, reason: `Neo4j ${anc.error.kind}` };
  const originIds = [...new Set(anc.value.flatMap((a) => (a.origin_tool_call ? [a.origin_tool_call.event_id] : [])))];
  // Events that performed / exec'd a process of the chain: the observed process_exec records of each hop.
  const chainProcesses = [...new Set(anc.value.flatMap((a) => a.chain.map((h) => h.process_id)))];
  let ancestryIds: string[] = [];
  if (chainProcesses.length > 0) {
    const r = await kw.client.read(
      `UNWIND $pids AS pid MATCH (e:Event)-[:PERFORMED_BY]->(:Process {id: pid})
       WHERE e.event_type = 'process_exec' AND e.run_id = $runId
       RETURN DISTINCT e.id AS id ORDER BY id LIMIT 20`,
      { pids: chainProcesses, runId: finding.run_id },
      (rec) => String(rec.get("id")),
    );
    if (!r.ok) return { ok: false, reason: `Neo4j ${r.error.kind}` };
    ancestryIds = r.value;
  }

  const hood = await kw.findingNeighborhood(findingId, 2, { maxPaths: 2000 });
  if (!hood.ok) return { ok: false, reason: `Neo4j ${hood.error.kind}` };
  if (!hood.value.found) return { ok: false, reason: "finding is not in the graph projection yet" };
  const neighborhoodIds = hood.value.nodes
    .filter((n) => n.labels.includes("Event") && n.props.run_id === finding.run_id)
    .sort((a, b) => Number(PRIORITY_TYPES.has(String(b.props.event_type))) - Number(PRIORITY_TYPES.has(String(a.props.event_type))) || a.id.localeCompare(b.id))
    .map((n) => n.id);

  let related: GraphPick["related"] = [];
  if (questionWantsRelatedRuns(question)) {
    const cross = await crossRunMatches(kw, findingId, 20);
    if (!cross.ok) return { ok: false, reason: `Neo4j ${cross.error.kind}` };
    const byFinding = new Map<string, Set<string>>();
    for (const m of cross.value) byFinding.set(m.finding_id, (byFinding.get(m.finding_id) ?? new Set()).add(m.resource_key));
    related = [...byFinding.entries()].flatMap(([id, keys]) => {
      const f = getFinding(ctx.db, id);
      return f ? [{ finding: f, shared_targets: [...keys].slice(0, 5) }] : [];
    });
  }
  return { ok: true, value: { ancestryIds, originIds, neighborhoodIds, related } };
}

export function createGraphEvidenceRetriever(ctx: ServerContext): EvidenceRetriever {
  return {
    id: "graph",
    async forFinding(findingId: string, question: string | null = null): Promise<EvidenceBundleResult> {
      let picked: Awaited<ReturnType<typeof pickFromGraph>>;
      try {
        picked = await pickFromGraph(ctx, findingId, question);
      } catch (err) {
        picked = { ok: false, reason: `graph retrieval error: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}` };
      }
      if (!picked.ok) {
        const retrieval: RetrievalInfo = { retriever: "relational", fallback_reason: picked.reason, graph: null };
        return assembleFindingBundle(ctx, findingId, relationalExtras(ctx, question, retrieval));
      }
      const g = picked.value;
      const retrieval: RetrievalInfo = {
        retriever: "graph",
        fallback_reason: null,
        graph: { neighborhood_event_ids: g.neighborhoodIds, ancestry_event_ids: g.ancestryIds, origin_tool_call_ids: g.originIds, related_finding_ids: g.related.map((r) => r.finding.id) },
      };
      return assembleFindingBundle(ctx, findingId, (detail, targets): ExtraContext => {
        // Priority: originating tool call(s), ancestry process_execs, then the relational "observed on targets" set
        // (kept so graph retrieval is never narrower than relational), then the rest of the neighborhood.
        const relational = relationalExtras(ctx, null, retrieval)(detail, targets).extraEvents.map((e) => e.id);
        const order = [...new Set([...g.originIds, ...g.ancestryIds, ...relational, ...g.neighborhoodIds])];
        const byId = new Map(getEventsByIds(ctx.db, order).map((e) => [e.id, e]));
        const extraEvents = order.flatMap((id) => byId.get(id) ?? []).filter((e: Event) => e.run_id === detail.run.id);
        return { extraEvents, relatedFindings: g.related, retrieval };
      });
    },
  };
}
