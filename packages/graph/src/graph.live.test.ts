/**
 * Integration tests against the live kw-neo4j (docker/compose.dev.yml). Skipped, with a message, when Neo4j is not
 * reachable or not configured. Test data uses run ids run_fx_kwgraph_test_* and is removed afterwards.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KwGraph } from "./index";
import { processId } from "./model";
import {
  A,
  B,
  bundleA,
  bundleB,
  F_CLAIM_A,
  F_ENV_A,
  F_ENV_B,
  POLICY_V1,
  POLICY_V2,
  RUN_A,
  RUN_B,
  SG_A,
  VR_PREVENTED,
  VR_REPRODUCED,
} from "./testing/fixture-bundles";

const here = dirname(fileURLToPath(import.meta.url));
const g = new KwGraph({ cwd: here, connectionTimeoutMs: 2000 });
const health = await g.health();
const live = health.ok;
if (!health.ok) {
  console.warn(`[@kw/graph] SKIPPING live Neo4j tests: ${health.error.kind}: ${health.error.message}. Start it with: docker compose -f docker/compose.dev.yml up -d --wait`);
} else {
  console.info(`[@kw/graph] live Neo4j: ${health.value.server_agent} (version ${health.value.server_version}, ${health.value.edition}) at ${health.value.address}`);
}

const REAL_FIXTURES_DIR = "/Users/oguzkirmizi/Desktop/academics/hackathons/81agents/fixtures/runs";

/** Exact fingerprint of everything owned by (or attached to) the given runs. */
async function fingerprint(runIds: string[]) {
  const nodes = await g.client.read(
    `MATCH (n) WHERE n.owner_run IN $runs
     OPTIONAL MATCH (n)--(s) WHERE s:Resource OR s:Policy OR s:PolicyVersion
     WITH collect(DISTINCT labels(n)[0] + ':' + n.id) + collect(DISTINCT labels(s)[0] + ':' + s.id) AS ids
     UNWIND ids AS id RETURN id ORDER BY id`,
    { runs: runIds },
    (r) => r.get("id") as string,
  );
  const rels = await g.client.read(
    `MATCH (n)-[r]-() WHERE n.owner_run IN $runs
     WITH DISTINCT r
     RETURN type(r) + ':' + r.key + ':' + r.basis AS k ORDER BY k`,
    { runs: runIds },
    (r) => r.get("k") as string,
  );
  if (!nodes.ok || !rels.ok) throw new Error("fingerprint query failed");
  return { nodes: [...new Set(nodes.value)], rels: rels.value };
}

async function globalCounts() {
  const r = await g.client.read(
    "MATCH (n) WITH count(n) AS nodes OPTIONAL MATCH ()-[r]->() RETURN nodes, count(r) AS rels",
    {},
    (rec) => ({ nodes: Number(rec.get("nodes")), rels: Number(rec.get("rels")) }),
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.value[0]!;
}

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { kind: string; message: string } }): T => {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.message}`);
  return r.value;
};
const found = <T extends { found: boolean }>(r: T): Extract<T, { found: true }> => {
  if (!r.found) throw new Error("entity not found in graph");
  return r as Extract<T, { found: true }>;
};

describe.skipIf(!live)("live Neo4j", () => {
  beforeAll(async () => {
    unwrap(await g.deleteRun(RUN_A));
    unwrap(await g.deleteRun(RUN_B));
  });
  afterAll(async () => {
    await g.deleteRun(RUN_A);
    await g.deleteRun(RUN_B);
    await g.close();
  });

  it("health reports connectivity and server version", () => {
    if (!health.ok) throw new Error("unreachable");
    expect(health.value.server_version).toMatch(/^\d+\.\d+/);
    expect(health.value.edition).toBe("community");
  });

  it("ensureConstraints is idempotent and covers every node label", async () => {
    unwrap(await g.ensureConstraints());
    unwrap(await g.ensureConstraints());
    const names = unwrap(await g.client.read("SHOW CONSTRAINTS YIELD name, type RETURN name, type", {}, (r) => ({ name: r.get("name") as string, type: r.get("type") as string })));
    // The app server adds its own kw_ constraints (Investigation, SafeguardVersion) to the same shared DB,
    // so assert that this package's 14 are present rather than an exact global count.
    const ADDENDUM = new Set(["kw_investigation_id", "kw_safeguard_version_id"]);
    const kw = names.filter((c) => c.name.startsWith("kw_") && !ADDENDUM.has(c.name));
    expect(kw).toHaveLength(14);
    expect(kw.every((c) => /UNIQUENESS$/.test(c.type))).toBe(true); // "UNIQUENESS" (5.26) or "NODE_PROPERTY_UNIQUENESS" (2026.x)
    const status = await g.componentStatus();
    expect(status.status).toBe("connected");
  });

  it("projection is idempotent (same nodes and relationships on re-projection, both modes)", async () => {
    // B first: its RECURRED_AS points at A's finding, which is not projected yet -> reported as dangling, no stub.
    const rb = unwrap(await g.projectRunBundle(bundleB));
    expect(rb.dangling.map((d) => d.type)).toEqual(["RECURRED_AS"]);
    const ra = unwrap(await g.projectRunBundle(bundleA));
    expect(ra.dangling).toEqual([]);
    expect(ra.reverse_links).toBe(1); // B's recurrence now linked from A's finding

    const before = await fingerprint([RUN_A, RUN_B]);
    const g1 = await globalCounts();
    const ra2 = unwrap(await g.projectRunBundle(bundleA));
    const rb2 = unwrap(await g.projectRunBundle(bundleB));
    const ra3 = unwrap(await g.projectRunBundle(bundleA, { mode: "merge" }));
    const after = await fingerprint([RUN_A, RUN_B]);
    const g2 = await globalCounts();

    expect(after).toEqual(before);
    expect(g2).toEqual(g1);
    expect(rb2.dangling).toEqual([]);
    expect(ra2.relationships).toBe(ra.relationships);
    expect(ra3.relationships).toBe(ra.relationships);
    console.info(
      `[@kw/graph] idempotency: scoped nodes=${after.nodes.length} rels=${after.rels.length}; global nodes=${g2.nodes} rels=${g2.rels}; ` +
        `A receipt nodes=${ra2.nodes} rels=${ra2.relationships} by_type=${JSON.stringify(ra2.relationships_by_type)}`,
    );
  });

  it("Q1 events supporting a finding (observed only by default)", async () => {
    const r = found(unwrap(await g.eventsSupportingFinding(F_ENV_A)));
    expect(r.rows.map((x) => x.event.id).sort()).toEqual([A.oCat.id, A.oEnv.id].sort());
    expect(r.rows.every((x) => x.role === "observed" && x.relation.basis === "derived")).toBe(true);
    expect(r.rows.find((x) => x.event.id === A.oEnv.id)!.evidence_ids).toEqual(["evd_kwg_a_files"]);
    expect(r.cited_evidence_ids).toEqual(["evd_kwg_a_files"]);
    const all = found(unwrap(await g.eventsSupportingFinding(F_ENV_A, { includeNonObserved: true })));
    expect(all.rows).toHaveLength(3);
    expect((unwrap(await g.eventsSupportingFinding("fnd_does_not_exist"))).found).toBe(false);
  });

  it("Q2 agent report compared against each observed event", async () => {
    const r = found(unwrap(await g.reportsComparedToObserved(RUN_A)));
    expect(r.rows).toHaveLength(6);
    const by = new Map(r.rows.map((x) => [x.observed.id, x]));
    expect(by.get(A.oNpm.id)!.status).toBe("paired");
    expect(by.get(A.oNpm.id)!.compared_reports[0]!.agent_event.id).toBe(A.rBash.id);
    expect(by.get(A.oNpm.id)!.compared_reports[0]!.basis).toBe("derived");
    expect(by.get(A.oApp.id)!.compared_reports[0]!).toMatchObject({ match: "uncertain", basis: "inferred", confidence: "medium" });
    expect(by.get(A.oEnv.id)!.status).toBe("observed_only");
    expect(by.get(A.oEnv.id)!.contradicted_reports.map((c) => [c.agent_event.id, c.finding_id])).toEqual([[A.rClaim.id, F_CLAIM_A]]);
    expect(by.get(A.oNet.id)!.status).toBe("not_correlated");
  });

  it("Q3 process that generated an event", async () => {
    const r = found(unwrap(await g.processForEvent(A.oEnv.id)));
    expect(r.process).toMatchObject({ id: processId(RUN_A, 202), pid: 202, name: "cat" });
    expect(r.attribution).toMatchObject({ basis: "observed", rule: "event.process_id", record_basis: "observed" });
    expect(r.parent).toMatchObject({ pid: 201, name: "node" });
    expect(r.exec_event_ids).toEqual([A.oCat.id]);
    const hook = found(unwrap(await g.processForEvent(A.rBash.id)));
    expect(hook.process).toBeNull();
    expect(hook.unavailable_reason).toMatch(/unavailable_fields/);
    const inferred = found(unwrap(await g.processForEvent(A.oApp.id)));
    expect(inferred.attribution).toMatchObject({ basis: "inferred", confidence: "medium" });
  });

  it("Q4 policy in effect when the action occurred", async () => {
    const a = found(unwrap(await g.policyInEffect(A.oEnv.id)));
    expect(a.policy_version).toMatchObject({ id: POLICY_V1, version: "1", rule_ids: ["deny-env"] });
    expect(a.snapshot_created_before_event).toBe(true);
    expect(a.violations.map((v) => [v.policy_version_id, v.policy_rule_id, v.finding_id])).toEqual([[POLICY_V1, "deny-env", F_ENV_A]]);
    const b = found(unwrap(await g.policyInEffect(B.oEnv.id)));
    expect(b.policy_version!.id).toBe(POLICY_V2);
  });

  it("Q5 safeguard created from an incident", async () => {
    const r = found(unwrap(await g.safeguardsFromIncident(F_ENV_A)));
    expect(r.safeguards.map((s) => s.safeguard.id)).toEqual([SG_A]);
    expect(r.safeguards[0]!.verification_run_ids).toEqual([VR_PREVENTED, VR_REPRODUCED].sort());
    expect(found(unwrap(await g.safeguardsFromIncident(F_CLAIM_A))).safeguards).toEqual([]);
    expect(unwrap(await g.safeguardsFromIncident("fnd_does_not_exist")).found).toBe(false);
  });

  it("Q6 did verification reproduce or prevent the behavior", async () => {
    const rows = unwrap(await g.verificationOutcomes({ safeguardId: SG_A }));
    const by = new Map(rows.map((r) => [r.verification_run_id, r]));
    expect(by.get(VR_PREVENTED)!.verdict).toBe("prevented");
    expect(by.get(VR_REPRODUCED)!).toMatchObject({ verdict: "reproduced", executed_run_id: RUN_B, recurrence_finding_ids: [F_ENV_B] });
    expect(unwrap(await g.verificationOutcomes({ findingId: F_ENV_A }))).toHaveLength(2);
    // Issue 4: the legacy verdict is kept as legacy_verdict; the separate outcomes never turn it into a task success.
    const prevented = by.get(VR_PREVENTED)!;
    expect(prevented.legacy_verdict).toBe("prevented");
    expect(prevented.legitimate_behavior_worked).toBe(true); // legacy column, untouched
    expect(prevented.task_outcome.value).toBe("unknown");
    expect(prevented.security_outcome.value).toBe("unknown"); // the fixture cites no evidence, so nothing is inferred
    expect(prevented.outcome_origin).toBe("legacy");
    expect(by.get(VR_REPRODUCED)!.task_outcome.value).toBe("unknown");
  });

  it("multi-hop: process ancestry from an observed event back to the originating tool call", async () => {
    const r = found(unwrap(await g.processAncestry(A.oEnv.id)));
    expect(r.chain.map((h) => h.process.pid)).toEqual([100, 200, 201, 202]);
    expect(r.chain[0]!.spawned_by).toBeNull();
    expect(r.chain[3]!.spawned_by!.event_ids).toEqual([A.oCat.id, A.oEnv.id].sort());
    expect(r.origin_tool_call).toMatchObject({ via_process_id: processId(RUN_A, 200), hops_to_event_process: 2 });
    expect(r.origin_tool_call!.agent_event.id).toBe(A.rBash.id);
    expect(r.origin_tool_call!.relation.basis).toBe("inferred"); // time-correlated tool_use_id <-> process join
    const noOrigin = found(unwrap(await g.processAncestry(A.oApp.id)));
    expect(noOrigin.origin_tool_call).toBeNull();
    expect(noOrigin.unresolved_reason).toMatch(/no reported tool call/);
  });

  it("multi-hop: cross-run recurrence on the same resource under different policy versions", async () => {
    const rows = unwrap(await g.crossRunResourceRecurrence({ findingId: F_ENV_B }));
    // Both of A's findings cite the observed .env read; only the unreported-read one is linked by RECURRED_AS.
    expect(rows.map((r) => [r.earlier.finding.id, r.later.finding.id, r.linked_by_recurrence]).sort()).toEqual(
      [
        [F_CLAIM_A, F_ENV_B, false],
        [F_ENV_A, F_ENV_B, true],
      ].sort(),
    );
    const row = rows.find((r) => r.earlier.finding.id === F_ENV_A)!;
    expect(row.resource).toMatchObject({ kind: "file", key: "/workspace/.env" });
    expect([row.earlier.finding.id, row.earlier.policy_version.id, row.earlier.run_id]).toEqual([F_ENV_A, POLICY_V1, RUN_A]);
    expect([row.later.finding.id, row.later.policy_version.id, row.later.run_id]).toEqual([F_ENV_B, POLICY_V2, RUN_B]);
    expect(row.earlier.event_ids).toEqual([A.oEnv.id]);
    expect(row.same_logical_policy).toBe(true);
    expect(row.linked_by_recurrence).toBe(true);
  });

  it("findingNeighborhood returns styled nodes/edges for the UI", async () => {
    const d1 = found(unwrap(await g.findingNeighborhood(F_ENV_A, 1)));
    const kinds = new Set(d1.nodes.map((n) => n.kind));
    for (const k of ["Finding", "ObservedEvent", "AgentEvent", "Evidence", "PolicyVersion", "Safeguard", "Run", "Task"]) expect(kinds).toContain(k);
    expect(d1.edges.every((e) => ["observed", "reported", "derived", "inferred"].includes(e.basis) && e.rule.length > 0)).toBe(true);
    expect(d1.edges.filter((e) => e.record_basis === "reported").every((e) => e.basis !== "observed")).toBe(true);
    const ids = new Set(d1.nodes.map((n) => n.id));
    expect(d1.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(d1.nodes.every((n) => !("owner_run" in n.props) && !("ts" in n.props))).toBe(true);
    // Issue 4: VerificationRun nodes expose both outcomes (with basis/evidence) as separate properties.
    const d2 = found(unwrap(await g.findingNeighborhood(F_ENV_A, 2)));
    const vrNode = d2.nodes.find((n) => n.id === VR_PREVENTED)!;
    expect(vrNode.kind).toBe("VerificationRun");
    expect(vrNode.props).toMatchObject({ result: "verified_for_tested_scenario", security_outcome: "unknown", task_outcome: "unknown", outcome_origin: "legacy" });
    expect(vrNode.props.task_outcome_evidence_ids).toEqual([]);
    expect(vrNode.display).toMatch(/security unknown · task unknown/);
    const d3 = found(unwrap(await g.findingNeighborhood(F_ENV_A, 3)));
    expect(d3.nodes.length).toBeGreaterThan(d1.nodes.length);
    expect(d3.nodes.some((n) => n.id === F_ENV_B)).toBe(true); // recurrence across runs
    expect(d3.nodes.some((n) => n.kind === "Process")).toBe(true);
    expect((await g.findingNeighborhood(F_ENV_A, 4)).ok).toBe(false);
  });

  it("refuses to silently rewrite an existing policy version snapshot", async () => {
    const withSha = (sha: string) => ({ ...bundleA, policy_version: { ...bundleA.policy_version, content_sha256: sha } });
    unwrap(await g.projectRunBundle(withSha("a".repeat(64))));
    const before = await fingerprint([RUN_A]);
    const r = await g.projectRunBundle(withSha("b".repeat(64)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.error.kind, r.error.code]).toEqual(["invalid_input", "KW.PolicyVersionImmutable"]);
    expect(await fingerprint([RUN_A])).toEqual(before); // transaction rolled back, nothing deleted
    unwrap(await g.projectRunBundle(bundleA)); // test bundle has no sha: restores the original state
  });

  const realFiles = existsSync(REAL_FIXTURES_DIR) ? readdirSync(REAL_FIXTURES_DIR).filter((f) => f.endsWith(".json")).sort() : [];
  it.skipIf(realFiles.length === 0)(`real repo fixtures project idempotently (${realFiles.length} files in fixtures/runs)`, async () => {
    for (const file of realFiles) {
      const bundle = JSON.parse(readFileSync(join(REAL_FIXTURES_DIR, file), "utf8")) as { run: { id: string } };
      const runId = bundle.run.id;
      const preexisting = unwrap(await g.client.read("MATCH (r:Run {id: $id}) RETURN count(r) AS c", { id: runId }, (r) => Number(r.get("c"))))[0]! > 0;
      const r1 = await g.projectRunBundle(bundle);
      if (!r1.ok) throw new Error(`${file}: ${r1.error.message}`);
      const f1 = await fingerprint([runId]);
      unwrap(await g.projectRunBundle(bundle));
      const f2 = await fingerprint([runId]);
      expect(f2, file).toEqual(f1);
      console.info(`[@kw/graph] real fixture ${file}: nodes=${r1.value.nodes} rels=${r1.value.relationships} dangling=${r1.value.dangling.length}`);
      if (!preexisting) unwrap(await g.deleteRun(runId));
    }
  });
});

if (!live) {
  describe("live Neo4j (skipped)", () => {
    it.skip("Neo4j unreachable: see warning above", () => undefined);
  });
  afterAll(async () => g.close());
}
