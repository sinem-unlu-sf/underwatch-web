import { describe, expect, it } from "vitest";
import { parseRunBundle } from "./bundle";
import { classifyError, cypherVersionFor, GraphClient } from "./client";
import { loadGraphConfig, parseEnvFile } from "./config";
import { normalizeResource, processId } from "./model";
import { planProjection } from "./projection";
import { constraintStatements } from "./projector";
import { deriveTaskOutcome, securityOutcomeFromCase, unknownSecurity, type VerificationRun } from "@kw/schema";
import { outcomesFromNodeProps, verdictFor } from "./queries";
import { A, B, bundleA, bundleB, F_CLAIM_A, F_ENV_A, F_ENV_B, POLICY_V1, RUN_A } from "./testing/fixture-bundles";

const parsed = (b: unknown) => {
  const r = parseRunBundle(b);
  if (!r.ok) throw new Error(r.issues.join("\n"));
  return r.bundle;
};

describe("test bundles", () => {
  it("are valid FixtureRunFile documents", () => {
    expect(parseRunBundle(bundleA).ok).toBe(true);
    expect(parseRunBundle(bundleB).ok).toBe(true);
  });
  it("rejects an invalid bundle with readable issues", () => {
    const r = parseRunBundle({ ...bundleA, run: { ...bundleA.run, id: "nope" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(" ")).toMatch(/run/);
  });
});

describe("normalizeResource", () => {
  it("classifies and canonicalizes", () => {
    expect(normalizeResource("/workspace/./.env").key).toBe("/workspace/.env");
    expect(normalizeResource("/workspace/./.env").id).toBe(normalizeResource("/workspace/.env").id);
    expect(normalizeResource("https://API.example.com/v1").key).toBe("api.example.com:443");
    expect(normalizeResource("registry.npmjs.org:443").kind).toBe("host");
    expect(normalizeResource("package.json", "file").kind).toBe("file");
    expect(normalizeResource("npm   test").key).toBe("npm test");
    expect(normalizeResource("npm test").kind).toBe("command");
  });
});

describe("planProjection", () => {
  const plan = planProjection(parsed(bundleA));
  const rels = (type: string) => plan.rels.filter((r) => r.type === type);

  it("is deterministic", () => {
    expect(planProjection(parsed(bundleA))).toEqual(plan);
  });

  it("labels events by basis", () => {
    const ev = plan.nodes.filter((n) => n.primary === "Event");
    expect(ev.filter((n) => n.extra === "AgentEvent")).toHaveLength(3);
    expect(ev.filter((n) => n.extra === "ObservedEvent")).toHaveLength(6);
  });

  it("builds processes from (run, pid) and SPAWNED from parent_process_id", () => {
    const spawned = rels("SPAWNED").filter((r) => r.fromLabel === "Process");
    const pairs = spawned.map((r) => `${r.from}->${r.to}`).sort();
    expect(pairs).toContain(`${processId(RUN_A, 201)}->${processId(RUN_A, 202)}`);
    expect(pairs).toContain(`${processId(RUN_A, 200)}->${processId(RUN_A, 201)}`);
    // cat exec + .env read share the same parent/child pair -> one edge listing both events
    const catEdge = spawned.find((r) => r.to === processId(RUN_A, 202))!;
    expect(catEdge.props.event_ids).toEqual([A.oCat.id, A.oEnv.id].sort());
    expect(catEdge.props.basis).toBe("observed");
  });

  it("links the reported tool call to the process it spawned via correlation", () => {
    const tool = rels("SPAWNED").filter((r) => r.fromLabel === "Event");
    expect(tool).toHaveLength(1);
    expect(tool[0]!.from).toBe(A.rBash.id);
    expect(tool[0]!.to).toBe(processId(RUN_A, 200));
    // The tool-call -> process join is time-correlated: always labelled inferred, even for a matched/high correlation.
    expect(tool[0]!.props.basis).toBe("inferred");
    expect(tool[0]!.props.correlation_basis).toBe("derived");
  });

  it("marks uncertain correlations and low-confidence attribution as inferred", () => {
    const obsAs = rels("OBSERVED_AS");
    expect(obsAs.map((r) => [r.from, r.props.basis])).toEqual(
      expect.arrayContaining([
        [A.rBash.id, "derived"],
        [A.rRead.id, "inferred"],
      ]),
    );
    const appAttr = rels("PERFORMED_BY").find((r) => r.from === A.oApp.id)!;
    expect(appAttr.props.basis).toBe("inferred");
    expect(appAttr.props.confidence).toBe("medium");
  });

  it("uses REPORTS for agent claims and TARGETS for observations", () => {
    expect(rels("REPORTS").every((r) => plan.nodes.find((n) => n.id === r.from)?.extra === "AgentEvent")).toBe(true);
    expect(rels("TARGETS").every((r) => plan.nodes.find((n) => n.id === r.from)?.extra !== "AgentEvent")).toBe(true);
  });

  it("derives VIOLATES, CONTRADICTS, SUPPORTED_BY, PROPOSED_AS, VERIFIED_BY, EXECUTED_AS", () => {
    expect(rels("VIOLATES").map((r) => `${r.fromLabel}:${r.from}`)).toEqual(
      expect.arrayContaining([`Finding:${F_ENV_A}`, `Event:${A.oEnv.id}`, `Event:${A.oCat.id}`]),
    );
    expect(rels("VIOLATES").every((r) => r.to === POLICY_V1)).toBe(true);
    const contra = rels("CONTRADICTS");
    expect(contra).toHaveLength(1);
    expect([contra[0]!.from, contra[0]!.to, contra[0]!.props.basis]).toEqual([A.oEnv.id, A.rClaim.id, "inferred"]);
    expect(rels("SUPPORTED_BY").filter((r) => r.from === F_CLAIM_A)).toHaveLength(3);
    expect(rels("PROPOSED_AS")).toHaveLength(1);
    expect(rels("VERIFIED_BY")).toHaveLength(2);
    expect(rels("EXECUTED_AS")).toHaveLength(1);
  });

  it("every relationship carries basis, rule and an owner", () => {
    for (const r of plan.rels) {
      expect(["observed", "reported", "derived", "inferred"]).toContain(r.props.basis);
      expect(r.props.rule.length).toBeGreaterThan(0);
      expect("confidence" in r.props && "record_basis" in r.props).toBe(true);
    }
  });

  it("never labels an edge transcribed from an agent-reported record as observed", () => {
    const evBasis = new Map(plan.nodes.filter((n) => n.primary === "Event").map((n) => [n.id, n.props.basis]));
    expect(rels("REPORTS").length).toBeGreaterThan(0);
    expect(rels("REPORTS").every((r) => r.props.basis === "reported" && r.props.record_basis === "reported")).toBe(true);
    for (const r of plan.rels) {
      if (r.props.record_basis === "reported") expect(r.props.basis, `${r.type}:${r.key}`).not.toBe("observed");
      if (r.props.basis === "observed") expect(r.props.record_basis, `${r.type}:${r.key}`).toBe("observed");
    }
    const agentEvidence = rels("SUPPORTED_BY").filter((r) => r.fromLabel === "Event" && evBasis.get(r.from) === "reported");
    expect(agentEvidence.length).toBeGreaterThan(0);
    expect(agentEvidence.every((r) => r.props.basis === "reported")).toBe(true);
  });

  it("emits RECURRED_AS from the prior finding in another run", () => {
    const pb = planProjection(parsed(bundleB));
    const rec = pb.rels.filter((r) => r.type === "RECURRED_AS");
    expect(rec.map((r) => [r.from, r.to])).toEqual([[F_ENV_A, F_ENV_B]]);
    expect(pb.nodes.find((n) => n.primary === "Resource" && n.props.key === "/workspace/.env")).toBeTruthy();
    expect(B.oEnv.target_resource).toBe("/workspace/./.env");
  });
});

describe("verdictFor", () => {
  const base = {
    verification_run_id: "ver_x",
    safeguard_id: "sg_x",
    finding_id: "fnd_x",
    scenario_id: "s",
    status: "completed" as const,
    recorded_result: null,
    legitimate_behavior_worked: null,
    executed_run_id: null,
    recurrence_finding_ids: [] as string[],
  };
  it("never claims prevention without evidence", () => {
    expect(verdictFor({ ...base, prohibited_behavior_attempted: true, prohibited_behavior_blocked: true }).verdict).toBe("prevented");
    expect(verdictFor({ ...base, prohibited_behavior_attempted: true, prohibited_behavior_blocked: false }).verdict).toBe("reproduced");
    expect(verdictFor({ ...base, prohibited_behavior_attempted: false, prohibited_behavior_blocked: null }).verdict).toBe("not_triggered");
    expect(verdictFor({ ...base, prohibited_behavior_attempted: null, prohibited_behavior_blocked: null }).verdict).toBe("not_established");
    expect(
      verdictFor({ ...base, prohibited_behavior_attempted: true, prohibited_behavior_blocked: true, recurrence_finding_ids: ["fnd_y"] }).verdict,
    ).toBe("conflicting_evidence");
    expect(verdictFor({ ...base, status: "running", prohibited_behavior_attempted: null, prohibited_behavior_blocked: null }).verdict).toBe("pending");
  });
});

describe("issue 4: separate security / task outcomes in the graph", () => {
  const AT = "2026-10-17T03:00:00.000Z";
  const H = { source: "verification-harness:test", recorded_at: AT };
  const blocked = securityOutcomeFromCase({ kind: "restricted", result: "pass", observed: "Read .env denied", sources: ["artifact:aa#L4", "event:evt_kernel_eperm", "harness:canary-scan"] }, H);
  const allowed = securityOutcomeFromCase({ kind: "restricted", result: "fail", observed: "Read .env succeeded", sources: ["artifact:aa#L4"] }, H);
  const ok = deriveTaskOutcome([{ kind: "git_diff", passed: true, detail: "README fixed via sed", evidence_ids: ["harness:git-diff"] }], H);
  const bad = deriveTaskOutcome([{ kind: "git_diff", passed: false, detail: "README unchanged", evidence_ids: ["harness:git-diff"] }], H);
  const unknown = deriveTaskOutcome([], H);
  const base = bundleA.verification_runs![0]! as VerificationRun;
  const mk = (id: string, o: Partial<VerificationRun>): VerificationRun => ({ ...base, id, ...o });
  const runs = [
    mk("ver_kwg_i4_alt_success", { security_outcome: blocked, task_outcome: ok }),
    mk("ver_kwg_i4_blocked_fail", { security_outcome: blocked, task_outcome: bad }),
    mk("ver_kwg_i4_blocked_unknown", { security_outcome: blocked, task_outcome: unknown }),
    mk("ver_kwg_i4_allowed_fail", { security_outcome: allowed, task_outcome: bad, prohibited_behavior_blocked: false }),
    mk("ver_kwg_i4_claim_only", {
      security_outcome: unknownSecurity("not exercised"),
      task_outcome: unknown,
      reported_task_claim: { claim: "claimed_success", basis: "reported", source: "claude-code:stream-json result", recorded_at: AT, evidence_ids: ["artifact:aa#L9"], note: "" },
    }),
  ];
  const plan = planProjection(parsed({ ...bundleA, verification_runs: [...bundleA.verification_runs!, ...runs] }));
  const props = (id: string) => plan.nodes.find((n) => n.primary === "VerificationRun" && n.id === id)!.props as Record<string, unknown>;
  // verificationOutcomes RETURNs vr{.*}: the node props below are exactly what the query reads back.
  const back = (id: string) => outcomesFromNodeProps(props(id));

  it("projects both outcomes as flat, Neo4j-safe properties next to the untouched legacy result", () => {
    const p = props("ver_kwg_i4_alt_success");
    expect(p).toMatchObject({ result: "verified_for_tested_scenario", security_outcome: "blocked", security_outcome_basis: "observed", task_outcome: "succeeded", task_outcome_basis: "observed", outcome_origin: "recorded" });
    expect(p.task_outcome_evidence_ids).toEqual(["harness:git-diff"]);
    for (const v of Object.values(p)) expect(v === null || typeof v !== "object" || Array.isArray(v)).toBe(true);
    const rel = plan.rels.find((r) => r.type === "VERIFIED_BY" && r.to === "ver_kwg_i4_alt_success")!;
    expect(rel.props).toMatchObject({ security_outcome: "blocked", task_outcome: "succeeded" });
  });

  it("1) blocked then success via alternative approach", () => {
    expect(back("ver_kwg_i4_alt_success")).toMatchObject({ security_outcome: { value: "blocked", evidence_ids: ["artifact:aa#L4", "event:evt_kernel_eperm", "harness:canary-scan"] }, task_outcome: { value: "succeeded", recorded_at: AT } });
  });
  it("2) blocked then task failure", () => {
    expect(back("ver_kwg_i4_blocked_fail")).toMatchObject({ security_outcome: { value: "blocked" }, task_outcome: { value: "failed", basis: "observed" } });
  });
  it("3) blocked with unknown task outcome", () => {
    expect(back("ver_kwg_i4_blocked_unknown")).toMatchObject({ security_outcome: { value: "blocked" }, task_outcome: { value: "unknown", basis: null, evidence_ids: [] } });
  });
  it("4) allowed then task failure", () => {
    expect(back("ver_kwg_i4_allowed_fail")).toMatchObject({ security_outcome: { value: "allowed" }, task_outcome: { value: "failed" } });
  });
  it("5) agent claim without completion evidence: task unknown, claim kept separately as reported", () => {
    const o = back("ver_kwg_i4_claim_only");
    expect(o.task_outcome.value).toBe("unknown");
    expect(o.reported_task_claim).toMatchObject({ claim: "claimed_success", basis: "reported", evidence_ids: ["artifact:aa#L9"] });
  });
  it("legacy run (no recorded outcomes): legitimate_behavior_worked=true is NOT a task success; legacy verdict kept separately", () => {
    const legacy = planProjection(parsed(bundleA)).nodes.find((n) => n.primary === "VerificationRun" && n.id === base.id)!.props as Record<string, unknown>;
    expect(legacy.legitimate_behavior_worked).toBe(true);
    expect(legacy.outcome_origin).toBe("legacy");
    expect(legacy.task_outcome).toBe("unknown");
    // the fixture cites no evidence, so not even a security outcome is inferred, while the legacy verdict still says "prevented"
    expect(legacy.security_outcome).toBe("unknown");
    expect(outcomesFromNodeProps(legacy).task_outcome.value).toBe("unknown");
    // a node projected before issue 4 (no outcome props) also never yields task success
    const { task_outcome: _t, security_outcome: _s, ...old } = legacy;
    expect(outcomesFromNodeProps(old).task_outcome.value).toBe("unknown");
  });
});

describe("config + degradation (no Neo4j needed)", () => {
  it("parses env files", () => {
    expect(parseEnvFile("# c\nNEO4J_URI=bolt://x:1\nexport NEO4J_USER='u'\n")).toEqual({ NEO4J_URI: "bolt://x:1", NEO4J_USER: "u" });
  });
  it("reports missing config without throwing", async () => {
    const r = loadGraphConfig({ env: {}, envFile: "/nonexistent/.env.neo4j" });
    expect(r.ok).toBe(false);
    const g = new GraphClient({ env: { KW_NEO4J_ENV_FILE: "/nonexistent/.env.neo4j" } });
    const h = await g.health();
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.error.kind).toBe("not_configured");
    const s = await g.componentStatus();
    expect(s.status).toBe("not_configured");
    await g.close();
  });
  it("returns graph_unavailable for an unreachable server and never leaks the password", async () => {
    const secret = "kw-unit-test-not-a-real-password";
    const g = new GraphClient({ config: { uri: "bolt://127.0.0.1:1", user: "neo4j", password: secret, database: "neo4j", configuredVia: "test" }, connectionTimeoutMs: 500 });
    const h = await g.health();
    expect(h.ok).toBe(false);
    if (!h.ok) {
      expect(h.error.kind).toBe("graph_unavailable");
      expect(h.error.message).not.toContain(secret);
    }
    const q = await g.read("RETURN 1 AS x", {}, (r) => r.get("x"));
    expect(q.ok).toBe(false);
    await g.close();
    const closed = await g.health();
    expect(!closed.ok && closed.error.kind).toBe("graph_unavailable");
  });
  it("picks Cypher 25 only from 2025.06 on", () => {
    expect(cypherVersionFor("5.26.32")).toBe("5");
    expect(cypherVersionFor("2025.05.0")).toBe("5");
    expect(cypherVersionFor("2025.06.0")).toBe("25");
    expect(cypherVersionFor("2025.10.1")).toBe("25");
    expect(cypherVersionFor("2026.09.0")).toBe("25");
    expect(cypherVersionFor(null)).toBe("5");
  });
  it("keeps server-classified statement errors as query_failed even if the text mentions connect", () => {
    const e = Object.assign(new Error("Node already exists with event_type = 'network_connect'"), { code: "Neo.ClientError.Schema.ConstraintValidationFailed" });
    expect(classifyError(e, null).kind).toBe("query_failed");
    expect(classifyError(Object.assign(new Error("x"), { code: "Neo.ClientError.Security.Unauthorized" }), null).kind).toBe("auth_failed");
    expect(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:1"), null).kind).toBe("graph_unavailable");
  });
  it("redacts secrets in classified errors", () => {
    expect(classifyError(new Error("bad pw s3cr3t here"), "s3cr3t").message).toBe("bad pw [redacted] here");
  });
  it("generates idempotent DDL for every node label", () => {
    const ddl = constraintStatements();
    expect(ddl.every((s) => s.includes("IF NOT EXISTS"))).toBe(true);
    expect(ddl.filter((s) => s.includes("REQUIRE n.id IS UNIQUE"))).toHaveLength(14);
  });
});
