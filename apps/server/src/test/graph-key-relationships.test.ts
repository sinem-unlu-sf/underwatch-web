/**
 * Addendum C section 5: key relationships for a finding. Built only from the graph response (Neo4j query results or
 * the relational fallback) plus stored KW records; never invents nodes; inferred links are labeled; Neo4j-down is
 * labeled "From Underwatch records, Neo4j unavailable". Existing graph response fields are unchanged.
 * Live tests: (1) a test-only run id projected then deleted; (2) READ-ONLY queries against the dev projection of the
 * real fx-04 fixture when it is present (no writes, no re-projection scheduling).
 */
import path from "node:path";
import { KwGraph } from "@kw/graph";
import { FindingGraphResponse, KeyRelationshipsSummary } from "@kw/schema";
import { afterAll, describe, expect, it } from "vitest";
import { stmt } from "../db/codec";
import { findingGraphFromNeo4j } from "../graph/finding-graph";
import { buildKeyRelationships, weakestBasis } from "../graph/key-relationships";
import { importFixture, importFixtureFile } from "../ingest/fixtures";
import { requireFinding } from "../repo/findings";
import { buildFixtureFile } from "./bundle";
import { createTestApp, getJson, type TestContext } from "./helpers";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const EXISTING_KEYS = ["finding_id", "source", "detail", "nodes", "edges", "truncated", "insights"];

function seed(ctx: TestContext, slug: string) {
  const imp = importFixture(ctx.db, buildFixtureFile(slug));
  if (!imp.ok) throw new Error(`fixture import failed: ${JSON.stringify(imp).slice(0, 300)}`);
  const f = stmt(ctx.db, "SELECT id FROM findings WHERE run_id = ? AND policy_rule_id IS NOT NULL ORDER BY id LIMIT 1").get(imp.run_id)!;
  return { runId: imp.run_id, findingId: f.id as string };
}

/** Every step id is either a node of the response or an id returned by a multi-hop insight query. */
function assertGrounded(g: FindingGraphResponse, s: KeyRelationshipsSummary) {
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  const insightIds = new Set<string>([
    ...(g.insights?.ancestry ?? []).flatMap((a) => [a.event_id, ...a.chain.map((h) => h.process_id), ...(a.origin_tool_call ? [a.origin_tool_call.event_id] : [])]),
    ...(g.insights?.cross_run ?? []).flatMap((m) => [m.resource_id, m.finding_id, g.finding_id]),
  ]);
  for (const item of s.items) {
    expect(item.steps.length, item.id).toBeGreaterThan(0);
    for (const st of item.steps) {
      expect(st.in_graph, `${item.id} ${st.node_id}`).toBe(nodeIds.has(st.node_id));
      if (!st.in_graph) expect(insightIds.has(st.node_id), `${item.id} ${st.node_id} not from any query`).toBe(true);
    }
    for (const l of item.links) if (l.href) expect(l.href).toMatch(/^\/(runs|findings|safeguards)\//);
    if (item.basis === "inferred") expect(item.basis_note).toMatch(/nferred|hypothesis|lead/);
  }
  expect(s.items.length).toBeLessThanOrEqual(6);
  expect(s.note).toMatch(/not proof/);
}

describe("key relationships without Neo4j", () => {
  it("weakestBasis picks the weakest hop and treats no basis as inferred", () => {
    expect(weakestBasis(["observed", "derived", "inferred"])).toBe("inferred");
    expect(weakestBasis(["observed", "reported"])).toBe("reported");
    expect(weakestBasis(["observed", null])).toBe("observed");
    expect(weakestBasis([])).toBe("inferred");
  });

  it("adds key_relationships to the graph response (existing fields unchanged) and serves /graph/summary from KW records", async () => {
    const ctx = await createTestApp();
    try {
      const { findingId } = seed(ctx, "fx-krel-nocfg");
      const g = await getJson<FindingGraphResponse>(ctx.app, `/api/findings/${findingId}/graph`);
      expect(g.status).toBe(200);
      for (const k of EXISTING_KEYS) expect(g.body).toHaveProperty(k);
      expect(g.body.source).toBe("relational");
      expect(g.body.insights).toBeNull();
      const kr = g.body.key_relationships!;
      expect(KeyRelationshipsSummary.safeParse(kr).success).toBe(true);
      expect(kr.source).toBe("relational");
      expect(kr.detail).toMatch(/^From Underwatch records, Neo4j unavailable\./);
      expect(kr.unavailable.join(" ")).toMatch(/origin_chain/);
      expect(kr.items.length).toBeGreaterThanOrEqual(3);
      expect(kr.items.every((i) => i.source === "kw_records")).toBe(true);
      expect(kr.items.some((i) => i.kind === "origin_chain" || i.kind === "cross_run")).toBe(false);
      const policy = kr.items.find((i) => i.kind === "policy")!;
      expect(policy.text).toMatch(/rule deny-env/);
      const ver = kr.items.find((i) => i.kind === "verification")!;
      expect(ver.text).toMatch(/^Verification ver_\S+ tested safeguard sg_/);
      expect(ver.text).toMatch(/security .+, task .+/);
      expect(ver.basis_note).toMatch(/blocking an action does not show the task succeeded/);
      assertGrounded(g.body, kr);

      const s = await getJson<KeyRelationshipsSummary>(ctx.app, `/api/findings/${findingId}/graph/summary`);
      expect(s.status).toBe(200);
      expect(s.body).toEqual(kr);
      expect((await getJson(ctx.app, "/api/findings/fnd_does_not_exist/graph/summary")).status).toBe(404);
      // Same auth guard as every /api route.
      const anon = await ctx.rawInject({ method: "GET", url: `/api/findings/${findingId}/graph/summary` });
      expect([401, 403]).toContain(anon.statusCode);
    } finally {
      await ctx.close();
    }
  });

  it("labels the fallback honestly when Neo4j is unreachable", async () => {
    const dead = new KwGraph({
      config: { uri: "bolt://127.0.0.1:1", user: "neo4j", password: "dead-graph-krel-password", database: "neo4j", configuredVia: "test" },
      connectionTimeoutMs: 300,
      maxRetryTimeMs: 100,
    });
    const ctx = await createTestApp({}, { graph: dead });
    try {
      const { findingId } = seed(ctx, "fx-krel-dead");
      const s = await getJson<KeyRelationshipsSummary>(ctx.app, `/api/findings/${findingId}/graph/summary`);
      expect(s.status).toBe(200);
      expect(s.body.source).toBe("relational");
      expect(s.body.detail).toMatch(/^From Underwatch records, Neo4j unavailable\. Neo4j unavailable/);
      expect(JSON.stringify(s.body)).not.toContain("dead-graph-krel-password");
    } finally {
      await ctx.close();
    }
  });
});

const probe = new KwGraph({ cwd: REPO_ROOT, connectionTimeoutMs: 1500, maxRetryTimeMs: 500 });
const LIVE = (await probe.health()).ok;
await probe.close();

describe.skipIf(!LIVE)("key relationships against the live kw-neo4j", () => {
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

  it("builds key relationships from Neo4j results for a projected test-only run", async () => {
    ctx = await createTestApp({}, { graph: new KwGraph({ cwd: REPO_ROOT }) });
    const seeded = seed(ctx, "fx-krel-live");
    runId = seeded.runId;
    expect((await ctx.app.kw.graph.syncRun(runId, "test")).ok).toBe(true);
    const g = await getJson<FindingGraphResponse>(ctx.app, `/api/findings/${seeded.findingId}/graph`);
    expect(g.status).toBe(200);
    expect(g.body.source).toBe("neo4j");
    const kr = g.body.key_relationships!;
    expect(kr.source).toBe("neo4j");
    expect(kr.unavailable).toEqual([]);
    expect(kr.items.length).toBeGreaterThanOrEqual(3);
    expect(kr.items.every((i) => i.source === "neo4j")).toBe(true);
    const policy = kr.items.find((i) => i.kind === "policy")!;
    expect(policy.steps.at(-1)?.via).toBe("VIOLATES");
    expect(kr.items.some((i) => i.kind === "verification")).toBe(true);
    assertGrounded(g.body, kr);
    const s = await getJson<KeyRelationshipsSummary>(ctx.app, `/api/findings/${seeded.findingId}/graph/summary`);
    expect(s.body).toEqual(kr);
  });

  it("read-only: real fx-04 projection yields an origin chain and cross-run resource match from Neo4j", async (t) => {
    const kw = new KwGraph({ cwd: REPO_ROOT });
    const c = await createTestApp();
    try {
      const imp = importFixtureFile(c.db, path.join(REPO_ROOT, "fixtures/runs/fx-04-env-read-via-bash.json"));
      if (!imp.ok) throw new Error("fx-04 import failed");
      const fid = stmt(c.db, "SELECT id FROM findings WHERE run_id = ? AND category = 'permission_violation' LIMIT 1").get(imp.run_id)!.id as string;
      const present = await kw.client.read("MATCH (f:Finding {id: $id}) RETURN count(f) AS n", { id: fid }, (r) => Number(r.get("n")));
      if (!present.ok || present.value[0] === 0) {
        t.skip();
        return;
      }
      const r = await findingGraphFromNeo4j(kw, c.db, fid);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const kr = buildKeyRelationships(c.db, requireFinding(c.db, fid), r.value);
      assertGrounded(r.value, kr);
      const origin = kr.items.find((i) => i.kind === "origin_chain");
      expect(origin, JSON.stringify(kr.items.map((i) => i.text))).toBeDefined();
      expect(origin!.steps[0]!.label).toBe("AgentAction");
      expect(origin!.text).toMatch(/^Agent's \S+ tool call/);
      if ((r.value.insights?.cross_run.length ?? 0) > 0) expect(kr.items.some((i) => i.kind === "cross_run")).toBe(true);
    } finally {
      await c.close();
      await kw.close();
    }
  });
});
