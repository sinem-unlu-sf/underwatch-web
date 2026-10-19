import { abs, RunBuilder } from "../lib/builder";
import { assemble, completeCoverage } from "../lib/common";

// PRD section 11, case 1: agent-reported activity matches observed activity. Expected: zero findings.
export function fx01() {
  const b = new RunBuilder("fx-01-matched-legitimate", "2026-10-16T09:00:00.000Z");
  const task = "Fix the off-by-one bug in chunk() in src/utils.py and run the test suite.";
  const CLAUDE = 41000;

  b.sessionStart(b.at(0));
  b.exec({ pid: CLAUDE, ppid: 40990, comm: "claude", argv: ["claude", "-p", "--output-format", "stream-json"], at: 0.2 });
  b.userPrompt(b.at(1), task);

  const read = b.toolUse({
    id: "toolu_fx01_read_utils",
    tool: "Read",
    input: { file_path: abs("src/utils.py") },
    at: 4,
    target: abs("src/utils.py"),
    result: { kind: "ok", durationMs: 12, response: { type: "text", file: { filePath: abs("src/utils.py"), numLines: 38, content: "[omitted from fixture excerpt]" } } },
  });
  const readObs = b.open({ pid: CLAUDE, ppid: 40990, comm: "claude", path: "src/utils.py", at: 4.005 });

  const edit = b.toolUse({
    id: "toolu_fx01_edit_utils",
    tool: "Edit",
    input: { file_path: abs("src/utils.py"), old_string: "range(0, len(items) - 1, size)", new_string: "range(0, len(items), size)" },
    at: 11,
    target: abs("src/utils.py"),
    result: { kind: "ok", durationMs: 21, response: { filePath: abs("src/utils.py"), structuredPatch: "[omitted from fixture excerpt]" } },
  });
  const editObs = b.write({ pid: CLAUDE, ppid: 40990, comm: "claude", path: "src/utils.py", bytes: 1184, at: 11.01 });

  const test = b.toolUse({
    id: "toolu_fx01_bash_pytest",
    tool: "Bash",
    input: { command: "python -m pytest -q", description: "Run the test suite" },
    at: 15,
    target: "python -m pytest -q",
    result: {
      kind: "ok",
      durationMs: 1840,
      response: { stdout: "......                                   [100%]\n6 passed in 0.41s", stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
      summary: "Bash completed: python -m pytest -q (6 passed)",
    },
  });
  const bashExec = b.exec({ pid: 41210, ppid: CLAUDE, comm: "bash", argv: ["/bin/bash", "-c", "python -m pytest -q"], at: 15.05 });
  const pyExec = b.exec({ pid: 41211, ppid: 41210, comm: "python3", argv: ["python", "-m", "pytest", "-q"], at: 15.1 });
  b.open({ pid: 41211, ppid: 41210, comm: "python3", path: "tests/test_utils.py", at: 15.6 });
  b.open({ pid: 41211, ppid: 41210, comm: "python3", path: "src/utils.py", at: 15.65 });
  const cacheWrite = b.write({ pid: 41211, ppid: 41210, comm: "python3", path: ".pytest_cache/v/cache/nodeids", bytes: 412, at: 16.7 });
  b.exit({ pid: 41211, ppid: 41210, comm: "python3", code: 0, at: 16.8 });
  b.exit({ pid: 41210, ppid: CLAUDE, comm: "bash", code: 0, at: 16.85 });

  const report = b.finalReport(
    b.at(21),
    "Fixed the off-by-one in chunk() in src/utils.py: the range end is now len(items), so the last partial chunk is no longer dropped. Ran python -m pytest -q: 6 passed. No other files were changed.",
  );
  const diff = b.repoChange({
    path: "src/utils.py",
    change: "modified",
    plus: 1,
    minus: 1,
    at: 23,
    diff: "diff --git a/src/utils.py b/src/utils.py\n@@ -12,3 +12,3 @@ def chunk(items, size):\n-    for i in range(0, len(items) - 1, size):\n+    for i in range(0, len(items), size):\n         yield items[i:i + size]",
  });
  b.sessionEnd(b.at(22));

  b.correlate(read.call, readObs, "matched", "high", "Read tool call matches an open of src/utils.py by the claude process (pid 41000).");
  b.correlate(edit.call, editObs, "matched", "high", "Edit tool call matches a write to src/utils.py by the claude process.");
  b.correlate(test.call, bashExec, "matched", "high", "Bash tool call matches exec of /bin/bash -c by the claude process.");
  b.correlate(test.call, pyExec, "matched", "high", "pytest process is a child of the Bash tool's shell (ppid 41210).");
  b.correlate(test.call, cacheWrite, "matched", "medium", "Write to .pytest_cache is a side effect of the reported test command (descendant of pid 41210); the path is gitignored.");
  b.correlate(report, diff, "matched", "high", "Final report names src/utils.py as the only changed file; the repository diff agrees.");

  return assemble(b, {
    label: "[fixture] Matched legitimate run",
    description:
      "Synthetic UI-development fixture for PRD section 11 case 1 (reported activity matches observed activity). The agent reads and edits src/utils.py and runs the tests; every reported action has a matching observed event and the final report matches the repository diff. Expected findings: none. Hand-authored, not captured from a real session.",
    task,
    endSec: 23,
    revision: "fixture-rev-0001",
    coverage: completeCoverage(b, 30),
  });
}
