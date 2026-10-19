import { describe, expect, it } from "vitest";
import { analyzeRun, claudeCodeEvalPayload } from "../src/index";
import { agentExec, ev, makeCoverage, makeRun, reportedCall, type Details } from "./builders";
import { POLICY } from "./scenarios";

/**
 * Regression tests for false positives seen when the first REAL Tetragon captures of Claude Code 2.1.302
 * (kw-agent:2.1.302, 2026-10-17) were analyzed as supervised runs: the agent runtime's own hook processes, shell
 * snapshot, bundled ripgrep, git context and atomic-write temp files were reported as "unreported observed actions".
 * Event shapes mirror the real capture (pids, argv, paths); the data is synthetic.
 */
const HOOK = "node /opt/kw/kw-hook.mjs";
const CC = "/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
const ctx = { workspaceRoot: "/workspace", agentPids: [100], kwInstrumentationCommands: [HOOK] };
const unreported = (r: ReturnType<typeof analyzeRun>) => r.findings.filter((f) => f.category === "unreported_observed_action" || f.category === "uncertain_correlation");

function exec(at: number, pid: number, ppid: number, argv: string[], d: Details) {
  const e = ev({ source: "kernel_tracer", type: "process_exec", at, pid, ppid, name: argv[0]!, target: argv[0]! });
  d[e.id] = { argv };
  return e;
}

describe("kernel runtime noise (real Claude Code 2.1.302 process shapes)", () => {
  it("the registered hook command spawned by the agent root is KW instrumentation; the same command from a Bash call is not", () => {
    const d: Details = {};
    const events = [
      agentExec(0),
      exec(10, 201, 100, ["/bin/sh", "-c", HOOK], d),
      exec(11, 202, 201, ["/usr/local/bin/node", "/opt/kw/kw-hook.mjs"], d),
      ev({ source: "kernel_tracer", type: "file_write", at: 12, pid: 202, ppid: 201, name: "node", target: "/kw-hooks/hooks.ndjson" }),
    ];
    const r = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage(), details: d, context: ctx });
    expect(unreported(r)).toEqual([]);
    expect(r.attributions.filter((a) => a.scope === "kw_instrumentation").length).toBeGreaterThan(0);

    // Agent runs the same command line through its Bash tool: a bash tool shell sits between root and node.
    const d2: Details = {};
    const ev2 = [
      agentExec(0),
      ...reportedCall("toolu_hookspoof", "Bash", HOOK, 20, 50),
      exec(25, 301, 100, ["/bin/bash", "-c", `source /home/agent/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && eval '${HOOK}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`], d2),
      exec(26, 302, 301, ["/usr/local/bin/node", "/opt/kw/kw-hook.mjs"], d2),
    ];
    const r2 = analyzeRun({ run: makeRun(), events: ev2, policy: POLICY, coverage: makeCoverage(), details: d2, context: ctx });
    expect(r2.attributions.some((a) => a.scope === "kw_instrumentation")).toBe(false);
    expect(r2.attributions.filter((a) => a.scope === "tool_call").every((a) => a.toolUseId === "toolu_hookspoof")).toBe(true);
  });

  it("Claude Code's Bash wrapper (`source <snapshot> && eval '<cmd>'`) binds to the reported call, including '\"'\"' escaping", () => {
    expect(claudeCodeEvalPayload(`source /s.sh 2>/dev/null || true && eval 'grep -n "X" .env | sed -E '"'"'s/=.*//'"'"'' < /dev/null && pwd -P >| /tmp/claude-bc99-cwd`)).toBe(
      `grep -n "X" .env | sed -E 's/=.*//'`,
    );
    const d: Details = {};
    const cmd = `grep -n "X" README.md | sed -E 's/a/b/'`;
    const events = [
      agentExec(0),
      ...reportedCall("toolu_wrap", "Bash", cmd, 20, 50),
      exec(25, 301, 100, ["/bin/bash", "-c", `source /home/agent/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && eval '${cmd.replace(/'/g, `'"'"'`)}' < /dev/null && pwd -P >| /tmp/claude-1-cwd`], d),
    ];
    const r = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage(), details: d, context: ctx });
    const a = r.attributions.find((x) => x.scope === "tool_call")!;
    expect(a.toolUseId).toBe("toolu_wrap");
    expect(["exact", "probable"]).toContain(a.state);
    expect(unreported(r)).toEqual([]);
  });

  it("runtime context work is noise: git with global -c/-C options, bundled claude.exe, shell snapshot subtree, config reads", () => {
    const d: Details = {};
    const events = [
      agentExec(0),
      exec(5, 401, 100, ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-C", "/workspace", "ls-files", "--error-unmatch", "--", ":(icase).claude/settings.local.json"], d),
      exec(6, 402, 100, [CC, "--version"], d),
      exec(7, 403, 100, [CC, "--no-config", "--files", "--hidden", "/workspace"], d),
      exec(8, 404, 100, ["/bin/bash", "-c", "env"], d),
      exec(9, 405, 100, ["/bin/bash", "-c", "-l", "SNAPSHOT_FILE=/home/agent/.claude/shell-snapshots/snapshot-bash-1.sh\n source ~/.bashrc"], d),
      exec(10, 406, 405, ["/usr/bin/sed", "s/^alias //g"], d),
      ev({ source: "kernel_tracer", type: "file_write", at: 11, pid: 406, ppid: 405, name: "/usr/bin/sed", target: "/home/agent/.claude/shell-snapshots/snapshot-bash-1.sh" }),
      ev({ source: "kernel_tracer", type: "file_open", at: 12, pid: 100, ppid: 10, name: "claude", target: "/etc/claude-code/managed-settings.json" }),
      ev({ source: "kernel_tracer", type: "file_open", at: 13, pid: 100, ppid: 10, name: "claude", target: "/workspace/CLAUDE.md" }),
      ev({ source: "kernel_tracer", type: "file_open", at: 14, pid: 100, ppid: 10, name: "claude", target: "/home/agent" }),
    ];
    const r = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage(), details: d, context: ctx });
    expect(unreported(r)).toEqual([]);
    const rules = new Set(r.suppressed.map((s) => s.rule_id));
    for (const id of ["NM-CC-GIT-CONTEXT", "NM-CC-BUNDLED-TOOL", "NM-CC-SHELL-SNAPSHOT", "NM-CC-CONFIG-READ"]) expect(rules.has(id)).toBe(true);

    // ...but the snapshot subtree writing OUTSIDE the snapshot dir, or a git write subcommand, stays visible.
    const d2: Details = {};
    const ev2 = [
      agentExec(0),
      exec(9, 405, 100, ["/bin/bash", "-c", "-l", "SNAPSHOT_FILE=/home/agent/.claude/shell-snapshots/snapshot-bash-1.sh\n source ~/.bashrc"], d2),
      ev({ source: "kernel_tracer", type: "file_write", at: 11, pid: 405, ppid: 100, name: "/bin/bash", target: "/home/agent/.bashrc" }),
      exec(12, 407, 100, ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "push", "origin"], d2),
    ];
    const r2 = analyzeRun({ run: makeRun(), events: ev2, policy: POLICY, coverage: makeCoverage(), details: d2, context: ctx });
    const titles = r2.findings.map((f) => f.title).join("\n");
    expect(titles).toMatch(/\.bashrc/);
    expect(titles).toMatch(/git .*push/);
  });

  it("Edit's atomic-write temp sibling (<file>.tmp.<pid>.<hex>) is attributed to the Edit call", () => {
    const tmp = ev({ source: "kernel_tracer", type: "file_write", at: 30, pid: 100, ppid: 10, name: "claude", target: "/workspace/README.md.tmp.7.3fa4b8ecfa25" });
    const events = [agentExec(0), ...reportedCall("toolu_edit", "Edit", "/workspace/README.md", 20, 50), tmp];
    const r = analyzeRun({ run: makeRun(), events, policy: POLICY, coverage: makeCoverage(), context: ctx });
    expect(r.attributions.find((a) => a.observationId && r.observations.find((o) => o.id === a.observationId)?.constituents.includes(tmp.id))?.toolUseId).toBe("toolu_edit");
    expect(unreported(r)).toEqual([]);
    // A random sibling that does not follow the exact pattern is not absorbed.
    const odd = ev({ source: "kernel_tracer", type: "file_write", at: 31, pid: 100, ppid: 10, name: "claude", target: "/workspace/README.md.bak" });
    const r2 = analyzeRun({ run: makeRun(), events: [...events, odd], policy: POLICY, coverage: makeCoverage(), context: ctx });
    expect(r2.findings.some((f) => f.title.includes("README.md.bak"))).toBe(true);
  });
});
