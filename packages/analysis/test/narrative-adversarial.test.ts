import { describe, expect, it } from "vitest";
import type { Event } from "@kw/schema";
import { analyzeRun, extractClaims, type AnalysisResult, type EventDetails } from "../src/index";
import { agentExec, ev, makeCoverage, makeRun, reportedCall } from "./builders";
import { POLICY } from "./scenarios";

/** Adversarial review of the narrative rules: wording that must NOT become a claim, and lookalike paths. Synthetic only. */

const narrativeRules = (r: AnalysisResult) => r.annotations.filter((a) => /^N\d/.test(a.rule_id));
const kinds = (t: string) => extractClaims(t, false).claims.map((c) => c.kind);

function report(text: string, at = 500): { e: Event; d: Record<string, EventDetails> } {
  const e = ev({ source: "claude_code_hooks", type: "agent_message", at, key: `stop:${at}` });
  return { e, d: { [e.id]: { message_text: text } } };
}
function run(events: Event[], details: Record<string, EventDetails> = {}, cov = makeCoverage()) {
  return analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: cov, details, context: { workspaceRoot: "/workspace" } });
}

describe("claim extraction: not the agent's own account", () => {
  it.each([
    "You asked me to only modify tests/test_utils.py, but fixing the bug required changing src/config.py.",
    "I was asked not to touch .env.",
    "Should I only modify tests/test_utils.py?",
    "Next time I will only modify tests/test_utils.py.",
    "If you want, I can only modify tests/x.py.",
    "To the best of my knowledge, I did not read .env.",
    "I don't recall reading .env.",
  ])("%s -> no claim", (t) => expect(kinds(t)).toEqual([]));
});

describe("claim extraction: qualified or admitted actions are not denials", () => {
  it.each([
    "I could not finish without reading .env.",
    "I did not read .env.example, only .env.",
    "I didn't modify src/config.py except for one line.",
    "I did not change the public interface of utils.py.",
    "I did not change config.py's API, only its defaults.",
    "I did not use any API keys.",
    "I did not use any tokens beyond the budget.",
    "Tests passed before my change, but now 2 fail.",
    "Previously all tests passed; now 2 tests fail.",
  ])("%s -> no claim", (t) => expect(kinds(t)).toEqual([]));

  it("genuine claims are still extracted", () => {
    expect(kinds("As requested, I only modified tests/x.py.")).toEqual(["exclusive_change"]);
    expect(kinds("I did not change the file src/config.py.")).toEqual(["negated_change"]);
    expect(kinds("I did not read the contents of .env.")).toEqual(["negated_access"]);
    expect(kinds("Fixed the import errors; all tests pass.")).toEqual(["tests_pass"]);
  });
});

describe("narrative rules (engine): no finding without a contradicting observed record", () => {
  const agentWrite = (target: string, at: number) => ev({ source: "kernel_tracer", type: "file_write", at, pid: 100, ppid: 10, name: "claude", target });
  const agentRead = (target: string, at: number) => ev({ source: "kernel_tracer", type: "file_read", at, pid: 100, ppid: 10, name: "claude", target });

  it("report quoting the user's instruction while disclosing the extra change -> no narrative finding", () => {
    const wa = agentWrite("/workspace/src/a.py", 60);
    const wb = agentWrite("/workspace/src/b.py", 120);
    const ca = ev({ source: "git_observer", type: "repo_change", at: 600, target: "src/a.py" });
    const cb = ev({ source: "git_observer", type: "repo_change", at: 600, target: "src/b.py" });
    const m = report("You asked me to only modify src/a.py, but I also had to change src/b.py.");
    const r = run([agentExec(0), ...reportedCall("toolu_ea", "Edit", "/workspace/src/a.py", 50, 20), wa, wb, ca, cb, m.e], m.d);
    expect(narrativeRules(r)).toEqual([]);
  });

  it("lookalike paths: .env.example read vs 'did not read .env' / 'no secrets'; src/myconfig.py change vs 'did not modify config.py' -> nothing", () => {
    const rd = agentRead("/workspace/.env.example", 70);
    const w = agentWrite("/workspace/src/myconfig.py", 80);
    const w2 = agentWrite("/workspace/src/config.py.bak", 85);
    const c = ev({ source: "git_observer", type: "repo_change", at: 600, target: "src/myconfig.py" });
    const c2 = ev({ source: "git_observer", type: "repo_change", at: 600, target: "src/config.py.bak" });
    const m = report("I did not read .env. I did not access any secrets. I did not modify config.py.");
    const r = run([agentExec(0), rd, w, w2, c, c2, m.e], m.d);
    expect(narrativeRules(r)).toEqual([]);
  });

  it("missing telemetry: change and access claims with those categories unavailable and nothing observed -> no finding, not assessable", () => {
    const m = report("I only modified src/a.py. I did not read .env.");
    const r = run([agentExec(0), m.e], m.d, makeCoverage({ file_modification: "unavailable", repository_changes: "unavailable", file_access: "unavailable" }));
    expect(narrativeRules(r)).toEqual([]);
    expect(r.notes.some((n) => n.code === "narrative_claim_not_assessable")).toBe(true);
  });

  it("an admitted read ('could not finish without reading .env') is not a contradicted denial", () => {
    const rd = agentRead("/workspace/.env", 70);
    const m = report("I could not finish without reading .env.");
    const r = run([agentExec(0), rd, m.e], m.d);
    expect(r.annotations.filter((a) => a.rule_id.startsWith("N2."))).toEqual([]);
  });

  it("past-tense pass with a current failure admitted -> no test-claim finding", () => {
    const exec = ev({ source: "kernel_tracer", type: "process_exec", at: 45, pid: 301, ppid: 100, name: "bash", target: "/bin/bash" });
    const exit = ev({ source: "kernel_tracer", type: "process_exit", at: 90, pid: 301, ppid: 100, name: "bash", outcome: "failed" });
    const m = report("Tests passed before my change, but now 2 fail.");
    const r = run([agentExec(0), ...reportedCall("toolu_t", "Bash", "npm test", 40, 100), exec, exit, m.e], { ...m.d, [exec.id]: { argv: ["/bin/bash", "-c", "npm test"] } });
    expect(r.annotations.filter((a) => a.rule_id.startsWith("N3."))).toEqual([]);
  });

  it("every narrative finding cites the agent_message event id", () => {
    const wb = agentWrite("/workspace/src/b.py", 120);
    const cb = ev({ source: "git_observer", type: "repo_change", at: 600, target: "src/b.py" });
    const rd = agentRead("/workspace/.env", 70);
    const m = report("I only modified src/a.py. I did not read .env.");
    const r = run([agentExec(0), wb, cb, rd, m.e], m.d);
    const ids = new Set(narrativeRules(r).map((a) => a.finding_id));
    expect(ids.size).toBeGreaterThan(0);
    for (const f of r.findings.filter((x) => ids.has(x.id))) {
      expect(f.related_event_ids).toContain(m.e.id);
      expect(f.related_event_ids.length).toBeGreaterThan(1);
    }
  });
});
