import type { ServerContext } from "../context";
import { requireFinding } from "../repo/findings";
import type { GraphService } from "../services/types";
import { findingGraphFromDb, findingGraphFromNeo4j, unavailableDetail } from "./finding-graph";
import { buildKeyRelationships } from "./key-relationships";

/**
 * Finding neighborhood from the Neo4j projection; falls back to the relational store (and says so in `detail`) when
 * Neo4j is not configured, unreachable, or has not projected the finding yet (a re-projection is then scheduled).
 */
export function createGraphService(ctx: ServerContext): GraphService {
  async function base(findingId: string) {
    requireFinding(ctx.db, findingId);
    const kw = ctx.graph.kw;
    if (!kw) {
      return findingGraphFromDb(ctx.db, findingId, "Neo4j is not configured in this server process; built from the relational store. Process ancestry and cross-run traversal need Neo4j.");
    }
    const r = await findingGraphFromNeo4j(kw, ctx.db, findingId);
    if (r.ok) return r.value;
    if (r.error.kind === "query_failed" && r.error.retryable) ctx.graph.scheduleFinding(findingId, "finding missing from graph");
    return findingGraphFromDb(ctx.db, findingId, unavailableDetail(r.error));
  }
  /** Addendum C: key relationships are computed from the SAME response (additive field; existing fields unchanged). */
  async function withSummary(findingId: string) {
    const g = await base(findingId);
    return { ...g, key_relationships: buildKeyRelationships(ctx.db, requireFinding(ctx.db, findingId), g) };
  }
  return {
    findingGraph: withSummary,
    async findingGraphSummary(findingId) {
      return (await withSummary(findingId)).key_relationships;
    },
  };
}
