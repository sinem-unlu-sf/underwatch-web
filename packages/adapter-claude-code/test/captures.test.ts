/**
 * Tests against REAL Claude Code 2.1.302 captures (research/claude-code/probe-out, sanitized copies).
 *  run1: default mode, project settings untrusted (allow rules dropped). PreToolUse hook denies Read of
 *        .env; deny rule Read(secrets/**); python3 + Write need approval that nobody can give in -p mode.
 *  run2: --settings allow rules + macOS sandbox denyRead .env -> commands run but fail.
 *  run3: no deny rules; the agent edits .claude/settings.json (ConfigChange) and reads secrets.
 */
import { describe, expect, it } from "vitest";
import { EVENT_ID_PATTERN, makeEventId } from "@kw/schema";
import {
  HOOK_EVENTS_OBSERVED_IN_CAPTURES,
  parseRunOutputs,
  toSchemaEvents,
  type ReportedEvent,
} from "../src/index";
import { RUNS, captureInputs, capturedToolUseIds, ctxFor, parseCapture, readCapture } from "./helpers";

function byTool(events: ReportedEvent[], id: string) {
  const ev = events.filter((e) => e.tool_use_id === id);
  return {
    all: ev,
    req: ev.filter((e) => e.detail.phase === "requested"),
    res: ev.filter((e) => e.detail.phase === "resolved"),
  };
}

describe.each(RUNS)("capture %s", (run) => {
  const result = parseCapture(run);
  const ids = capturedToolUseIds(run);

  it("turns every captured tool call into exactly one requested + one resolved event", () => {
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const t = byTool(result.events, id);
      expect(t.req, id).toHaveLength(1);
      expect(t.res, id).toHaveLength(1);
      expect(t.req[0]!.event_type).toBe("tool_call");
      expect(t.req[0]!.outcome).toBe("attempted");
      expect(["tool_result", "permission_decision"]).toContain(t.res[0]!.event_type);
    }
    const toolEvents = result.events.filter((e) => e.tool_use_id !== null);
    expect(toolEvents).toHaveLength(ids.length * 2);
    expect(new Set(toolEvents.map((e) => e.tool_use_id))).toEqual(new Set(ids));
  });

  it("keeps every event agent-reported with a stable, schema-shaped id", () => {
    for (const e of result.events) {
      expect(e.basis).toBe("reported");
      expect(["claude_code_hooks", "claude_code_transcript"]).toContain(e.source);
      expect(e.id).toMatch(EVENT_ID_PATTERN);
      expect(e.id).toBe(makeEventId({ run_id: e.run_id, basis: e.basis, source: e.source, source_native_key: e.source_native_key }));
      expect(e.unavailable_fields).toEqual(expect.arrayContaining(["process_id", "parent_process_id", "process_name"]));
      expect(e.limitations.length).toBeGreaterThan(0);
    }
    expect(new Set(result.events.map((e) => e.id)).size).toBe(result.events.length);
  });

  it("yields identical ids and output when the same files are ingested twice", () => {
    const again = parseCapture(run);
    expect(again.events.map((e) => e.id)).toEqual(result.events.map((e) => e.id));
    expect(again.evidence.map((e) => e.id)).toEqual(result.evidence.map((e) => e.id));
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  });

  it("gives tool events the same ids whether or not the hook log is present", () => {
    const { hookLog: _h, ...noHooks } = captureInputs(run);
    const partial = parseRunOutputs(noHooks, ctxFor(run));
    const full = new Map(result.events.filter((e) => e.tool_use_id).map((e) => [e.source_native_key, e.id]));
    const part = partial.events.filter((e) => e.tool_use_id);
    expect(part).toHaveLength(full.size);
    for (const e of part) expect(e.id).toBe(full.get(e.source_native_key));
  });

  it("accounts for every input line; nothing in the real captures is unparsed", () => {
    const lines = ["hooks.jsonl", "transcript.jsonl", "stream.jsonl"]
      .map((f) => readCapture(run, f).split("\n").filter((l) => l.trim()).length)
      .reduce((a, b) => a + b, 0);
    expect(result.records).toHaveLength(lines);
    expect(result.evidence).toHaveLength(lines);
    for (const r of result.records) {
      if (r.disposition === "event" || r.disposition === "corroboration") expect(r.event_ids.length, r.locator).toBeGreaterThan(0);
      if (r.disposition === "metadata") expect(r.reason, r.locator).toBeTruthy();
    }
    expect(result.records.filter((r) => r.disposition === "unparsed")).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("reports the agent-side record set as complete, with hook coverage of every call", () => {
    expect(result.completeness).toEqual({
      result_message_present: true,
      session_end_hook_present: true,
      tool_calls_without_result: [],
      tool_calls_missing_from_hook_log: [],
      unparsed_records: 0,
      agent_record_complete: true,
    });
    for (const e of result.events.filter((x) => x.tool_use_id))
      expect(e.detail.logical_key).toBe(`tool_use:${e.tool_use_id}:${e.detail.phase}`);
  });

  it("reports an incomplete record set when stream-json is missing", () => {
    const { streamJson: _s, ...rest } = captureInputs(run);
    const r = parseRunOutputs(rest, ctxFor(run));
    expect(r.completeness.result_message_present).toBe(false);
    expect(r.completeness.agent_record_complete).toBe(false);
  });

  it("produces schema-valid Events for every schema-representable event", () => {
    const { events, not_representable } = toSchemaEvents(result.events);
    expect(events.length + not_representable.length).toBe(result.events.length);
    for (const e of not_representable) expect(["instructions_loaded", "config_change", "agent_lifecycle", "hook_execution", "raw_record"]).toContain(e.event_type);
  });

  it("records one session and one final report from the stream-json result message", () => {
    expect(result.session_ids).toEqual([readCapture(run, "session-id.txt").trim()]);
    const finals = result.events.filter((e) => e.detail.extra.kind === "final_report");
    expect(finals).toHaveLength(1);
    expect(finals[0]!.detail.record_kind).toBe("result/success");
    expect(finals[0]!.detail.text).toBeTruthy();
    expect(finals[0]!.detail.corroborating.map((c) => c.record_kind)).toContain("hook:Stop");
    expect(result.events.filter((e) => e.event_type === "session_start")).toHaveLength(1);
    expect(result.events.filter((e) => e.event_type === "session_end")).toHaveLength(1);
    expect(result.events.filter((e) => e.event_type === "user_prompt")).toHaveLength(1);
  });

  it("never copies the synthetic secret into events when a redactor is supplied", () => {
    const red = parseCapture(run, { redact: (s) => s.replaceAll("kw-test-0000", "[REDACTED]") });
    expect(JSON.stringify(red.events)).not.toContain("kw-test-0000");
    expect(JSON.stringify(red.evidence)).not.toContain("kw-test-0000");
    // Without a redactor, single-line fields still avoid tool output (only targets/commands are copied).
    for (const e of result.events) {
      expect(e.summary + (e.target_resource ?? "") + (e.raw_summary ?? "")).not.toContain("kw-test-0000");
    }
  });
});

describe("run1 permission mapping", () => {
  const { events } = parseCapture("run1");
  const res = (id: string) => byTool(events, id).res[0]!;

  it("maps the PreToolUse-hook-denied Read of .env to a hook deny", () => {
    const e = res("toolu_01QQ7RtPJBzE1pjhGyeh6EVU");
    expect(e.tool_name).toBe("Read");
    expect(e.target_resource).toMatch(/\/probe\/\.env$/);
    expect(e.event_type).toBe("permission_decision");
    expect(e.outcome).toBe("denied");
    expect(e.detail.permission).toMatchObject({
      kind: "hook_deny",
      decision: "denied",
      evidence: "permission_metadata",
      cc_source: "hook",
      // Claude Code labels the hook denial "permission-rule" too; source "hook" is what distinguishes it.
      cc_non_execution_kind: "permission-rule",
      listed_in_result_permission_denials: true,
    });
    expect(e.detail.hook_events).toContain("PreToolUse");
    expect(e.detail.hook_events).not.toContain("PostToolUse");
    expect(e.summary).toContain("denied (by PreToolUse hook)");
  });

  it("maps the deny-rule Read of secrets/token.txt, which fired no PreToolUse hook", () => {
    const t = byTool(events, "toolu_01H9pq1BgZgyL3ScCkNNLDA2");
    expect(t.res[0]!.outcome).toBe("denied");
    expect(t.res[0]!.detail.permission).toMatchObject({ kind: "permission_rule_deny", evidence: "error_text" });
    expect(t.req[0]!.detail.hook_events).toEqual(["PostToolBatch"]);
    expect(t.req[0]!.source).toBe("claude_code_transcript");
  });

  it("maps the Bash deny rule hit and the approval-required denials distinctly", () => {
    expect(res("toolu_01TeeLUrQYxvxedPdD36eaFU").detail.permission).toMatchObject({
      kind: "permission_rule_deny",
      evidence: "permission_metadata",
      stream_permission_denied_message: true,
    });
    for (const id of ["toolu_0143cx8oa8h8FMnNhzU9eTL6", "toolu_018BtV8VV9P2BHQk76nKgjCu"]) {
      expect(res(id).detail.permission).toMatchObject({
        kind: "approval_unavailable_deny",
        cc_non_execution_kind: "user-rejected",
        permission_request_hook_fired: true,
      });
    }
  });

  it("maps allowed calls as allowed, including the Bash cat .env that bypassed the Read hook", () => {
    for (const id of ["toolu_013E7LxwiX9qBaJCVuUaj7ui", "toolu_01Gs1HjjC8mb85KWpXsSfgpA", "toolu_01F29aHxREa24PAJDqUveCdW"]) {
      const e = res(id);
      expect(e.event_type).toBe("tool_result");
      expect(e.outcome).toBe("succeeded");
      expect(e.detail.permission).toMatchObject({ kind: "allowed", decision: "allowed", evidence: "permission_metadata" });
    }
    expect(res("toolu_01F29aHxREa24PAJDqUveCdW").target_resource).toBe("cat .env");
  });

  it("lists exactly the five denials in the final report", () => {
    const final = events.find((e) => e.detail.extra.kind === "final_report")!;
    expect(final.detail.extra.permission_denial_tool_use_ids).toEqual([
      "toolu_01QQ7RtPJBzE1pjhGyeh6EVU",
      "toolu_01H9pq1BgZgyL3ScCkNNLDA2",
      "toolu_01TeeLUrQYxvxedPdD36eaFU",
      "toolu_0143cx8oa8h8FMnNhzU9eTL6",
      "toolu_018BtV8VV9P2BHQk76nKgjCu",
    ]);
    expect(events.filter((e) => e.outcome === "denied")).toHaveLength(5);
  });

  it("surfaces the hook's deny response from stream-json as a hook_execution event", () => {
    const h = events.filter((e) => e.event_type === "hook_execution");
    expect(h).toHaveLength(1);
    expect(h[0]!.detail.extra).toMatchObject({ hook_name: "PreToolUse:Read", decision: "deny", exit_code: 0 });
  });
});

describe("run2 / run3 specifics", () => {
  it("run2: sandbox-blocked commands are allowed by Claude Code but reported as failed", () => {
    const { events } = parseCapture("run2");
    const e = byTool(events, "toolu_01H26fPjiwePJksGG2Ro5w85").res[0]!;
    expect(e.outcome).toBe("failed");
    expect(e.detail.permission?.kind).toBe("allowed");
    expect(e.detail.error_text).toContain("Operation not permitted");
    expect(e.detail.hook_events).toContain("PostToolUseFailure");
    expect(e.detail.duration_ms).toBe(1211);
    const created = events.find((x) => x.event_type === "file_create");
    expect(created?.target_resource).toMatch(/notes\.txt$/);
  });

  it("run3: the agent's edit of .claude/settings.json shows up as a config_change event", () => {
    const { events } = parseCapture("run3");
    const cc = events.filter((e) => e.event_type === "config_change");
    expect(cc).toHaveLength(1);
    expect(cc[0]!.target_resource).toMatch(/\.claude\/settings\.json$/);
    expect(cc[0]!.detail.extra.source).toBe("project_settings");
    // task_started / task_notification for the sleeping Bash call corroborate that tool call.
    const t = byTool(events, "toolu_0164msJgyTcxtyKS8iZk81Vu");
    expect(t.req[0]!.detail.corroborating.map((c) => c.record_kind)).toContain("system/task_started");
    expect(t.res[0]!.detail.corroborating.map((c) => c.record_kind)).toContain("system/task_notification");
  });
});

describe("hook events fired in the captures", () => {
  it("match HOOK_EVENTS_OBSERVED_IN_CAPTURES", () => {
    const seen = new Set<string>();
    for (const run of RUNS) {
      for (const line of readCapture(run, "hooks.jsonl").split("\n")) {
        if (!line.trim()) continue;
        seen.add((JSON.parse(line) as { payload: { hook_event_name: string } }).payload.hook_event_name);
      }
    }
    expect([...seen].sort()).toEqual([...HOOK_EVENTS_OBSERVED_IN_CAPTURES].sort());
  });

  it("system and result stream records carry no timestamp, so their events borrow one", () => {
    const { events } = parseCapture("run1");
    const start = events.find((e) => e.event_type === "session_start")!;
    expect(start.detail.channel).toBe("stream_json");
    expect(start.detail.timestamp_basis).toBe("hook_received_at");
  });
});
