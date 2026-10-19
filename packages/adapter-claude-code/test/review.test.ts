// Regression tests added in review.
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Safeguard } from "@kw/schema";
import { ClaudeCodeAdapter, parseRunOutputs } from "../src/index";
import { captureInputs, ctxFor } from "./helpers";

const DENY_RULE_READ = "toolu_01H9pq1BgZgyL3ScCkNNLDA2";

describe("permission inference without permission metadata", () => {
  it("a validation-stage deny-rule Read seen only in the transcript is a denial, never 'allowed'", () => {
    const i = captureInputs("run1");
    const r = parseRunOutputs({ transcript: i.transcript }, ctxFor("run1"));
    const res = r.events.find((e) => e.tool_use_id === DENY_RULE_READ && e.detail.phase === "resolved")!;
    expect(res.outcome).toBe("denied");
    expect(res.event_type).toBe("permission_decision");
    expect(res.detail.permission).toMatchObject({ kind: "permission_rule_deny", decision: "denied", evidence: "error_text" });
    expect(res.limitations.join(" ")).toMatch(/inferred classification/);
  });

  it("an error result with no metadata and no PostToolUseFailure hook leaves the decision unknown", () => {
    const sid = "s1";
    const lines = [
      { type: "assistant", session_id: sid, uuid: "a1", timestamp: "2026-10-17T01:00:00.000Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }] } },
      { type: "user", session_id: sid, uuid: "u1", timestamp: "2026-10-17T01:00:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Exit code 1" }] } },
    ];
    const r = parseRunOutputs({ streamJson: lines.map((l) => JSON.stringify(l)).join("\n") }, ctxFor("synthetic"));
    const res = r.events.find((e) => e.detail.phase === "resolved")!;
    expect(res.outcome).toBe("failed");
    expect(res.detail.permission).toMatchObject({ kind: "unknown", decision: "unknown", evidence: "none" });
  });

  it("an allowed call inferred from a success result says so (inferred_from_result)", () => {
    const i = captureInputs("run1");
    const r = parseRunOutputs({ hookLog: i.hookLog }, ctxFor("run1"));
    const ok = r.events.filter((e) => e.detail.phase === "resolved" && e.outcome === "succeeded");
    expect(ok.length).toBeGreaterThan(0);
    for (const e of ok) expect(e.detail.permission).toMatchObject({ kind: "allowed", evidence: "inferred_from_result" });
  });
});

describe("host-side safety of prepareWorkspace / buildCommand", () => {
  const adapter = new ClaudeCodeAdapter();
  const md: Safeguard = {
    id: "sg_md", finding_id: "fnd_1", is_fixture: true, type: "claude_md_instruction", title: "No .env", content: "Do not read .env files.",
    application_mechanism: "CLAUDE.md", target_path: null, intended_effect: "", legitimate_workflow_impact: "",
    approval_status: "approved", application_status: "not_applied", verification_status: "not_tested",
    created_at: "2026-10-17T00:00:00Z", approved_at: null, approved_by: null, applied_at: null, last_verification_run_id: null,
  };

  it("refuses to follow a CLAUDE.md symlink planted in the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "kw-rv-"));
    const ws = join(root, "ws");
    mkdirSync(ws);
    const outside = join(root, "host-file");
    writeFileSync(outside, "host\n");
    symlinkSync(outside, join(ws, "CLAUDE.md"));
    await expect(adapter.prepareWorkspace(ws, { rules: [] }, [md])).rejects.toThrow(/not a regular file/);
    expect(readFileSync(outside, "utf8")).toBe("host\n");
  });

  it("rejects a configDir that reaches into the workspace through a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "kw-rv-"));
    const ws = join(root, "ws");
    mkdirSync(join(ws, "inner"), { recursive: true });
    symlinkSync(join(ws, "inner"), join(root, "cfg-link"));
    await expect(adapter.prepareWorkspace(ws, { rules: [] }, [], { configDir: join(root, "cfg-link") })).rejects.toThrow(/outside the agent workspace/);
  });

  it("rejects a task that would be parsed as a CLI option", () => {
    expect(() => adapter.buildCommand({ task: "--dangerously-skip-permissions", model: "haiku", maxTurns: 1 })).toThrow(/must not start with "-"/);
  });
});
