/**
 * Neo4j wiring: graph EvidenceRetriever fallback when Neo4j is down, GET /api/findings/:id/graph from the relational
 * store without Neo4j, and (when the dev kw-neo4j is reachable) idempotent re-projection of a run including the Ask
 * Witness addendum nodes. Live tests use a test-only run id (buildFixtureFile slug) and delete it afterwards.
 */
import path from "node:path";
import { KwGraph } from "@kw/graph";
import type { FindingGraphResponse } from "@kw/schema";
import { afterAll, describe, expect, it } from "vitest";
import { importFixture } from "../ingest/fixtures";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";
import { buildFixtureFile } from "./bundle";
import { createTestApp, getJson, type TestContext } from "./helpers";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

function deadGraph(): KwGraph {
  return new KwGraph({
    config: { uri: "bolt://127.0.0.1:1", user: "neo4j", password: "dead-graph-test-password", database: "neo4j", configuredVia: "test" },
    connectionTimeoutMs: 300,
    maxRetryTimeMs: 100,
  });
}

function seed(ctx: TestContext, slug: string): { runId: string; findingId: string; eventIds: string[] } {
  const imp = importFixture(ctx.db, buildFixtureFile(slug));
  if (!imp.ok) throw new Error(`fixture import failed: ${JSON.stringify(imp).slice(0, 300)}`);
  const f = stmt(ctx.db, "SELECT id, run_id FROM findings WHERE run_id = ? ORDER BY id LIMIT 1").get(imp.run_id)!;
  const eventIds = stmt(ctx.db, "SELECT event_id FROM finding_events WHERE finding_id = ? ORDER BY event_id").all(f.id as string).map((r) => r.event_id as string);
  return { runId: imp.run_id, findingId: f.id as string, eventIds };
}

/** An Ask Witness turn whose (app-validated) answer cites one event, inserted the way the investigation store does. */
function addInvestigation(db: Db, runId: string, findingId: string, citedEventId: string, suffix: string): string {
  const id = `inv_graphtest_${suffix}`;
  const at = "2026-10-17T00:00:00.000Z";
  stmt(db, "INSERT INTO investigations (id, finding_id, run_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)").run(id, findingId, runId, at, at);
  const claim = { text: "The file was opened.", evidence_ids: [citedEventId], invalid_evidence_ids: [], support: "observed_evidence", cited_bases: ["observed"] };
  const answer = {
    summary: "Opened .env; token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA should never reach the graph",
    verified_facts: [claim],
    hypotheses: [],
    unknowns: [],
    evidence_references: [citedEventId, "evt_not_in_bundle_is_never_here"].slice(0, 1),
    recommended_next_steps: [],
    recommended_safeguards: [],
    unsupported_claims: [],
    evidence_check: { cited: 1, valid: 1, invalid: 0, invalid_ids: [] },
    insufficient_evidence: false,
    advisory: true,
  };
  stmt(
    db,
    `INSERT INTO investigation_turns (id, investigation_id, client_request_id, request_fingerprint, question, evidence_ids, bundle_hash, model, prompt_version, status, answer, error, evidence_index, created_at)
     VALUES (?, ?, ?, 'fp', 'What happened?', ?, NULL, 'test-model', 'test', 'answered', ?, NULL, '[]', ?)`,
  ).run(`itn_graphtest_${suffix}`, id, `cr-graphtest-${suffix}`, JSON.stringify([citedEventId]), JSON.stringify(answer), at);
  return id;
}

describe("graph wiring without Neo4j", () => {
  it("serves the finding graph from the relational store when no graph client is configured", async () => {
    const ctx = await createTestApp();
    try {
      const { findingId, runId, eventIds } = seed(ctx, "fx-graph-nocfg");
      addInvestigation(ctx.db, runId, findingId, eventIds[0]!, "nocfg");
      const res = await getJson<FindingGraphResponse>(ctx.app, `/api/findings/${findingId}/graph`);
      expect(res.status).toBe(200);
      expect(res.body.source).toBe("relational");
      expect(res.body.insights).toBeNull();
      expect(res.body.detail).toMatch(/not configured/);
      const labels = new Set(res.body.nodes.map((n) => n.label));
      expect(labels.has("Finding")).toBe(true);
      expect(labels.has("Investigation")).toBe(true);
      expect(res.body.edges.some((e) => e.type === "USES_EVIDENCE" && e.to === eventIds[0] && e.basis === "ai")).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain("sk-ant-api03");
      expect((await getJson(ctx.app, "/api/findings/fnd_does_not_exist/graph")).status).toBe(404);
    } finally {
      await ctx.close();
    }
  });

  it("falls back to relational retrieval (and says why) when Neo4j is unreachable", async () => {
    const ctx = await createTestApp({}, { graph: deadGraph() });
    try {
      const { findingId } = seed(ctx, "fx-graph-dead");
      const ev = await ctx.app.kw.services.evidence.forFinding(findingId, "What happened in other runs?");
      expect(ctx.app.kw.services.evidence.id).toBe("graph");
      expect(ev.retrieval.retriever).toBe("relational");
      expect(ev.retrieval.fallback_reason).toMatch(/graph_unavailable/);
      expect(ev.bundle.allowed_ids).toContain(findingId);
      expect(JSON.stringify(ev.retrieval)).not.toContain("dead-graph-test-password");

      const g = await getJson<FindingGraphResponse>(ctx.app, `/api/findings/${findingId}/graph`);
      expect(g.status).toBe(200);
      expect(g.body.source).toBe("relational");
      expect(g.body.detail).toMatch(/Neo4j unavailable/);

      const s = await getJson(ctx.app, "/api/settings/status");
      expect(s.body.neo4j.status).toBe("error");
      expect(JSON.stringify(s.body)).not.toContain("dead-graph-test-password");
    } finally {
      await ctx.close();
    }
  });
});

const probe = new KwGraph({ cwd: REPO_ROOT, connectionTimeoutMs: 1500, maxRetryTimeMs: 500 });
const LIVE = (await probe.health()).ok;
await probe.close();

describe.skipIf(!LIVE)("graph wiring against the live kw-neo4j", () => {
  let ctx: TestContext | null = null;
  let runId = "";
  afterAll(async () => {
    if (ctx && runId) {
      const kw = ctx.app.kw.graph.kw!;
      await kw.client.write(async (tx) => {
        await tx.run("MATCH (n:Investigation|SafeguardVersion {owner_run: $runId}) DETACH DELETE n", { runId });
      });
      await kw.deleteRun(runId);
    }
    await ctx?.close();
  });

  it("re-projects a run idempotently, including Investigation nodes, and serves it from Neo4j", async () => {
    ctx = await createTestApp({}, { graph: new KwGraph({ cwd: REPO_ROOT }) });
    const seeded = seed(ctx, "fx-graph-live");
    runId = seeded.runId;
    addInvestigation(ctx.db, runId, seeded.findingId, seeded.eventIds[0]!, "live");
    const kw = ctx.app.kw.graph.kw!;
    const snapshot = async () => {
      const r = await kw.client.read(
        `MATCH (n) WHERE n.owner_run = $runId
         OPTIONAL MATCH (n)-[r]->() RETURN count(DISTINCT n) AS nodes, count(DISTINCT r) AS rels, collect(DISTINCT labels(n)) AS labels`,
        { runId },
        (rec) => ({ nodes: Number(rec.get("nodes")), rels: Number(rec.get("rels")), labels: (rec.get("labels") as string[][]).map((l) => [...l].sort().join(":")).sort() }),
      );
      if (!r.ok) throw new Error(r.error.message);
      return r.value[0]!;
    };

    const first = await ctx.app.kw.graph.syncRun(runId, "test");
    expect(first.ok).toBe(true);
    expect(first.addendum).toMatchObject({ investigations: 1, uses_evidence: 1 });
    const a = await snapshot();
    const second = await ctx.app.kw.graph.syncRun(runId, "test");
    expect(second.ok).toBe(true);
    const b = await snapshot();
    expect(b).toEqual(a);
    expect(second.core?.nodes).toBe(first.core?.nodes);
    expect(second.core?.relationships).toBe(first.core?.relationships);
    expect(a.labels.some((l) => l.includes("Investigation"))).toBe(true);
    expect(a.labels.some((l) => l.includes("AgentAction"))).toBe(true);

    const leak = await kw.client.read("MATCH (i:Investigation {owner_run: $runId}) RETURN i.latest_answer_summary AS s", { runId }, (rec) => String(rec.get("s")));
    expect(leak.ok && leak.value[0]).toBeTruthy();
    expect(leak.ok ? leak.value[0] : "").not.toContain("sk-ant-api03");

    const g = await getJson<FindingGraphResponse>(ctx.app, `/api/findings/${seeded.findingId}/graph`);
    expect(g.status).toBe(200);
    expect(g.body.source).toBe("neo4j");
    expect(g.body.insights).not.toBeNull();
    expect(g.body.nodes.some((n) => n.label === "Investigation")).toBe(true);
    expect(g.body.edges.some((e) => e.type === "INVESTIGATES" && e.to === seeded.findingId)).toBe(true);
    expect(g.body.edges.some((e) => e.type === "USES_EVIDENCE" && e.basis === "ai")).toBe(true);

    const ev = await ctx.app.kw.services.evidence.forFinding(seeded.findingId, "What happened?");
    expect(ev.retrieval).toMatchObject({ retriever: "graph", fallback_reason: null });
  });
});
