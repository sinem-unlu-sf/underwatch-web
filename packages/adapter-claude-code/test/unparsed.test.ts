import { describe, expect, it } from "vitest";
import { parseRunOutputs } from "../src/index";
import { ctxFor, readCapture } from "./helpers";

const SID = "11111111-2222-3333-4444-555555555555";

const stream = [
  JSON.stringify({ type: "system", subtype: "brand_new_subtype", session_id: SID, uuid: "u-1" }),
  JSON.stringify({ type: "mystery_event", session_id: SID, uuid: "u-2", payload: { a: 1 } }),
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_X","name":"Bash","input":{"command":"ls"}}]},"session_id":"' +
    SID +
    '","uuid":"u-3","timestamp":"2026-10-17T02:00:00.000Z"}',
  '{"type":"user","message":{"content":[{"type":"tool_res', // truncated partial write
].join("\n");

const transcript = [
  JSON.stringify({ type: "future-record-kind", sessionId: SID, timestamp: "2026-10-17T02:00:01.000Z" }),
  JSON.stringify([1, 2, 3]),
].join("\n");

const hooks = [
  JSON.stringify({ event: "SomeFutureHook", received_at: "2026-10-17T02:00:02.000000+00:00", payload: { session_id: SID, hook_event_name: "SomeFutureHook" } }),
  JSON.stringify({ v: 1, event: "PreToolUse", received_at: "2026-10-17T02:00:03.000Z", payload: null, payload_error: "invalid_json", raw: "{not json" }),
  "not json at all",
].join("\n");

describe("unknown and malformed records", () => {
  const r = parseRunOutputs({ streamJson: stream, transcript, hookLog: hooks }, ctxFor("unk"));

  it("preserves every unknown or malformed record as a raw_record event with collection_status unparsed", () => {
    const raw = r.events.filter((e) => e.event_type === "raw_record");
    expect(raw).toHaveLength(8);
    for (const e of raw) {
      expect(e.collection_status).toBe("unparsed");
      expect(e.outcome).toBe("unknown");
      expect(e.basis).toBe("reported");
      expect(e.evidence_id).toBeTruthy();
    }
    expect(r.records.filter((x) => x.disposition === "unparsed")).toHaveLength(8);
    const reasons = raw.map((e) => String(e.detail.extra.reason));
    expect(reasons.some((x) => x.includes("not valid JSON"))).toBe(true);
    expect(reasons.some((x) => x.includes("SomeFutureHook"))).toBe(true);
    expect(reasons.some((x) => x.includes("mystery_event"))).toBe(true);
  });

  it("still builds the tool call that is present, with an explicit unknown result", () => {
    const t = r.events.filter((e) => e.tool_use_id === "toolu_X");
    expect(t.map((e) => e.detail.phase)).toEqual(["requested", "resolved"]);
    const res = t[1]!;
    expect(res.outcome).toBe("unknown");
    expect(res.collection_status).toBe("partial");
    expect(res.limitations.join(" ")).toContain("No result record was captured");
  });

  it("marks the record set incomplete", () => {
    expect(r.completeness.unparsed_records).toBe(8);
    expect(r.completeness.agent_record_complete).toBe(false);
  });

  it("is idempotent for unparsed records too", () => {
    const again = parseRunOutputs({ streamJson: stream, transcript, hookLog: hooks }, ctxFor("unk"));
    expect(again.events.map((e) => e.id)).toEqual(r.events.map((e) => e.id));
  });

  it("uses the fallback timestamp only when no record has one, and says so", () => {
    const only = parseRunOutputs({ streamJson: JSON.stringify({ type: "x" }) }, ctxFor("fb"));
    expect(only.events[0]!.timestamp).toBe("2026-10-17T01:00:00.000Z");
    expect(only.events[0]!.detail.timestamp_basis).toBe("run_fallback");
  });

  it("rejects a non-ISO fallback timestamp", () => {
    expect(() => parseRunOutputs({}, { run_id: "run_x", fallback_timestamp: "yesterday" })).toThrow();
  });
});

describe("several transcripts (main + subagent)", () => {
  it("reads each with its own locator and rejects duplicate labels", () => {
    const sub = JSON.stringify({
      type: "assistant",
      sessionId: SID,
      uuid: "sub-1",
      timestamp: "2026-10-17T02:00:05.000Z",
      message: { content: [{ type: "tool_use", id: "toolu_SUB", name: "Read", input: { file_path: "/workspace/a.txt" } }] },
    });
    const r = parseRunOutputs(
      { transcript: [{ text: readCapture("run3", "transcript.jsonl"), label: "main.jsonl" }, { text: sub, label: "agent-x.jsonl" }] },
      ctxFor("multi"),
    );
    const req = r.events.find((e) => e.tool_use_id === "toolu_SUB" && e.detail.phase === "requested")!;
    expect(req.raw_summary).toContain("agent-x.jsonl#L1");
    expect(r.completeness.tool_calls_without_result).toEqual(["toolu_SUB"]);
    expect(() =>
      parseRunOutputs({ transcript: [{ text: sub, label: "a" }, { text: sub, label: "a" }] }, ctxFor("dup")),
    ).toThrow(/duplicate transcript label/);
  });
});

describe("hook-only input", () => {
  it("builds tool events from hooks when no conversation record exists, marking the source", () => {
    const r = parseRunOutputs({ hookLog: readCapture("run2", "hooks.jsonl") }, ctxFor("run2"));
    const tool = r.events.filter((e) => e.tool_use_id);
    expect(tool.length).toBe(12);
    for (const e of tool) expect(e.source).toBe("claude_code_hooks");
    for (const e of tool.filter((x) => x.detail.phase === "requested"))
      expect(e.limitations.join(" ")).toContain("tool_use record (stream-json/transcript) was not captured");
  });
});
