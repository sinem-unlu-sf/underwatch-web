/**
 * ISSUE 3: the adapter redacts by default. Synthetic canaries only (KWCANARY marker); no real credential is used.
 */
import { describe, expect, it } from "vitest";
import { REDACTION_FAILED_PLACEHOLDER } from "@kw/redaction";
import { parseRunOutputs, toSchemaEvents, type ParseContext } from "../src/index";

const ANT_TAIL = "Zq7Xv2Lp9Rt4Wm8Nc3Bf6Hd1Jk5Gs0Ya";
const OAI_TAIL = "proj9f8e7d6c5b4a3210ZYXWVUTSRQ";
const ANT = `sk-ant-oat01-KWCANARY-${ANT_TAIL}`;
const OAI = `sk-KWCANARY-${OAI_TAIL}`;
const B64 = Buffer.from(ANT).toString("base64");

function leaks(s: string): string[] {
  const out: string[] = [];
  for (const n of [ANT_TAIL.slice(0, 12), ANT_TAIL.slice(-12), OAI_TAIL.slice(0, 12), OAI_TAIL.slice(-12), B64.slice(8, 36), "KWCANARY-"]) if (s.includes(n)) out.push(n);
  return out;
}

const SID = "11111111-2222-3333-4444-555555555555";
const ts = (s: number) => `2026-10-17T02:00:${String(s).padStart(2, "0")}.000Z`;
const ENV_DUMP = `HOME=/home/agent\nANTHROPIC_API_KEY=${ANT}\nOPENAI_API_KEY=${OAI}\nPATH=/usr/bin`;
// The canary straddles the 120-char summary cut, so truncate-then-redact would leave a fragment behind.
const LONG_PROMPT = `${"Please summarize the repository layout and then continue with the task as described ".slice(0, 85)}${ANT} and more text after it`;

const stream = [
  { type: "system", subtype: "init", cwd: `/work/${OAI}`, session_id: SID, tools: ["Bash"], model: "claude-test", uuid: "u-0", timestamp: ts(0) },
  { type: "assistant", message: { model: "claude-test", id: "msg_1", content: [{ type: "text", text: `Found key ${OAI} in the logs.` }] }, session_id: SID, uuid: "u-1", timestamp: ts(1) },
  {
    type: "assistant",
    message: { model: "claude-test", id: "msg_1", content: [{ type: "tool_use", id: "toolu_KW1", name: "Bash", input: { command: `curl -H 'x-api-key: ${ANT}' https://api.example.test && echo ${B64}` } }] },
    session_id: SID,
    uuid: "u-2",
    timestamp: ts(2),
  },
  {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_KW1", is_error: true, content: `Exit code 1\n${ENV_DUMP}` }] },
    session_id: SID,
    uuid: "u-3",
    timestamp: ts(3),
  },
  { type: "result", subtype: "success", is_error: false, result: `Done. The env contained:\n${ENV_DUMP}`, session_id: SID, uuid: "u-4", num_turns: 2 },
]
  .map((x) => JSON.stringify(x))
  .join("\n");

const hooks = [
  { event: "UserPromptSubmit", received_at: ts(0), payload: { session_id: SID, hook_event_name: "UserPromptSubmit", prompt: LONG_PROMPT } },
  { event: "StopFailure", received_at: ts(5), payload: { session_id: SID, hook_event_name: "StopFailure", error: `upstream said: Authorization: Bearer ${OAI}` } },
]
  .map((x) => JSON.stringify(x))
  .join("\n");

const ctx = (extra: Partial<ParseContext> = {}): ParseContext => ({ run_id: "run_redaction_test", fallback_timestamp: ts(0), is_fixture: true, ...extra });

describe("adapter redaction is on by default", () => {
  it("raw mode proves the canaries are really present in the parsed fields", () => {
    const raw = parseRunOutputs({ streamJson: stream, hookLog: hooks }, ctx({ rawMode: "unsafe_raw_for_restricted_blob_store" }));
    expect(leaks(JSON.stringify(raw.events)).length).toBeGreaterThan(0);
  });

  it("with NO options, no canary survives in events (prompt, assistant text, final report, error text, Bash target, summaries, detail)", () => {
    const r = parseRunOutputs({ streamJson: stream, hookLog: hooks }, ctx());
    const all = JSON.stringify({ events: r.events, evidence: r.evidence, records: r.records, warnings: r.warnings });
    expect(leaks(all)).toEqual([]);
    expect(all).toContain("[REDACTED:");
    const bash = r.events.find((e) => e.tool_name === "Bash" && e.detail.phase === "requested")!;
    expect(bash.target_resource).toMatch(/^curl -H 'x-api-key: \[REDACTED:anthropic_key#1\]' https:\/\/api\.example\.test && echo \[REDACTED:/);
    expect(bash.tool_use_id).toBe("toolu_KW1"); // ids untouched
    const prompt = r.events.find((e) => e.event_type === "user_prompt")!;
    expect(prompt.summary).not.toMatch(/sk-ant/);
    // schema events (what the server persists) are clean as well
    expect(leaks(JSON.stringify(toSchemaEvents(r.events).events))).toEqual([]);
  });

  it("a caller-supplied redactor only adds to the built-in one (identity cannot disable it)", () => {
    const r = parseRunOutputs({ streamJson: stream, hookLog: hooks }, ctx({ redact: (s) => s }));
    expect(leaks(JSON.stringify(r.events))).toEqual([]);
  });

  it("fails closed when the built-in redactor throws", () => {
    const boom = { name: "boom", group: 0 } as { name: string; group: number; re: RegExp };
    Object.defineProperty(boom, "re", { get: () => ({ source: "(", flags: "" }) });
    const r = parseRunOutputs({ streamJson: stream, hookLog: hooks }, ctx({ redaction: { customPatterns: [boom] } }));
    const all = JSON.stringify(r.events);
    expect(leaks(all)).toEqual([]);
    expect(all).toContain(REDACTION_FAILED_PLACEHOLDER);
    // structure and identity survive
    expect(r.events.find((e) => e.tool_use_id === "toolu_KW1")).toBeTruthy();
  });
});
