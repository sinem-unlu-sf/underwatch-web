import { describe, expect, it } from "vitest";
import { analyzeRun, canonicalJson } from "../src/index";
import { agentExec, ev, makeCoverage, makeRun, reportedCall } from "./builders";
import { POLICY } from "./scenarios";

/** Regression tests added in review. Synthetic data only. */
describe("review fixes", () => {
  it("does not overflow the call stack on large runs (no Math.max spread over all events)", () => {
    const events = [agentExec(0)];
    for (let i = 0; i < 150_000; i++) events.push(ev({ source: "claude_code_transcript", type: "agent_message", at: 1 + (i % 50_000), key: `msg:${i}` }));
    const r = analyzeRun({ run: makeRun({ ended_at: null }), events, policy: POLICY, coverage: makeCoverage() });
    expect(r.accounting.input_events).toBe(150_001);
  }, 60_000);

  it("excludes records whose basis contradicts their source (agent channel cannot pose as observation)", () => {
    const forged = { ...ev({ source: "claude_code_transcript", type: "file_open", at: 50, pid: 100, ppid: 10, name: "claude", target: "/workspace/.env" }), basis: "observed" as const };
    const r = analyzeRun({ run: makeRun(), events: [agentExec(0), forged], policy: POLICY, coverage: makeCoverage() });
    expect(r.findings).toEqual([]);
    expect(r.observations.some((o) => o.constituents.includes(forged.id))).toBe(false);
    expect(r.unprocessed.map((u) => u.event_id)).toContain(forged.id);
    expect(r.diagnostics.some((d) => d.code === "basis_source_mismatch")).toBe(true);
  });

  it("a SIGKILL enforcement record without EACCES/EPERM is undetermined, never 'blocked'", () => {
    const open = ev({ source: "kernel_tracer", type: "file_open", at: 50, pid: 200, ppid: 100, name: "cat", target: "/workspace/.env", outcome: "blocked" });
    const events = [agentExec(0), ...reportedCall("toolu_k", "Bash", "cat .env", 40, 100), ev({ source: "kernel_tracer", type: "process_exec", at: 45, pid: 200, ppid: 100, name: "cat", target: "/usr/bin/cat" }), open];
    const killed = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage(), details: { [open.id]: { signal: "SIGKILL" } } });
    const dec = killed.decisions.find((d) => d.event_ids.includes(open.id))!;
    expect(dec.classification).toBe("undetermined");
    const eperm = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage(), details: { [open.id]: { signal: "SIGKILL", errno: "EPERM" } } });
    expect(eperm.decisions.find((d) => d.event_ids.includes(open.id))!.classification).toBe("violation_blocked");
  });

  it("runtime-process writes to behavior-changing ~/.claude files are not classified as housekeeping noise", () => {
    const mem = ev({ source: "kernel_tracer", type: "file_write", at: 50, pid: 100, ppid: 10, name: "claude", target: "/home/agent/.claude/CLAUDE.md" });
    const agent = ev({ source: "kernel_tracer", type: "file_write", at: 51, pid: 100, ppid: 10, name: "claude", target: "/home/agent/.claude/agents/x.md" });
    const transcript = ev({ source: "kernel_tracer", type: "file_write", at: 52, pid: 100, ppid: 10, name: "claude", target: "/home/agent/.claude/projects/p/s.jsonl" });
    const r = analyzeRun({ run: makeRun(), events: [agentExec(0), mem, agent, transcript], policy: POLICY, coverage: makeCoverage() });
    const suppressed = new Set(r.suppressed.map((s) => s.event_id));
    expect(suppressed.has(transcript.id)).toBe(true);
    expect(suppressed.has(mem.id)).toBe(false);
    expect(suppressed.has(agent.id)).toBe(false);
    const flagged = new Set(r.findings.flatMap((f) => f.related_event_ids));
    expect(flagged.has(mem.id) && flagged.has(agent.id)).toBe(true);
  });

  it("a persisted change written by a subprocess of a Bash command that never names the file is a change mismatch (not silence)", () => {
    const mk = (cmd: string) => {
      const write = ev({ source: "kernel_tracer", type: "file_write", at: 60, pid: 302, ppid: 301, name: "python3", target: "/workspace/src/config.py" });
      const events = [
        agentExec(0),
        ...reportedCall("toolu_mk", "Bash", cmd, 40, 100),
        ev({ source: "kernel_tracer", type: "process_exec", at: 45, pid: 301, ppid: 100, name: "bash", target: "/bin/bash" }),
        ev({ source: "kernel_tracer", type: "process_exec", at: 50, pid: 302, ppid: 301, name: "python3", target: "/usr/bin/python3" }),
        write,
        ev({ source: "git_observer", type: "repo_change", at: 200, target: "src/config.py" }),
      ];
      return { r: analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage(), context: { workspaceRoot: "/workspace" } }), write };
    };
    const { r, write } = mk("make test");
    const f = r.findings.find((x) => x.related_event_ids.includes(write.id));
    expect(f?.category).toBe("change_mismatch");
    expect(f?.confidence).not.toBe("high"); // command semantics are not visible: capped at medium
    expect(mk("python tools/fmt.py src/config.py").r.findings.filter((x) => x.category === "change_mismatch")).toEqual([]);
  });

  it("indexed duplicate-collector merge gives the same result as before for interleaved resources", () => {
    const events = [agentExec(0)];
    for (let i = 0; i < 40; i++) {
      events.push(ev({ source: "kernel_tracer", type: "file_open", at: 10 + i, pid: 100, ppid: 10, name: "claude", target: `/workspace/src/f${i % 5}.ts` }));
      events.push(ev({ source: "file_watcher", type: "file_open", at: 10 + i, target: `/workspace/src/f${i % 5}.ts` }));
    }
    const r = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage() });
    // each kernel record pairs with exactly one watcher record at the same instant
    expect(r.observations.filter((o) => o.kind === "file.read").length).toBe(40);
    expect(r.observations.every((o) => o.kind !== "file.read" || o.constituents.length === 2)).toBe(true);
    expect(canonicalJson(r)).toBe(canonicalJson(analyzeRun({ run: makeRun(), events: [...events].reverse(), policy: POLICY, coverage: makeCoverage() })));
  });
});

describe("graceful degradation on malformed collector details", () => {
  it("a non-integer numeric detail is ignored with a diagnostic instead of throwing", () => {
    const c = ev({ source: "network_proxy", type: "network_connect", at: 50, target: "registry.npmjs.org:443", outcome: "allowed" });
    const r = analyzeRun({ run: makeRun(), events: [agentExec(0), c], policy: POLICY, coverage: makeCoverage(), details: { [c.id]: { bytes_up: 1.5, port: Number.NaN } } });
    expect(r.diagnostics.filter((d) => d.code === "invalid_detail").length).toBe(2);
  });
});
