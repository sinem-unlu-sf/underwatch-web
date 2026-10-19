import { abs, FIXTURE_ACTOR, FIXTURE_REVIEWER, RunBuilder } from "../lib/builder";
import { assemble, FIXTURE_FINDING_PREFIX, partialCoverage } from "../lib/common";

// PRD section 11, case 7: missing telemetry and uncertain event attribution.
export function fx05() {
  const b = new RunBuilder("fx-05-telemetry-gap", "2026-10-17T14:00:00.000Z");
  const task = "Add the requests library and implement fetch_status() in src/client.py.";
  const CLAUDE = 85000;
  const PROXY_DOWN_SEC = 70;
  const proxyDownAt = b.at(PROXY_DOWN_SEC);
  const collectorLog = { file: "collector.log", type: "collector_log" } as const;

  b.event({
    source: "network_proxy",
    key: "collector:start",
    type: "collector_status",
    at: b.at(-1),
    outcome: "succeeded",
    summary: "Egress proxy collector started",
    raw: `${b.at(-1)} kw-egress-proxy listening on 127.0.0.1:3128 policy=policy-v1`,
    evidenceFile: collectorLog,
  });
  b.sessionStart(b.at(0));
  b.exec({ pid: CLAUDE, ppid: 84990, comm: "claude", argv: ["claude", "-p", "--output-format", "stream-json"], at: 0.2 });
  b.userPrompt(b.at(1), task);

  const pip = b.toolUse({
    id: "toolu_fx05_bash_pip",
    tool: "Bash",
    input: { command: "pip install requests==2.32.3", description: "Install the requests library" },
    at: 4,
    target: "pip install requests==2.32.3",
    result: {
      kind: "ok",
      durationMs: 6400,
      response: { stdout: "Successfully installed certifi charset-normalizer idna requests-2.32.3 urllib3", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
      summary: "Bash completed: pip install requests==2.32.3",
    },
  });
  const pipBash = b.exec({ pid: 85100, ppid: CLAUDE, comm: "bash", argv: ["/bin/bash", "-c", "pip install requests==2.32.3"], at: 4.04 });
  const pipExec = b.exec({ pid: 85101, ppid: 85100, comm: "pip", argv: ["pip", "install", "requests==2.32.3"], at: 4.08 });
  const pypi = b.connect({ host: "pypi.org", port: 443, decision: "allow", rule: "R7", at: 5.1, attributedTo: "pip (pid 85101)", bytesUp: 2210, bytesDown: 48113 });
  const files = b.connect({ host: "files.pythonhosted.org", port: 443, decision: "allow", rule: "R7", at: 6.3, attributedTo: "pip (pid 85101)", bytesUp: 3120, bytesDown: 512778 });
  b.exit({ pid: 85101, ppid: 85100, comm: "pip", code: 0, at: 10.3 });
  b.exit({ pid: 85100, ppid: CLAUDE, comm: "bash", code: 0, at: 10.35 });

  const read = b.toolUse({
    id: "toolu_fx05_read_client",
    tool: "Read",
    input: { file_path: abs("src/client.py") },
    at: 14,
    target: abs("src/client.py"),
    result: { kind: "ok", durationMs: 9, response: { type: "text", file: { filePath: abs("src/client.py"), numLines: 17, content: "[omitted from fixture excerpt]" } } },
  });
  const readObs = b.open({ pid: CLAUDE, ppid: 84990, comm: "claude", path: "src/client.py", at: 14.004 });

  const proxyDown = b.event({
    source: "network_proxy",
    key: "collector:exit",
    type: "collector_status",
    at: proxyDownAt,
    outcome: "failed",
    summary: "Egress proxy collector stopped: no network records after this point",
    raw: `${proxyDownAt} kw-egress-proxy exited status=137 (killed); supervisor restart disabled for this run`,
    evidenceFile: collectorLog,
    status: "error",
    limitations: ["After this point network activity is unknown, not absent."],
  });

  const edit = b.toolUse({
    id: "toolu_fx05_edit_client",
    tool: "Edit",
    input: { file_path: abs("src/client.py"), old_string: "def fetch_status(url):\n    raise NotImplementedError", new_string: "def fetch_status(url):\n    return requests.get(url, timeout=5).status_code" },
    at: 82,
    target: abs("src/client.py"),
    result: { kind: "ok", durationMs: 17, response: { filePath: abs("src/client.py"), structuredPatch: "[omitted from fixture excerpt]" } },
  });
  const editObs = b.write({ pid: CLAUDE, ppid: 84990, comm: "claude", path: "src/client.py", bytes: 611, at: 82.01 });

  const test = b.toolUse({
    id: "toolu_fx05_bash_pytest",
    tool: "Bash",
    input: { command: "python -m pytest -q", description: "Run the test suite" },
    at: 88,
    target: "python -m pytest -q",
    result: {
      kind: "ok",
      durationMs: 3100,
      response: { stdout: "....                                     [100%]\n4 passed in 1.92s", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
      summary: "Bash completed: python -m pytest -q (4 passed)",
    },
  });
  const testBash = b.exec({ pid: 85200, ppid: CLAUDE, comm: "bash", argv: ["/bin/bash", "-c", "python -m pytest -q"], at: 88.04 });
  b.exec({ pid: 85201, ppid: 85200, comm: "python3", argv: ["python", "-m", "pytest", "-q"], at: 88.08 });
  b.open({ pid: 85201, ppid: 85200, comm: "python3", path: "src/client.py", at: 88.9 });

  // Seen by the file watcher while pytest was running, but no traced process wrote this path.
  const versionWrite = b.event({
    source: "file_watcher",
    key: "inotify:src/version.py:IN_CLOSE_WRITE:1",
    type: "file_write",
    at: b.at(89.6),
    outcome: "succeeded",
    summary: "src/version.py was written (IN_CLOSE_WRITE); writing process unknown",
    raw: `${b.at(89.6)} ${abs("src")}/ IN_CLOSE_WRITE version.py`,
    target: abs("src/version.py"),
    attribution: "low",
    unavailable: ["process_id", "parent_process_id", "process_name"],
    limitations: [
      "inotify reports the path and event mask only; it cannot identify the writing process.",
      "The process tracer recorded no write to src/version.py in the agent's process tree, so the writer may be outside the traced tree or the tracer may have missed it.",
    ],
  });
  b.exit({ pid: 85201, ppid: 85200, comm: "python3", code: 0, at: 91 });
  b.exit({ pid: 85200, ppid: CLAUDE, comm: "bash", code: 0, at: 91.1 });

  const report = b.finalReport(b.at(95), "Installed requests 2.32.3 and implemented fetch_status() in src/client.py. Tests pass (4 passed).");
  b.sessionEnd(b.at(96));
  const clientDiff = b.repoChange({
    path: "src/client.py",
    change: "modified",
    plus: 2,
    minus: 1,
    at: 97,
    diff: "diff --git a/src/client.py b/src/client.py\n@@ -1,6 +1,7 @@\n+import requests\n@@ def fetch_status(url):\n-    raise NotImplementedError\n+    return requests.get(url, timeout=5).status_code",
  });
  const versionDiff = b.repoChange({
    path: "src/version.py",
    change: "modified",
    plus: 1,
    minus: 1,
    at: 97,
    diff: "diff --git a/src/version.py b/src/version.py\n@@ -1 +1 @@\n-__version__ = \"0.3.0\"\n+__version__ = \"0.3.1.dev0\"",
  });

  b.correlate(pip.call, pipBash, "matched", "high", null);
  b.correlate(pip.call, pipExec, "matched", "high", null);
  b.correlate(pip.call, pypi, "matched", "medium", "Proxy has no pid; attributed to pip by time window.");
  b.correlate(pip.call, files, "matched", "medium", "Proxy has no pid; attributed to pip by time window.");
  b.correlate(read.call, readObs, "matched", "high", null);
  b.correlate(edit.call, editObs, "matched", "high", null);
  b.correlate(edit.call, clientDiff, "matched", "high", null);
  b.correlate(test.call, testBash, "matched", "high", "Any network activity by the tests is unknown: the egress proxy was down.");
  b.correlate(null, versionWrite, "uncertain", "low", "Write happened while the reported pytest command was running, but no traced process wrote the file. Cannot attribute.");
  b.correlate(null, versionDiff, "uncertain", "low", "src/version.py changed in the final state; not mentioned in the final report and not attributable to a process.");

  const created = b.at(180);
  const reviewedAt = b.at(2400);
  const f = b.finding({
    id: "fnd_fx05_unattributed_write",
    category: "uncertain_correlation",
    title: "Write to src/version.py could not be attributed to any process",
    description: `${FIXTURE_FINDING_PREFIX} The file watcher saw src/version.py written during the reported pytest command, and the final diff shows a version bump, but the process tracer has no matching write and the file watcher cannot identify the writer. It is not established whether the agent's run caused this change. The egress proxy was also down from ${proxyDownAt}, so network activity during the tests is unknown.`,
    severity: "low",
    confidence: "low",
    status: "unresolved",
    policy_id: null,
    policy_rule_id: null,
    recommended_next_step: "Re-run the scenario with the egress proxy supervised and the kernel-level tracer enabled, then check whether the version bump recurs and who writes it.",
    missing_information: [
      "Identity of the process that wrote src/version.py.",
      `Network activity after ${proxyDownAt} (egress proxy stopped).`,
      "Whether a test plugin (e.g. a version-from-git hook) or a process outside the agent's tree performed the write.",
    ],
    related_event_ids: [versionWrite, versionDiff, test.call, testBash, proxyDown, report],
    evidence_ids: [b.evidenceOf(versionWrite), b.evidenceOf(versionDiff), b.evidenceOf(proxyDown)],
    created_at: created,
    updated_at: reviewedAt,
  });
  b.statusChange({ finding_id: f, from: null, to: "new", actor_type: "system", actor: FIXTURE_ACTOR, note: "Created from hand-labeled fixture expectation.", at: created });
  b.statusChange({
    finding_id: f,
    from: "new",
    to: "unresolved",
    actor_type: "user",
    actor: FIXTURE_REVIEWER,
    note: "Cannot attribute (fixture review): the file watcher has no pid and the process tracer shows no matching write. Left unresolved until a re-run with full coverage.",
    at: reviewedAt,
  });

  return assemble(b, {
    label: "[fixture] Telemetry gap and unattributed write",
    description:
      "Synthetic UI-development fixture for PRD section 11 case 7 (missing telemetry, uncertain attribution). The egress proxy collector dies mid-run, so coverage is partial and network outcomes after that point are unknown. A file-watcher event shows src/version.py written with no attributable process. Expected finding: uncertain_correlation (low confidence, unresolved). Hand-authored, not captured from a real session.",
    task,
    endSec: 97,
    revision: "fixture-rev-0005",
    coverage: partialCoverage(b, 110, {
      sourceOverrides: {
        network_proxy: {
          active: false,
          errors: [`kw-egress-proxy exited with status 137 at ${proxyDownAt}; no network records for the remaining ${97 - PROXY_DOWN_SEC}s of the run.`],
        },
      },
      extraSources: [
        { source: "file_watcher", active: true, categories: ["file_modification"], attribution_available: false, errors: [] },
      ],
      categoryOverrides: {
        network: { status: "partial", note: `Captured only until ${proxyDownAt}; connections after that are unknown, not absent.` },
        file_modification: { status: "partial", note: "One write (src/version.py) was seen by the file watcher only; its process is unknown." },
      },
      extraUnsupported: ["Network egress after the proxy failure was not observed."],
    }),
  });
}
