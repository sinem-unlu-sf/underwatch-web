import { describe, expect, it } from "vitest";
import { EventCorrelation, Finding } from "@kw/schema";
import { analyzeRun, canonicalJson, inferWorkspaceRoot, type AnalysisResult } from "../src/index";
import { agentExec, ev, makeCoverage, makeRun, reportedCall } from "./builders";
import { POLICY, SCENARIOS, secretReadScenario, type Scenario } from "./scenarios";

function scenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id.startsWith(id));
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
}

function shuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let x = seed;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe("schema conformance", () => {
  it("every finding and schema correlation parses with @kw/schema", () => {
    for (const s of SCENARIOS) {
      const r = analyzeRun(s.input);
      for (const f of r.findings) {
        expect(() => Finding.parse(f), `${s.id}: ${f.title}`).not.toThrow();
        expect(f.status).toBe("new");
      }
      for (const c of r.schemaCorrelations) expect(() => EventCorrelation.parse(c)).not.toThrow();
    }
  });
});

describe("determinism", () => {
  it("same input in any order yields byte-identical output", () => {
    for (const s of SCENARIOS) {
      const a = canonicalJson(analyzeRun(s.input));
      const b = canonicalJson(analyzeRun({ ...s.input, events: shuffle(s.input.events, 7) }));
      const c = canonicalJson(analyzeRun({ ...s.input, events: shuffle(s.input.events, 1234) }));
      expect(b, s.id).toBe(a);
      expect(c, s.id).toBe(a);
      expect(JSON.stringify(analyzeRun(s.input))).toBe(JSON.stringify(analyzeRun(s.input)));
    }
  });

  it("finding ids are stable hashes of run id, category, sorted key event ids and ruleset version", () => {
    const s = scenario("s03");
    const r1 = analyzeRun(s.input);
    const r2 = analyzeRun({ ...s.input, rulesetVersion: "kw-rules@9.9.9" });
    expect(r1.findings.map((f) => f.id)).toEqual(analyzeRun(s.input).findings.map((f) => f.id));
    expect(r1.findings[0]!.id).not.toBe(r2.findings[0]!.id);
    expect(r1.findings[0]!.id).toMatch(/^fnd_[0-9a-f]{24}$/);
  });
});

describe("duplicate collectors", () => {
  it("merges the same open seen by kernel tracer and strace into one observation and one finding (link, never delete)", () => {
    const r = analyzeRun(scenario("s03").input);
    const envObs = r.observations.filter((o) => o.path?.resolved === "/workspace/.env");
    expect(envObs).toHaveLength(1);
    expect(envObs[0]!.constituents).toHaveLength(2);
    expect(envObs[0]!.sources).toEqual(["kernel_tracer", "process_tracer"]);
    const d4 = r.findings.filter((f) => f.category === "permission_violation");
    expect(d4).toHaveLength(1);
    for (const id of envObs[0]!.constituents) expect(d4[0]!.related_event_ids).toContain(id);
  });

  it("three collectors on the same read and two on the same write produce one finding", () => {
    const r = analyzeRun(scenario("s06").input);
    expect(r.findings).toHaveLength(1);
    const readme = r.observations.filter((o) => o.path?.resolved === "/workspace/README.md");
    expect(readme).toHaveLength(1);
    expect(readme[0]!.constituents).toHaveLength(3);
    expect(r.accounting.observed_in_observations).toBe(r.observations.reduce((n, o) => n + o.constituents.length, 0));
  });

  it("contradicting collectors are not merged; outcome becomes undetermined with a diagnostic", () => {
    const base = secretReadScenario("BX", "x", "succeeded", null, false).input;
    const contra = ev({ source: "process_tracer", type: "file_open", at: 1101, pid: 211, target: "/workspace/.env", outcome: "failed" });
    const r = analyzeRun({ ...base, events: [...base.events, contra], details: { ...base.details, [contra.id]: { errno: "EACCES" } } });
    expect(r.diagnostics.some((d) => d.code === "collector_disagreement")).toBe(true);
    const d4 = r.findings.filter((f) => f.category === "permission_violation");
    expect(d4).toHaveLength(1);
    expect(r.decisions.filter((d) => d.resource === "/workspace/.env").every((d) => d.classification === "undetermined")).toBe(true);
  });

  it("re-ingested records with the same event id are listed as unprocessed, not double counted", () => {
    const s = scenario("s03");
    const r = analyzeRun({ ...s.input, events: [...s.input.events, s.input.events[0]!] });
    expect(r.unprocessed.some((u) => u.reason.startsWith("duplicate event id"))).toBe(true);
    expect(r.findings.map((f) => f.id)).toEqual(analyzeRun(s.input).findings.map((f) => f.id));
  });
});

describe("missing telemetry", () => {
  it("coverage gap yields an undetermined decision and an uncertain finding, never a clean result", () => {
    const r = analyzeRun(scenario("s07").input);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.category).toBe("uncertain_correlation");
    expect(r.findings[0]!.confidence).toBe("low");
    expect(r.findings[0]!.missing_information.join(" ")).toMatch(/file_access is unavailable/);
    const dec = r.decisions.find((d) => d.subject === "reported_intent");
    expect(dec?.classification).toBe("undetermined");
    const cor = r.correlations.find((c) => c.tool_use_id === "toolu_R7");
    expect(cor?.state).toBe("unmatched_reported");
    expect(cor?.reason).toMatch(/coverage_gap/);
  });

  it("an observed denied action with no recorded return is undetermined, not safe", () => {
    const r = analyzeRun(scenario("s12").input);
    expect(r.decisions.find((d) => d.resource === "/workspace/.env")?.classification).toBe("undetermined");
    expect(r.findings[0]!.category).toBe("permission_violation");
  });

  it("without agent-side coverage, unmatched observations become a note instead of 'unreported' findings", () => {
    const s = scenario("s10");
    const r = analyzeRun({ ...s.input, coverage: makeCoverage({ tool_calls: "unavailable", agent_reported_actions: "unavailable", repository_changes: "unavailable" }) });
    expect(r.findings.filter((f) => f.category === "unreported_observed_action")).toHaveLength(0);
    expect(r.notes.some((n) => n.code === "agent_record_unavailable")).toBe(true);
    expect(r.notes.some((n) => n.code === "change_mismatch_not_assessable")).toBe(true);
  });

  it("no coverage report at all: findings state that coverage is unknown", () => {
    const s = scenario("s07");
    const r = analyzeRun({ ...s.input, coverage: null });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.missing_information[0]).toMatch(/coverage is unknown/);
  });
});

describe("policy classification", () => {
  it("allowed / violation_blocked / violation_completed / undetermined all occur and use observed outcomes", () => {
    const seen = new Set<string>();
    for (const s of SCENARIOS) for (const d of analyzeRun(s.input).decisions) seen.add(d.classification);
    for (const c of ["allowed", "violation_blocked", "violation_completed", "undetermined"]) expect(seen).toContain(c);
  });

  it("EACCES without a KW enforcement record is blocked by the environment, never 'blocked by Underwatch'", () => {
    const r = analyzeRun(scenario("s04").input);
    const d = r.decisions.find((x) => x.resource === "/workspace/.env")!;
    expect(d.classification).toBe("violation_blocked");
    expect(d.blocked_by).toBe("environment");
    expect(r.findings[0]!.title).not.toMatch(/blocked by Underwatch/);
    const r13 = analyzeRun(scenario("s13").input);
    expect(r13.decisions.find((x) => x.resource === "/workspace/package-lock.json")!.blocked_by).toBe("kw_enforcement");
  });

  it("proxy deny is blocked; explicit allow beats default deny; allowed sensitive access is a note", () => {
    const r14 = analyzeRun(scenario("s14").input);
    expect(r14.decisions.find((d) => d.resource.includes("telemetry"))!.blocked_by).toBe("proxy");
    const r1 = analyzeRun(scenario("s01").input);
    expect(r1.decisions.find((d) => d.resource === "api.anthropic.com")?.classification).toBe("allowed");
    const r5 = analyzeRun(scenario("s05").input);
    expect(r5.findings).toHaveLength(0);
    expect(r5.notes.some((n) => n.code === "sensitive_access_allowed")).toBe(true);
  });
});

describe("noise model", () => {
  it("suppressed events are returned with the rule that suppressed them; nothing is dropped", () => {
    const r = analyzeRun(scenario("s01").input);
    expect(r.findings).toHaveLength(0);
    const rules = new Set(r.suppressed.map((s) => s.rule_id));
    for (const id of ["NM-CC-HOUSEKEEPING", "NM-SHELL-STARTUP", "NM-DEPS-READ", "NM-RUNTIME-READ", "NM-MODEL-API-PROXY"]) expect(rules).toContain(id);
    for (const s of r.suppressed) expect(r.observations.some((o) => o.constituents.includes(s.event_id))).toBe(true);
    const a = r.accounting;
    expect(a.observed_in_observations + a.reported_in_calls + a.reported_context + a.collector_status + a.unprocessed).toBe(a.input_events);
  });

  it("noise never hides an explicit policy violation", () => {
    const r = analyzeRun(scenario("s15").input);
    expect(r.suppressed.some((s) => s.rule_id === "NM-CC-HOUSEKEEPING")).toBe(true);
    expect(r.findings.map((f) => f.category)).toEqual(["permission_violation"]);
  });

  it("the same housekeeping path written by a Bash subprocess is not noise", () => {
    const sh = ev({ source: "kernel_tracer", type: "process_exec", at: 1010, pid: 250, ppid: 100, name: "bash", key: "exec:250" });
    const w = ev({ source: "kernel_tracer", type: "file_write", at: 1100, pid: 250, target: "/home/agent/.claude/projects/p/s.jsonl" });
    const events = [agentExec(), ...reportedCall("toolu_N1", "Bash", "echo x >> log.txt", 1000, 1000, "succeeded", ["claude_code_hooks", "claude_code_transcript"]), sh, w];
    const r = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage(), details: { [sh.id]: { argv: ["bash", "-c", "echo x >> log.txt"] } } });
    expect(r.suppressed.some((s) => s.event_id === w.id)).toBe(false);
    expect(r.findings.some((f) => f.category === "unreported_observed_action" && f.related_event_ids.includes(w.id))).toBe(true);
  });
});

describe("correlation", () => {
  it("binds Bash subprocess trees by process ancestry and in-process reads by resource+time", () => {
    const r = analyzeRun(scenario("s01").input);
    const byTool = (id: string) => r.correlations.filter((c) => c.tool_use_id === id);
    expect(byTool("toolu_R1").find((c) => c.role === "primary_footprint")?.state).toBe("exact");
    expect(byTool("toolu_B1").find((c) => c.role === "primary_footprint")?.method).toBe("command_binding");
    expect(byTool("toolu_B1").some((c) => c.method === "process_ancestry")).toBe(true);
    expect(byTool("toolu_W1").find((c) => c.role === "primary_footprint")?.state).toBe("exact");
  });

  it("tool_use_id on an observed record gives an exact match", () => {
    const o = ev({ source: "sandbox_runtime", type: "file_open", at: 5000, pid: null, target: "/workspace/src/z.ts", toolUseId: "toolu_T1" });
    const events = [agentExec(), ...reportedCall("toolu_T1", "Read", "/workspace/src/z.ts", 1000, 50), o];
    const r = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage(), details: {} });
    expect(r.correlations.find((c) => c.tool_use_id === "toolu_T1")?.method).toBe("tool_use_id");
  });

  it("host paths are normalized to the container view before matching", () => {
    const o = ev({ source: "file_watcher", type: "file_open", at: 1010, pid: 100, target: "/var/lib/docker/volumes/kw-ws-1/_data/src/../src/a.ts" });
    const events = [agentExec(), ...reportedCall("toolu_P1", "Read", "/workspace/src/a.ts", 1000, 50), o];
    const r = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage(), context: { pathMappings: [{ hostPrefix: "/var/lib/docker/volumes/kw-ws-1/_data", containerPrefix: "/workspace" }] } });
    expect(r.observations.find((x) => x.constituents.includes(o.id))?.path?.resolved).toBe("/workspace/src/a.ts");
    expect(r.correlations.find((c) => c.tool_use_id === "toolu_P1")?.state).toBe("exact");
  });

  it("without argv (schema has none), a sole shell child in the call window binds as probable, never exact", () => {
    const sh = ev({ source: "process_tracer", type: "process_exec", at: 1040, pid: 400, ppid: 100, name: "bash", target: "/bin/bash" });
    const cat = ev({ source: "process_tracer", type: "process_exec", at: 1060, pid: 401, ppid: 400, name: "cat", target: "cat" });
    const events = [agentExec(), ...reportedCall("toolu_A1", "Bash", "cat README.md", 1000, 500, "succeeded", ["claude_code_hooks", "claude_code_transcript"]), sh, cat];
    const r = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage() });
    const shellAttr = r.attributions.find((a) => a.observationId === r.observations.find((o) => o.constituents.includes(sh.id))!.id)!;
    expect(shellAttr.state).toBe("probable");
    expect(shellAttr.candidates[0]!.features.A1_argv_unavailable).toBe(1);
    expect(r.findings).toHaveLength(0);
  });

  it("infers the repository root from repo-relative diff paths when the context does not give one", () => {
    expect(inferWorkspaceRoot(["src/a.py", "tests/t.py"], ["/workspace/demo/src/a.py", "/workspace/demo/tests/t.py", "/bin/bash"])).toEqual({ root: "/workspace/demo", support: 2 });
    expect(inferWorkspaceRoot(["src/a.py"], ["/bin/bash"])).toBeNull();
    const w = ev({ source: "kernel_tracer", type: "file_write", at: 2000, pid: 100, target: "/workspace/demo/src/a.py" });
    const g = ev({ source: "git_observer", type: "repo_change", at: 9000, target: "src/a.py" });
    const events = [agentExec(), ...reportedCall("toolu_E1", "Edit", "/workspace/demo/src/a.py", 1990, 50, "succeeded", ["claude_code_hooks", "claude_code_transcript"]), w, g];
    const inferred = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage() });
    expect(inferred.findings).toHaveLength(0);
    expect(inferred.notes.some((n) => n.code === "workspace_root_inferred")).toBe(true);
    const explicit = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage(), context: { workspaceRoot: "/workspace" } });
    expect(explicit.findings.map((f) => f.category).sort()).toEqual(["change_mismatch", "change_mismatch"]);
  });

  it("ambiguous attribution that does not change any conclusion is a note, not an extra finding", () => {
    const r = analyzeRun(scenario("s14").input);
    expect(r.findings).toHaveLength(1);
    expect(r.attributions.find((a) => a.state === "ambiguous")).toBeDefined();
    expect(r.notes.some((n) => n.code === "attribution_alternatives")).toBe(true);
  });

  it("all five match states occur across scenarios", () => {
    const states = new Set<string>();
    for (const s of SCENARIOS) for (const c of analyzeRun(s.input).correlations) states.add(c.state);
    const extra = analyzeRun(scenario("s14").input);
    for (const c of extra.correlations) states.add(c.state);
    // probable: in-process read observed only via stream fallback timing (skew window)
    const late = ev({ source: "kernel_tracer", type: "file_open", at: 1700, pid: 100, target: "/workspace/src/q.ts" });
    const r = analyzeRun({ run: makeRun(), events: [agentExec(), ...reportedCall("toolu_Q", "Read", "/workspace/src/q.ts", 1000, 50), late], policy: POLICY, coverage: makeCoverage() });
    for (const c of r.correlations) states.add(c.state);
    expect([...states].sort()).toEqual(["ambiguous", "exact", "probable", "unmatched_observed", "unmatched_reported"]);
  });
});

describe("discrepancy categories", () => {
  const cats = (r: AnalysisResult) => r.findings.map((f) => f.category).sort();
  it("one finding per underlying action with secondary categories in the description", () => {
    const r = analyzeRun(scenario("s02").input);
    expect(cats(r)).toEqual(["permission_violation", "unreported_observed_action"]);
    const net = r.findings.find((f) => f.category === "permission_violation")!;
    expect(net.description).toMatch(/Also: Unreported observed action/);
    expect(r.annotations.find((a) => a.finding_id === net.id)!.secondary.map((s) => s.rule_id)).toContain("D1.out_of_scope@1");
  });
  it("change mismatch merges with the unreported write on the same path", () => {
    const r = analyzeRun(scenario("s10").input);
    expect(cats(r)).toEqual(["change_mismatch"]);
  });
  it("outcome mismatch both directions", () => {
    expect(cats(analyzeRun(scenario("s08").input))).toEqual(["outcome_mismatch"]);
    const r9 = analyzeRun(scenario("s09").input);
    expect(cats(r9)).toEqual(["outcome_mismatch"]);
    expect(r9.annotations[0]!.severity_basis).toMatch(/agent-layer denial did not hold/);
  });
  it("titles never call anything malicious", () => {
    for (const s of SCENARIOS) for (const f of analyzeRun(s.input).findings) expect(`${f.title} ${f.description}`).not.toMatch(/malicious/i);
  });
});
