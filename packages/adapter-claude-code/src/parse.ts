/**
 * Parsers for Claude Code's own records (agent-REPORTED evidence) and the merge into normalized events.
 *
 * Inputs (any subset):
 *  - hook log: NDJSON lines written by bin/kw-hook.mjs ({ event, received_at, payload, ... }). Lines from
 *    the research probe logger (same shape plus hook_pid/env_names) and the docker placeholder forwarder
 *    ({ hook_event_name, received_at, payload }) are accepted too.
 *  - transcript: ~/.claude/projects/<project>/<session_id>.jsonl (path is in every hook payload as
 *    transcript_path).
 *  - stream-json: stdout of `claude -p --output-format stream-json --verbose`.
 *
 * Field names come from the 2.1.302 captures (test/fixtures/captures) and hooks.md / headless.md.
 * Fields seen only in captures and absent from the docs (stream `tool_result_meta`, transcript
 * `permissionDecision` / `toolDenialKind`) are used, and that use is marked UNVERIFIED as a stable API.
 *
 * Merge model: one logical event per native key. Native keys are built from Claude Code identifiers
 * (session_id + tool_use_id + phase, message uuid, prompt id), never from line numbers, so the same
 * record seen in two channels (stream-json and transcript share uuids; hooks share tool_use_id) becomes
 * one event with corroborating references. Every tool call yields exactly one `requested` and one
 * `resolved` event. Every input line is accounted for in ParseResult.records; lines that are not
 * understood become `raw_record` events with collection_status "unparsed".
 */
import { defaultRedactor } from "@kw/redaction";
import { makeEventId, makeStableId, sha256Hex, type EventSource, type Evidence, type Outcome } from "@kw/schema";
import { isDocumentedHookEvent } from "./constants";
import {
  CHANNEL_CUSTODY,
  type Channel,
  type Completeness,
  type ChannelInput,
  type ParseContext,
  type ParsedRecord,
  type ParseResult,
  type PermissionInfo,
  type PermissionKind,
  type RecordRef,
  type ReportedCollectionStatus,
  type ReportedEvent,
  type ReportedEventType,
  type RunOutputs,
  type TimestampBasis,
} from "./types";
import { bool, canonicalJson, isObj, isoOrNull, num, oneLine, shortHash, splitLines, str, timeKey, truncate, type Obj } from "./util";

const CHANNEL_ORDER: Record<Channel, number> = { stream_json: 0, transcript: 1, hook_log: 2 };
const DEFAULT_LABEL: Record<Channel, string> = {
  hook_log: "hooks.ndjson",
  stream_json: "stream.jsonl",
  transcript: "transcript.jsonl",
};
const NO_SESSION = "no-session";

export const REPORTED_LIMITATION =
  "Agent-reported record (Claude Code's own account); it does not establish OS-level side effects.";
const NOT_PROVIDED = ["process_id", "parent_process_id", "process_name"];

// ------------------------------------------------------------------------------------------------
// Records
// ------------------------------------------------------------------------------------------------

interface Rec {
  channel: Channel;
  line: number;
  locator: string;
  text: string;
  sha256: string;
  bytes: number;
  value: Obj | null;
  parse_error: string | null;
  evidence_id: string;
  kind: string;
  session_id: string | null;
  ts: string | null;
  ts_basis: TimestampBasis;
  disposition: ParsedRecord["disposition"] | null;
  reason: string | null;
  event_ids: Set<string>;
}

function ref(r: Rec): RecordRef {
  return { channel: r.channel, line: r.line, locator: r.locator, record_kind: r.kind, evidence_id: r.evidence_id };
}

function readChannel(channel: Channel, input: string | ChannelInput | null | undefined, ctx: ParseContext): Rec[] {
  if (input == null) return [];
  const text = typeof input === "string" ? input : input.text;
  const label = typeof input === "string" ? DEFAULT_LABEL[channel] : (input.label ?? DEFAULT_LABEL[channel]);
  const recs: Rec[] = [];
  for (const { line, text: t } of splitLines(text)) {
    const sha = sha256Hex(t);
    let value: Obj | null = null;
    let parse_error: string | null = null;
    try {
      const v: unknown = JSON.parse(t);
      if (isObj(v)) value = v;
      else parse_error = "line is valid JSON but not an object";
    } catch {
      parse_error = "line is not valid JSON (possibly a partial write)";
    }
    recs.push({
      channel,
      line,
      locator: `${label}#L${line}`,
      text: t,
      sha256: sha,
      bytes: new TextEncoder().encode(t).length,
      value,
      parse_error,
      evidence_id: makeStableId("evidence", ctx.run_id, channel, label, String(line), sha),
      kind: "unknown",
      session_id: null,
      ts: null,
      ts_basis: "run_fallback",
      disposition: null,
      reason: null,
      event_ids: new Set(),
    });
  }
  return recs;
}

/** Records without their own timestamp borrow the nearest timestamped record of the same channel. */
function fillNeighborTimestamps(recs: Rec[]): void {
  let prev: string | null = null;
  const pending: Rec[] = [];
  for (const r of recs) {
    if (r.ts) {
      prev = r.ts;
      for (const p of pending) {
        p.ts = r.ts;
        p.ts_basis = "neighbor_record";
      }
      pending.length = 0;
    } else if (prev) {
      r.ts = prev;
      r.ts_basis = "neighbor_record";
    } else pending.push(r);
  }
}

// ------------------------------------------------------------------------------------------------
// Items: contributions of records to logical events
// ------------------------------------------------------------------------------------------------

type GroupKind =
  | "session_start"
  | "session_end"
  | "user_prompt"
  | "agent_message"
  | "final_report"
  | "instructions_loaded"
  | "config_change"
  | "file_changed"
  | "lifecycle"
  | "hook_execution"
  | "raw";

interface Item {
  rec: Rec;
  /** Lower is preferred as the event's primary record. */
  priority: number;
  /** Event-specific data pulled from the record. */
  d: Obj;
}

interface Group {
  kind: GroupKind;
  key: string;
  session_id: string | null;
  items: Item[];
}

interface ToolItem {
  rec: Rec;
  priority: number;
  via: string;
  tool_name: string | null;
  input: Obj | null;
  agent_id: string | null;
  parent_tool_use_id: string | null;
  status?: "succeeded" | "failed" | "denied";
  is_error?: boolean | null;
  error_text?: string | null;
  duration_ms?: number | null;
  meta?: { decision: string | null; source: string | null; reason_type: string | null; non_execution_kind: string | null };
  denial_listed?: boolean;
  stream_denied?: { reason_type: string | null; message: string | null };
  auto_denied_reason?: string | null;
  permission_request?: boolean;
  result_summary?: Obj;
}

interface ToolCall {
  session_id: string;
  tool_use_id: string;
  req: ToolItem[];
  res: ToolItem[];
  first_seen: number;
}

class Collector {
  groups = new Map<string, Group>();
  tools = new Map<string, ToolCall>();
  warnings: string[] = [];
  /** PermissionRequest hook records; matched to tool calls after every channel is read. */
  pendingPR: Array<{ r: Rec; p: Obj }> = [];
  private seq = 0;

  add(kind: GroupKind, key: string, session_id: string | null, item: Item): void {
    let g = this.groups.get(key);
    if (!g) {
      g = { kind, key, session_id, items: [] };
      this.groups.set(key, g);
    }
    g.items.push(item);
    item.rec.disposition ??= "corroboration";
  }

  tool(session_id: string | null, tool_use_id: string): ToolCall {
    const sid = session_id ?? NO_SESSION;
    const k = `${sid}\u001f${tool_use_id}`;
    let t = this.tools.get(k);
    if (!t) {
      t = { session_id: sid, tool_use_id, req: [], res: [], first_seen: this.seq++ };
      this.tools.set(k, t);
    }
    return t;
  }

  addReq(session_id: string | null, tool_use_id: string, item: ToolItem): void {
    this.tool(session_id, tool_use_id).req.push(item);
    item.rec.disposition ??= "corroboration";
  }

  addRes(session_id: string | null, tool_use_id: string, item: ToolItem): void {
    this.tool(session_id, tool_use_id).res.push(item);
    item.rec.disposition ??= "corroboration";
  }

  findToolsByInput(session_id: string | null, tool_name: string | null, input: Obj | null): ToolCall[] {
    if (!tool_name || !input) return [];
    const want = canonicalJson(input);
    const out: ToolCall[] = [];
    for (const t of this.tools.values()) {
      if (t.session_id !== (session_id ?? NO_SESSION)) continue;
      if (t.req.some((i) => i.tool_name === tool_name && i.input && canonicalJson(i.input) === want)) out.push(t);
    }
    return out;
  }
}

function metadata(r: Rec, reason: string): void {
  r.disposition = "metadata";
  r.reason = reason;
}

function unparsed(c: Collector, r: Rec, reason: string): void {
  r.disposition = "unparsed";
  r.reason = reason;
  const key = `${r.session_id ?? NO_SESSION}:raw:${r.channel}:${r.sha256.slice(0, 16)}:${r.line}`;
  c.add("raw", key, r.session_id, { rec: r, priority: 0, d: { reason } });
  r.disposition = "unparsed";
}

/** Occurrence counter so identical payloads at different points get distinct, stable keys. */
class Occurrences {
  private m = new Map<string, number>();
  next(k: string): number {
    const n = this.m.get(k) ?? 0;
    this.m.set(k, n + 1);
    return n;
  }
}

// ------------------------------------------------------------------------------------------------
// Hook log
// ------------------------------------------------------------------------------------------------

function readHookLog(recs: Rec[], c: Collector): void {
  const occ = new Occurrences();
  const sessionStartSeen = new Set<string>();
  const sessionEndSeen = new Set<string>();
  const stopCount = new Map<string, number>();

  for (const r of recs) {
    if (!r.value) {
      r.kind = "hook:invalid";
      unparsed(c, r, r.parse_error ?? "unparseable");
      continue;
    }
    const v = r.value;
    const payload = isObj(v.payload) ? v.payload : null;
    r.ts = isoOrNull(v.received_at);
    if (r.ts) r.ts_basis = "hook_received_at";
    const ccEvent = payload ? str(payload.hook_event_name) : null;
    const logged = str(v.event) ?? str(v.hook_event_name);
    const ev = ccEvent ?? logged;
    r.kind = `hook:${ev ?? "unknown"}`;
    if (!payload) {
      unparsed(c, r, `hook record without a JSON payload (${str(v.payload_error) ?? "payload missing"})`);
      continue;
    }
    r.session_id = str(payload.session_id);
    if (ccEvent && logged && ccEvent !== logged) {
      c.warnings.push(`${r.locator}: forwarder event "${logged}" differs from payload hook_event_name "${ccEvent}"`);
    }
    const configured = str(v.configured_event);
    if (configured && ev && configured !== ev) {
      c.warnings.push(`${r.locator}: handler configured for "${configured}" received "${ev}"`);
    }
    if (!ev || !isDocumentedHookEvent(ev)) {
      unparsed(c, r, `hook event "${ev ?? "?"}" is not a documented 2.1.302 hook event`);
      continue;
    }
    const sid = r.session_id;
    const toolUseId = str(payload.tool_use_id);
    const base = (via: string): ToolItem => ({
      rec: r,
      priority: 3,
      via,
      tool_name: str(payload.tool_name),
      input: isObj(payload.tool_input) ? payload.tool_input : null,
      agent_id: str(payload.agent_id),
      parent_tool_use_id: null,
    });

    switch (ev) {
      case "PreToolUse":
      case "PostToolUse":
      case "PostToolUseFailure":
      case "PermissionDenied": {
        if (!toolUseId) {
          unparsed(c, r, `${ev} payload without tool_use_id`);
          break;
        }
        if (ev === "PreToolUse") {
          c.addReq(sid, toolUseId, base("hook:PreToolUse"));
        } else if (ev === "PostToolUse") {
          const tr = payload.tool_response;
          c.addRes(sid, toolUseId, {
            ...base("hook:PostToolUse"),
            status: "succeeded",
            duration_ms: num(payload.duration_ms),
            result_summary: summarizeToolResult(tr),
          });
        } else if (ev === "PostToolUseFailure") {
          c.addRes(sid, toolUseId, {
            ...base("hook:PostToolUseFailure"),
            status: "failed",
            is_error: true,
            error_text: str(payload.error),
            duration_ms: num(payload.duration_ms),
            result_summary: { is_interrupt: bool(payload.is_interrupt) },
          });
        } else {
          c.addRes(sid, toolUseId, {
            ...base("hook:PermissionDenied"),
            priority: 3,
            status: "denied",
            auto_denied_reason: str(payload.reason),
          });
        }
        break;
      }
      case "PermissionRequest":
        // Captured PermissionRequest payloads carry no tool_use_id; matched to a tool call after all
        // channels are read (exact tool_name + tool_input equality).
        c.pendingPR.push({ r, p: payload });
        break;
      case "PostToolBatch": {
        const calls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
        let attached = 0;
        for (const call of calls) {
          if (!isObj(call) || !str(call.tool_use_id)) continue;
          c.addRes(sid, str(call.tool_use_id)!, {
            rec: r,
            priority: 7,
            via: "hook:PostToolBatch",
            tool_name: str(call.tool_name),
            input: isObj(call.tool_input) ? call.tool_input : null,
            agent_id: str(payload.agent_id),
            parent_tool_use_id: null,
          });
          attached++;
        }
        if (attached === 0) metadata(r, "PostToolBatch without tool calls");
        break;
      }
      case "SessionStart": {
        const s = sid ?? NO_SESSION;
        const first = !sessionStartSeen.has(s);
        sessionStartSeen.add(s);
        const key = first ? `${s}:session_start` : `${s}:session_start:${str(payload.source) ?? "?"}:${occ.next(`ss${s}`)}`;
        c.add("session_start", key, sid, {
          rec: r,
          priority: 3,
          d: {
            source: str(payload.source),
            model: str(payload.model),
            cwd: str(payload.cwd),
            transcript_path: str(payload.transcript_path),
            permission_mode: str(payload.permission_mode),
          },
        });
        break;
      }
      case "SessionEnd": {
        const s = sid ?? NO_SESSION;
        const key = sessionEndSeen.has(s) ? `${s}:session_end:${occ.next(`se${s}`)}` : `${s}:session_end`;
        sessionEndSeen.add(s);
        c.add("session_end", key, sid, { rec: r, priority: 3, d: { reason: str(payload.reason) } });
        break;
      }
      case "UserPromptSubmit": {
        const pid = str(payload.prompt_id) ?? `h${shortHash(payload)}`;
        c.add("user_prompt", `${sid ?? NO_SESSION}:user_prompt:${pid}`, sid, {
          rec: r,
          priority: 3,
          d: { text: str(payload.prompt), prompt_id: str(payload.prompt_id), permission_mode: str(payload.permission_mode) },
        });
        break;
      }
      case "Stop": {
        const s = sid ?? NO_SESSION;
        const active = bool(payload.stop_hook_active) === true;
        const n = stopCount.get(s) ?? 0;
        // A Stop re-fired while a stop hook is active belongs to the same turn as the previous Stop.
        const k = active && n > 0 ? n - 1 : n;
        if (!(active && n > 0)) stopCount.set(s, n + 1);
        c.add("final_report", `${s}:final_report:${k}`, sid, {
          rec: r,
          priority: 3,
          d: { text: str(payload.last_assistant_message), stop_hook_active: active, via: "hook:Stop" },
        });
        break;
      }
      case "InstructionsLoaded":
        c.add("instructions_loaded", hookKey(sid, ev, payload, occ), sid, {
          rec: r,
          priority: 3,
          d: {
            target: str(payload.file_path),
            memory_type: str(payload.memory_type),
            load_reason: str(payload.load_reason),
          },
        });
        break;
      case "ConfigChange":
        c.add("config_change", hookKey(sid, ev, payload, occ), sid, {
          rec: r,
          priority: 3,
          d: { target: str(payload.file_path), source: str(payload.source) },
        });
        break;
      case "FileChanged":
        c.add("file_changed", hookKey(sid, ev, payload, occ), sid, {
          rec: r,
          priority: 3,
          d: { target: str(payload.file_path), change: str(payload.event) },
        });
        break;
      case "MessageDisplay":
        metadata(r, "MessageDisplay repeats assistant text as it is displayed; the assistant message itself is the event");
        break;
      default:
        c.add("lifecycle", hookKey(sid, ev, payload, occ), sid, {
          rec: r,
          priority: 3,
          d: { hook_event: ev, fields: lifecycleFields(ev, payload) },
        });
    }
  }
}

function hookKey(sid: string | null, ev: string, payload: Obj, occ: Occurrences): string {
  const { transcript_path: _t, ...rest } = payload;
  const h = shortHash(rest);
  return `${sid ?? NO_SESSION}:hook:${ev}:${h}:${occ.next(`${ev}:${h}`)}`;
}

function lifecycleFields(ev: string, p: Obj): Obj {
  const pick = (...keys: string[]): Obj => {
    const o: Obj = {};
    for (const k of keys) if (p[k] !== undefined) o[k] = p[k];
    return o;
  };
  switch (ev) {
    case "SubagentStart":
    case "SubagentStop":
      return pick("agent_id", "agent_type", "stop_hook_active");
    case "Notification":
      return pick("notification_type", "title");
    case "StopFailure":
      return pick("error", "error_type", "error_details");
    case "PreCompact":
    case "PostCompact":
      return pick("trigger");
    case "CwdChanged":
      return pick("old_cwd", "new_cwd", "cwd");
    case "TaskCreated":
    case "TaskCompleted":
      return pick("task_id", "task_subject");
    case "PreModelSwitch":
    case "PostModelSwitch":
      return pick("from_model", "to_model");
    default:
      return {};
  }
}

function summarizeToolResult(tr: unknown): Obj {
  if (typeof tr === "string") return { kind: "text", bytes: tr.length };
  if (!isObj(tr)) return {};
  const o: Obj = {};
  if (str(tr.type)) o.type = tr.type;
  if (str(tr.filePath)) o.file_path = tr.filePath;
  if (isObj(tr.file) && str(tr.file.filePath)) o.file_path = tr.file.filePath;
  if (typeof tr.stdout === "string") o.stdout_bytes = tr.stdout.length;
  if (typeof tr.stderr === "string") o.stderr_bytes = tr.stderr.length;
  if (bool(tr.interrupted) !== null) o.interrupted = tr.interrupted;
  if (Array.isArray(tr.structuredPatch)) o.structured_patch_hunks = tr.structuredPatch.length;
  return o;
}

// ------------------------------------------------------------------------------------------------
// Conversation records: stream-json and transcript (same message objects, same uuids)
// ------------------------------------------------------------------------------------------------

const STREAM_METADATA: Record<string, string> = {
  "system/hook_started": "hook start marker (no tool_use_id)",
  "system/hook_response": "hook completion marker (no tool_use_id); notable responses become hook_execution events",
  "system/thinking_tokens": "thinking token estimate",
  rate_limit_event: "account rate-limit status",
};

const TRANSCRIPT_METADATA: Record<string, string> = {
  attachment: "context attachment added by Claude Code",
  "api-request": "API request bookkeeping",
  "api-request-blob": "API request content blob",
  "api-request-shape": "API request shape bookkeeping",
  "atis-latch": "internal session latch",
  "cost-state": "cost accounting snapshot",
  "last-prompt": "last-prompt pointer",
  "queue-operation": "prompt queue bookkeeping",
  "system/stop_hook_summary": "summary of Stop hook execution",
};

function readConversation(recs: Rec[], c: Collector, channel: "stream_json" | "transcript"): void {
  const prio = channel === "stream_json" ? 1 : 2;
  const resultCount = new Map<string, number>();
  for (const r of recs) {
    if (!r.value) {
      r.kind = `${channel}:invalid`;
      unparsed(c, r, r.parse_error ?? "unparseable");
      continue;
    }
    const v = r.value;
    const type = str(v.type) ?? "?";
    const subtype = str(v.subtype);
    r.kind = subtype ? `${type}/${subtype}` : type;
    r.session_id = str(v.session_id) ?? str(v.sessionId);
    r.ts = isoOrNull(v.timestamp);
    if (r.ts) r.ts_basis = "record";
    const sid = r.session_id;
    const s = sid ?? NO_SESSION;
    const table = channel === "stream_json" ? STREAM_METADATA : TRANSCRIPT_METADATA;

    if (type === "assistant" && isObj(v.message)) {
      readAssistant(r, v, c, prio);
      continue;
    }
    if (type === "user" && isObj(v.message)) {
      readUser(r, v, c, prio, channel);
      continue;
    }
    if (channel === "stream_json" && type === "system" && subtype === "init") {
      r.kind = "system/init";
      c.add("session_start", `${s}:session_start`, sid, {
        rec: r,
        priority: prio,
        d: {
          model: str(v.model),
          permission_mode: str(v.permissionMode),
          claude_code_version: str(v.claude_code_version),
          cwd: str(v.cwd),
          api_key_source: str(v.apiKeySource),
          tools_count: Array.isArray(v.tools) ? v.tools.length : null,
          mcp_servers: Array.isArray(v.mcp_servers)
            ? v.mcp_servers.filter(isObj).map((m) => ({ name: str(m.name), status: str(m.status) }))
            : null,
        },
      });
      continue;
    }
    if (channel === "stream_json" && type === "system" && subtype === "permission_denied") {
      const id = str(v.tool_use_id);
      if (!id) {
        unparsed(c, r, "permission_denied without tool_use_id");
        continue;
      }
      c.addRes(sid, id, {
        rec: r,
        priority: 4,
        via: "stream:permission_denied",
        tool_name: str(v.tool_name),
        input: null,
        agent_id: null,
        parent_tool_use_id: null,
        status: "denied",
        stream_denied: { reason_type: str(v.decision_reason_type), message: str(v.message) },
      });
      continue;
    }
    if (channel === "stream_json" && type === "system" && (subtype === "task_started" || subtype === "task_notification")) {
      const id = str(v.tool_use_id);
      if (!id) {
        unparsed(c, r, `${subtype} without tool_use_id`);
        continue;
      }
      const item: ToolItem = {
        rec: r,
        priority: 6,
        via: `stream:${subtype}`,
        tool_name: null,
        input: null,
        agent_id: null,
        parent_tool_use_id: null,
        result_summary: { task_type: str(v.task_type), status: str(v.status) },
      };
      if (subtype === "task_started") c.addReq(sid, id, item);
      else c.addRes(sid, id, item);
      continue;
    }
    if (channel === "stream_json" && type === "system" && subtype === "hook_response") {
      const exit = num(v.exit_code);
      const outcome = str(v.outcome);
      const decision = hookDecision(str(v.output) ?? str(v.stdout));
      if ((exit !== null && exit !== 0) || (outcome !== null && outcome !== "success") || decision) {
        c.add("hook_execution", `${s}:hook_response:${str(v.uuid) ?? r.sha256.slice(0, 16)}`, sid, {
          rec: r,
          priority: prio,
          d: { hook_name: str(v.hook_name), hook_event: str(v.hook_event), exit_code: exit, outcome, decision },
        });
        continue;
      }
    }
    if (channel === "stream_json" && type === "result") {
      const n = resultCount.get(s) ?? 0;
      resultCount.set(s, n + 1);
      const denials = Array.isArray(v.permission_denials) ? v.permission_denials.filter(isObj) : [];
      c.add("final_report", `${s}:final_report:${n}`, sid, {
        rec: r,
        priority: prio,
        d: {
          via: "stream:result",
          text: str(v.result),
          subtype,
          is_error: bool(v.is_error),
          num_turns: num(v.num_turns),
          stop_reason: str(v.stop_reason),
          terminal_reason: str(v.terminal_reason),
          duration_ms: num(v.duration_ms),
          total_cost_usd: num(v.total_cost_usd),
          permission_denial_tool_use_ids: denials.map((d) => str(d.tool_use_id)).filter((x): x is string => !!x),
        },
      });
      r.disposition = "event";
      for (const d of denials) {
        const id = str(d.tool_use_id);
        if (!id) continue;
        c.addRes(sid, id, {
          rec: r,
          priority: 5,
          via: "stream:result.permission_denials",
          tool_name: str(d.tool_name),
          input: isObj(d.tool_input) ? d.tool_input : null,
          agent_id: null,
          parent_tool_use_id: null,
          status: "denied",
          denial_listed: true,
        });
      }
      continue;
    }
    const reason = table[r.kind] ?? table[type];
    if (reason) {
      metadata(r, reason);
      continue;
    }
    unparsed(c, r, `unrecognized ${channel} record type "${r.kind}"`);
  }
}

function hookDecision(output: string | null): string | null {
  if (!output) return null;
  try {
    const o: unknown = JSON.parse(output);
    if (isObj(o)) {
      if (isObj(o.hookSpecificOutput)) {
        const d = str(o.hookSpecificOutput.permissionDecision) ?? str(o.hookSpecificOutput.decision);
        if (d) return d;
      }
      return str(o.decision);
    }
  } catch {
    /* not JSON: no structured decision */
  }
  return null;
}

function readAssistant(r: Rec, v: Obj, c: Collector, prio: number): void {
  const msg = v.message as Obj;
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const sid = r.session_id;
  const uuid = str(v.uuid) ?? `h${r.sha256.slice(0, 16)}`;
  const parent = str(v.parent_tool_use_id);
  let used = false;
  blocks.forEach((b, i) => {
    if (!isObj(b)) return;
    const bt = str(b.type);
    if (bt === "tool_use" && str(b.id)) {
      c.addReq(sid, str(b.id)!, {
        rec: r,
        priority: prio,
        via: `${r.channel}:tool_use`,
        tool_name: str(b.name),
        input: isObj(b.input) ? b.input : null,
        agent_id: null,
        parent_tool_use_id: parent,
      });
      used = true;
    } else if (bt === "text" && typeof b.text === "string") {
      c.add("agent_message", `${sid ?? NO_SESSION}:agent_message:${uuid}:${i}`, sid, {
        rec: r,
        priority: prio,
        d: { text: b.text, parent_tool_use_id: parent, model: str(msg.model) },
      });
      used = true;
    }
  });
  r.kind = `assistant/${blocks.map((b) => (isObj(b) ? (str(b.type) ?? "?") : "?")).join(",") || "empty"}`;
  if (!used) {
    if (blocks.length > 0 && blocks.every((b) => isObj(b) && (b.type === "thinking" || b.type === "redacted_thinking"))) {
      metadata(r, "assistant thinking block (no reported action)");
    } else unparsed(c, r, `assistant record with no recognized content blocks (${r.kind})`);
  }
}

function readUser(r: Rec, v: Obj, c: Collector, prio: number, channel: "stream_json" | "transcript"): void {
  const msg = v.message as Obj;
  const sid = r.session_id;
  if (typeof msg.content === "string") {
    r.kind = "user/prompt";
    if (v.isMeta === true) {
      metadata(r, "meta user message injected by Claude Code");
      return;
    }
    const pid = str(v.promptId) ?? str(v.prompt_id) ?? `u${str(v.uuid) ?? r.sha256.slice(0, 16)}`;
    c.add("user_prompt", `${sid ?? NO_SESSION}:user_prompt:${pid}`, sid, {
      rec: r,
      priority: prio,
      d: { text: msg.content, prompt_id: str(v.promptId), permission_mode: str(v.permissionMode) },
    });
    return;
  }
  const blocks = Array.isArray(msg.content) ? msg.content.filter(isObj) : [];
  const results = blocks.filter((b) => b.type === "tool_result" && str(b.tool_use_id));
  r.kind = `user/${blocks.map((b) => str(b.type) ?? "?").join(",") || "empty"}`;
  if (results.length === 0) {
    unparsed(c, r, `user record with no recognized content (${r.kind})`);
    return;
  }
  // stream: tool_result_meta[] keyed by id; transcript: one permissionDecision/toolDenialKind per record.
  // Both fields are UNDOCUMENTED (observed in 2.1.302 captures). UNVERIFIED as a stable API.
  const metaById = new Map<string, Obj>();
  if (Array.isArray(v.tool_result_meta)) {
    for (const m of v.tool_result_meta) if (isObj(m) && str(m.id)) metaById.set(str(m.id)!, m);
  }
  for (const b of results) {
    const id = str(b.tool_use_id)!;
    let meta: ToolItem["meta"] | undefined;
    if (channel === "stream_json") {
      const m = metaById.get(id);
      const pd = m && isObj(m.permission_decision) ? m.permission_decision : null;
      if (m)
        meta = {
          decision: pd ? str(pd.decision) : null,
          source: pd ? str(pd.source) : null,
          reason_type: pd ? str(pd.reason_type) : null,
          non_execution_kind: str(m.non_execution_kind),
        };
    } else if (results.length === 1 && (isObj(v.permissionDecision) || str(v.toolDenialKind))) {
      const pd = isObj(v.permissionDecision) ? v.permissionDecision : null;
      meta = {
        decision: pd ? str(pd.decision) : null,
        source: pd ? str(pd.source) : null,
        reason_type: pd ? str(pd.reasonType) : null,
        non_execution_kind: str(v.toolDenialKind),
      };
    }
    const isError = bool(b.is_error);
    const content = typeof b.content === "string" ? b.content : null;
    const tur = channel === "stream_json" ? v.tool_use_result : v.toolUseResult;
    const item: ToolItem = {
      rec: r,
      priority: prio,
      via: `${channel}:tool_result`,
      tool_name: null,
      input: null,
      agent_id: null,
      parent_tool_use_id: str(v.parent_tool_use_id),
      is_error: isError,
      error_text: isError ? content : null,
      result_summary: results.length === 1 ? summarizeToolResult(tur) : {},
    };
    if (meta) item.meta = meta;
    if (meta?.decision === "reject") item.status = "denied";
    else item.status = isError ? "failed" : "succeeded";
    c.addRes(sid, id, item);
  }
}

// ------------------------------------------------------------------------------------------------
// Assembly
// ------------------------------------------------------------------------------------------------

function sourceFor(channel: Channel): EventSource {
  // stream-json carries the same message objects (same uuids) as the transcript file; the schema has no
  // separate stream source, so both map to claude_code_transcript (PROPOSED: claude_code_stream_json).
  return channel === "hook_log" ? "claude_code_hooks" : "claude_code_transcript";
}

function pickPrimary<T extends { rec: Rec; priority: number }>(items: T[]): T | null {
  let best: T | null = null;
  for (const i of items) {
    if (
      !best ||
      i.priority < best.priority ||
      (i.priority === best.priority &&
        (CHANNEL_ORDER[i.rec.channel] < CHANNEL_ORDER[best.rec.channel] ||
          (i.rec.channel === best.rec.channel && i.rec.line < best.rec.line)))
    )
      best = i;
  }
  return best;
}

function uniqRefs(items: Array<{ rec: Rec }>, exclude: Rec | null): RecordRef[] {
  const seen = new Set<string>();
  const out: RecordRef[] = [];
  for (const { rec } of items) {
    if (rec === exclude || seen.has(rec.evidence_id)) continue;
    seen.add(rec.evidence_id);
    out.push(ref(rec));
  }
  return out;
}

function timestampFor(primary: Rec, items: Array<{ rec: Rec }>, ctx: ParseContext): { ts: string; basis: TimestampBasis } {
  if (primary.ts && (primary.ts_basis === "record" || primary.ts_basis === "hook_received_at"))
    return { ts: primary.ts, basis: primary.ts_basis };
  const direct = items.find((i) => i.rec.ts && (i.rec.ts_basis === "record" || i.rec.ts_basis === "hook_received_at"));
  if (direct) return { ts: direct.rec.ts!, basis: direct.rec.ts_basis };
  if (primary.ts) return { ts: primary.ts, basis: primary.ts_basis };
  return { ts: ctx.fallback_timestamp, basis: "run_fallback" };
}

export function extractTarget(tool: string | null, input: Obj | null): string | null {
  if (!tool || !input) return null;
  const s = (k: string) => str(input[k]);
  switch (tool) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return s("file_path");
    case "NotebookEdit":
      return s("notebook_path");
    case "Bash":
    case "PowerShell":
      return s("command");
    case "Glob":
    case "Grep": {
      const p = s("pattern");
      const path = s("path");
      return p === null ? path : path ? `${p} in ${path}` : p;
    }
    case "WebFetch":
      return s("url");
    case "WebSearch":
      return s("query");
    case "Task":
    case "Agent":
      return s("subagent_type") ?? s("description");
    case "Skill":
      return s("skill") ?? s("command");
    default:
      return null;
  }
}

interface Built {
  events: ReportedEvent[];
}

function buildEvent(
  ctx: ParseContext,
  primary: Rec,
  items: Array<{ rec: Rec }>,
  key: string,
  f: {
    event_type: ReportedEventType;
    outcome: Outcome;
    summary: string;
    tool_name?: string | null;
    tool_use_id?: string | null;
    target?: string | null;
    collection_status?: ReportedCollectionStatus;
    limitations?: string[];
    unavailable?: string[];
    detail?: Partial<ReportedEvent["detail"]>;
    session_id: string | null;
  },
): ReportedEvent {
  const r = redactorFor(ctx);
  const source = sourceFor(primary.channel);
  const { ts, basis } = timestampFor(primary, items, ctx);
  const limitations = [REPORTED_LIMITATION, CHANNEL_CUSTODY[primary.channel], ...(f.limitations ?? [])];
  if (basis === "neighbor_record")
    limitations.push("The source record has no timestamp; the timestamp is taken from an adjacent record (ordering hint only).");
  if (basis === "run_fallback") limitations.push("No captured record carries a timestamp; the run start time is used.");
  if (basis === "record" || basis === "hook_received_at")
    limitations.push("Timestamp comes from the agent container's clock.");
  const id = makeEventId({ run_id: ctx.run_id, basis: "reported", source, source_native_key: key });
  const target = f.target == null ? null : r(f.target);
  return {
    id,
    run_id: ctx.run_id,
    is_fixture: ctx.is_fixture ?? false,
    basis: "reported",
    source,
    source_native_key: key,
    source_sequence: primary.line,
    event_type: f.event_type,
    timestamp: ts,
    process_id: null,
    parent_process_id: null,
    process_name: null,
    tool_name: f.tool_name ?? null,
    tool_use_id: f.tool_use_id ?? null,
    target_resource: target,
    outcome: f.outcome,
    evidence_id: primary.evidence_id,
    attribution_confidence: null,
    collection_status: f.collection_status ?? "complete",
    unavailable_fields: [...NOT_PROVIDED, ...(f.unavailable ?? [])],
    limitations,
    summary: truncate(oneLine(r(f.summary)), 300),
    raw_summary: `${primary.locator} ${primary.kind}`,
    detail: {
      channel: primary.channel,
      record_kind: primary.kind,
      session_id: f.session_id,
      phase: null,
      logical_key: null,
      timestamp_basis: basis,
      corroborating: uniqRefs(items, primary),
      hook_events: [],
      permission: null,
      agent_id: null,
      parent_tool_use_id: null,
      is_error: null,
      error_text: null,
      duration_ms: null,
      text: null,
      conflicts: [],
      extra: {},
      ...f.detail,
      // Free-form record fields (cwd, hook fields, permission reason text...) are redacted too.
      ...(f.detail?.extra ? { extra: redactDeepStrings(f.detail.extra, r) as Obj } : {}),
      ...(f.detail?.permission ? { permission: redactDeepStrings(f.detail.permission, r) as ReportedEvent["detail"]["permission"] } : {}),
    },
  };
}

const rawRedactor = (x: string) => x;
const redactors = new WeakMap<ParseContext, (text: string) => string>();

/**
 * The redactor for every free-text field this adapter copies out of records. The @kw/redaction default redactor
 * ALWAYS runs (fail closed: a detector error yields "[REDACTION_FAILED]"); ctx.redact can only add redaction on top.
 * Only the explicit rawMode "unsafe_raw_for_restricted_blob_store" disables it.
 */
function redactorFor(ctx: ParseContext): (text: string) => string {
  if (ctx.rawMode === "unsafe_raw_for_restricted_blob_store") return rawRedactor;
  let fn = redactors.get(ctx);
  if (!fn) {
    // keepCleanTextVerbatim: fields are redacted at several steps (target, then the summary built from it); a second
    // pass must not mangle earlier placeholders.
    const builtIn = defaultRedactor({ ...ctx.redaction, keepCleanTextVerbatim: true });
    const extra = ctx.redact;
    fn = extra ? (text: string) => builtIn(extra(text)) : builtIn;
    redactors.set(ctx, fn);
  }
  return fn;
}

function redactDeepStrings(v: unknown, r: (text: string) => string, depth = 0): unknown {
  if (typeof v === "string") return r(v);
  if (depth > 8) return null; // pathological nesting: drop rather than copy unredacted
  if (Array.isArray(v)) return v.map((x) => redactDeepStrings(x, r, depth + 1));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeepStrings(x, r, depth + 1)]));
  return v;
}

function link(ev: ReportedEvent, primary: Rec, items: Array<{ rec: Rec }>): void {
  primary.disposition = primary.disposition === "unparsed" ? "unparsed" : "event";
  primary.event_ids.add(ev.id);
  for (const { rec } of items) rec.event_ids.add(ev.id);
}

function buildToolEvents(t: ToolCall, ctx: ParseContext, out: Built, warnings: string[]): void {
  const r = redactorFor(ctx);
  const all = [...t.req, ...t.res];
  const byPrio = [...all].sort((a, b) => a.priority - b.priority);
  const toolName = byPrio.find((i) => i.tool_name)?.tool_name ?? null;
  const convReq = t.req.filter((i) => i.via.endsWith(":tool_use"));
  const hookReq = t.req.filter((i) => i.via === "hook:PreToolUse");
  const input =
    pickPrimary(convReq)?.input ?? pickPrimary(hookReq)?.input ?? byPrio.find((i) => i.input)?.input ?? null;
  // Redacted once, BEFORE any truncation, so a cut can never leave part of a secret behind.
  const rawTarget = extractTarget(toolName, input);
  const target = rawTarget == null ? null : r(rawTarget);
  const hookEvents = [...new Set(all.filter((i) => i.rec.channel === "hook_log").map((i) => i.via.replace("hook:", "")))];
  const agentId = all.find((i) => i.agent_id)?.agent_id ?? null;
  const parent = all.find((i) => i.parent_tool_use_id)?.parent_tool_use_id ?? null;
  const conflicts: string[] = [];
  const ci = pickPrimary(convReq)?.input;
  const hi = pickPrimary(hookReq)?.input;
  if (ci && hi && canonicalJson(ci) !== canonicalJson(hi)) {
    conflicts.push("PreToolUse hook tool_input differs from the model's tool_use input (a hook may have rewritten it)");
  }
  const unavailable: string[] = [];
  if (!toolName) unavailable.push("tool_name");
  if (target === null) unavailable.push("target_resource");
  const sid = t.session_id === NO_SESSION ? null : t.session_id;
  const keyBase = `${t.session_id}:${t.tool_use_id}`;
  const label = `${toolName ?? "tool"}`;
  const tgt = target ? `: ${truncate(oneLine(target), 160)}` : "";

  // ---- requested ----
  const reqPrimaryItem = pickPrimary(t.req.filter((i) => i.via.endsWith(":tool_use") || i.via === "hook:PreToolUse")) ?? pickPrimary(t.req);
  const reqLimitations: string[] = [];
  let reqStatus: ReportedCollectionStatus = "complete";
  let reqPrimary: Rec;
  if (reqPrimaryItem) reqPrimary = reqPrimaryItem.rec;
  else {
    reqPrimary = pickPrimary(t.res)!.rec;
    reqStatus = "partial";
    reqLimitations.push("No request record was captured; the request is inferred from the result record.");
  }
  if (convReq.length === 0 && t.req.length > 0)
    reqLimitations.push("The model's tool_use record (stream-json/transcript) was not captured for this call.");
  const reqEv = buildEvent(ctx, reqPrimary, t.req.length ? t.req : t.res, `${keyBase}:requested`, {
    event_type: "tool_call",
    outcome: "attempted",
    summary: `${label} requested${tgt}`,
    tool_name: toolName,
    tool_use_id: t.tool_use_id,
    target,
    collection_status: reqStatus,
    limitations: reqLimitations,
    unavailable,
    session_id: sid,
    detail: {
      phase: "requested",
      logical_key: `tool_use:${t.tool_use_id}:requested`,
      hook_events: hookEvents,
      agent_id: agentId,
      parent_tool_use_id: parent,
      conflicts,
      extra: { input_keys: input ? Object.keys(input).sort() : null, via: reqPrimaryItem?.via ?? "inferred" },
    },
  });
  link(reqEv, reqPrimary, t.req);
  out.events.push(reqEv);

  // ---- resolved ----
  const denied = t.res.some((i) => i.status === "denied");
  const convRes = t.res.filter((i) => i.via.endsWith(":tool_result"));
  const hookRes = t.res.filter((i) => i.via === "hook:PostToolUse" || i.via === "hook:PostToolUseFailure");
  let status: "succeeded" | "failed" | "denied" | "unknown";
  if (denied) status = "denied";
  else if (convRes.length) status = pickPrimary(convRes)!.status as "succeeded" | "failed";
  else if (hookRes.length) status = pickPrimary(hookRes)!.status as "succeeded" | "failed";
  else status = "unknown";
  // No permission metadata and no PostToolUseFailure hook (which fires only after the tool ran): an error
  // whose text is a Claude Code permission denial means the call was not executed (e.g. the validation-stage
  // deny-rule Read in run1, seen in the transcript alone). Classified from error text: inferred.
  let deniedFromErrorText = false;
  if (
    status === "failed" &&
    !t.res.some((i) => i.meta) &&
    !t.res.some((i) => i.via === "hook:PostToolUseFailure" || i.via === "hook:PostToolUse")
  ) {
    const txt = pickPrimary(t.res.filter((i) => i.error_text))?.error_text ?? "";
    if (denialKindFromText(txt)) {
      status = "denied";
      deniedFromErrorText = true;
    }
  }
  const resConflicts: string[] = [];
  const statuses = new Set([...convRes, ...hookRes].map((i) => i.status));
  if (statuses.size > 1 && !deniedFromErrorText) resConflicts.push(`channels disagree on the result: ${[...statuses].sort().join(" vs ")}`);
  if (denied && t.res.some((i) => i.via === "hook:PostToolUse"))
    resConflicts.push("a denial is reported, but a PostToolUse hook also fired for this call");

  const permission = permissionInfo(t, status);
  const errorText =
    pickPrimary(t.res.filter((i) => i.error_text))?.error_text ?? null;
  const duration = t.res.find((i) => i.duration_ms != null)?.duration_ms ?? null;
  const resPrimaryItem = pickPrimary(t.res);
  const resLimitations: string[] = [];
  let resStatus: ReportedCollectionStatus = "complete";
  let resPrimary: Rec;
  if (resPrimaryItem) resPrimary = resPrimaryItem.rec;
  else {
    resPrimary = reqPrimary;
    resStatus = "partial";
    resLimitations.push("No result record was captured for this tool call (the run may have ended early or capture is incomplete).");
  }
  if (status === "succeeded")
    resLimitations.push("A reported success does not prove the effect happened or persisted; compare with observed events.");
  if (status === "denied")
    resLimitations.push(
      "A reported denial means Claude Code did not run this tool call; it does not establish that the resource was not reached another way.",
    );
  if (toolName === "Bash" || toolName === "PowerShell")
    resLimitations.push("Shell results do not enumerate the child processes or files the command touched.");
  if (resConflicts.length) resStatus = "partial";
  if (permission.evidence === "permission_metadata")
    resLimitations.push("Permission detail comes from undocumented Claude Code 2.1.302 record fields (UNVERIFIED as a stable API).");
  if (permission.evidence === "error_text")
    resLimitations.push("The denial reason is inferred from Claude Code's error text (version-specific wording); treat it as an inferred classification.");
  if (permission.permission_request_hook_fired)
    resLimitations.push("PermissionRequest hook records carry no tool_use_id; they were linked to this call by exact tool_name + tool_input match (inferred).");

  const outcome: Outcome = status === "unknown" ? "unknown" : status;
  const verb =
    status === "denied"
      ? `denied (${DENY_LABEL[permission.kind]})`
      : status === "unknown"
        ? "result not captured"
        : status;
  const resEv = buildEvent(ctx, resPrimary, t.res.length ? t.res : t.req, `${keyBase}:resolved`, {
    event_type: status === "denied" ? "permission_decision" : "tool_result",
    outcome,
    summary: `${label} ${verb}${tgt}`,
    tool_name: toolName,
    tool_use_id: t.tool_use_id,
    target,
    collection_status: resStatus,
    limitations: resLimitations,
    unavailable,
    session_id: sid,
    detail: {
      phase: "resolved",
      logical_key: `tool_use:${t.tool_use_id}:resolved`,
      hook_events: hookEvents,
      permission,
      agent_id: agentId,
      parent_tool_use_id: parent,
      is_error: status === "unknown" ? null : status !== "succeeded",
      error_text: errorText == null ? null : r(errorText),
      duration_ms: duration,
      conflicts: resConflicts,
      extra: {
        via: resPrimaryItem?.via ?? "none",
        result: t.res.find((i) => i.result_summary && Object.keys(i.result_summary).length)?.result_summary ?? null,
      },
    },
  });
  link(resEv, resPrimary, t.res);
  out.events.push(resEv);
  for (const cf of [...conflicts, ...resConflicts]) warnings.push(`${t.tool_use_id}: ${cf}`);
}

const DENY_LABEL: Record<PermissionKind, string> = {
  allowed: "allowed",
  hook_deny: "by PreToolUse hook",
  permission_rule_deny: "by permission rule",
  approval_unavailable_deny: "approval required, no approver in headless mode",
  auto_mode_deny: "by auto-mode classifier",
  unknown_deny: "reason not reported",
  unknown: "unknown",
};

/** Denial reason from Claude Code's error text (2.1.302 wording; version-specific, so always "inferred"). */
function denialKindFromText(txt: string): PermissionKind | null {
  if (/blocked by a PreToolUse hook|PreToolUse:\S+ hook error/i.test(txt)) return "hook_deny";
  if (/denied by your permission settings|matches a deny rule/i.test(txt)) return "permission_rule_deny";
  if (/requires approval|requested permissions/i.test(txt)) return "approval_unavailable_deny";
  return null;
}

function permissionInfo(t: ToolCall, status: string): PermissionInfo {
  const metaItem = pickPrimary(t.res.filter((i) => i.meta));
  const meta = metaItem?.meta ?? null;
  const listed = t.res.some((i) => i.denial_listed);
  const streamDenied = t.res.find((i) => i.stream_denied)?.stream_denied ?? null;
  const auto = t.res.find((i) => i.via === "hook:PermissionDenied");
  const prFired = t.req.some((i) => i.permission_request);
  const errorText = t.res.find((i) => i.error_text)?.error_text ?? null;
  const info: PermissionInfo = {
    kind: "unknown",
    decision: "unknown",
    evidence: "none",
    cc_decision: meta?.decision ?? null,
    cc_source: meta?.source ?? null,
    cc_reason_type: meta?.reason_type ?? streamDenied?.reason_type ?? null,
    cc_non_execution_kind: meta?.non_execution_kind ?? null,
    listed_in_result_permission_denials: listed,
    stream_permission_denied_message: streamDenied !== null,
    permission_request_hook_fired: prFired,
    reason_text: auto?.auto_denied_reason ?? streamDenied?.message ?? null,
  };
  if (status !== "denied") {
    if (meta?.decision === "accept") {
      info.kind = "allowed";
      info.decision = "allowed";
      info.evidence = "permission_metadata";
    } else if (
      status === "succeeded" ||
      (status === "failed" && t.res.some((i) => i.via === "hook:PostToolUseFailure"))
    ) {
      // A success result, or a PostToolUseFailure hook (fires only after execution; validation-stage
      // rejections fire no hook, hooks.md), means Claude Code's permission check let the call run.
      info.kind = "allowed";
      info.decision = "allowed";
      info.evidence = "inferred_from_result";
      info.reason_text = info.reason_text ?? "inferred: the tool reported an execution result, so it was executed";
    } else if (status === "failed") {
      // An error result alone does not show the tool ran: validation and permission rejections are also
      // returned as error results. Without permission metadata the decision stays unknown.
      info.reason_text =
        info.reason_text ?? "the tool reported an error and no permission metadata was captured; whether it was executed is unknown";
    }
    return info;
  }
  info.decision = "denied";
  if (meta?.decision === "reject") {
    info.evidence = "permission_metadata";
    if (meta.source === "hook") info.kind = "hook_deny";
    else if (meta.non_execution_kind === "permission-rule") info.kind = "permission_rule_deny";
    else if (meta.non_execution_kind === "user-rejected") info.kind = "approval_unavailable_deny";
    else info.kind = "unknown_deny";
    return info;
  }
  if (auto) {
    info.kind = "auto_mode_deny";
    info.evidence = "hook_payload";
    return info;
  }
  const txt = errorText ?? streamDenied?.message ?? "";
  const fromText = denialKindFromText(txt);
  if (fromText) {
    info.kind = fromText;
    info.evidence = "error_text";
  } else {
    info.kind = "unknown_deny";
    info.evidence = "denial_list_only";
  }
  return info;
}

function buildGroupEvent(g: Group, ctx: ParseContext, out: Built): void {
  const p = pickPrimary(g.items)!;
  const d = p.d;
  const r = redactorFor(ctx);
  const sid = g.session_id;
  const t = (x: unknown) => (typeof x === "string" ? x : null);
  let ev: ReportedEvent;
  const merged = (k: string): unknown => {
    for (const i of [...g.items].sort((a, b) => a.priority - b.priority)) if (i.d[k] != null) return i.d[k];
    return null;
  };
  switch (g.kind) {
    case "session_start": {
      const extra: Obj = {};
      for (const k of ["model", "permission_mode", "claude_code_version", "cwd", "transcript_path", "source", "api_key_source", "tools_count", "mcp_servers"])
        extra[k] = merged(k);
      ev = buildEvent(ctx, p.rec, g.items, g.key, {
        event_type: "session_start",
        outcome: "succeeded",
        summary: `Claude Code session started${extra.model ? ` (model ${String(extra.model)})` : ""}`,
        session_id: sid,
        detail: { extra },
      });
      break;
    }
    case "session_end":
      ev = buildEvent(ctx, p.rec, g.items, g.key, {
        event_type: "session_end",
        outcome: "succeeded",
        summary: `Claude Code session ended${d.reason ? ` (${String(d.reason)})` : ""}`,
        session_id: sid,
        detail: { extra: { reason: d.reason } },
      });
      break;
    case "user_prompt": {
      const text = t(merged("text"));
      ev = buildEvent(ctx, p.rec, g.items, g.key, {
        event_type: "user_prompt",
        outcome: "succeeded",
        summary: `Task prompt submitted: "${truncate(oneLine(r(text ?? "")), 120)}"`,
        session_id: sid,
        detail: { text: text == null ? null : r(text), extra: { prompt_id: merged("prompt_id"), permission_mode: merged("permission_mode") } },
      });
      break;
    }
    case "agent_message": {
      const text = t(d.text);
      ev = buildEvent(ctx, p.rec, g.items, g.key, {
        event_type: "agent_message",
        outcome: "succeeded",
        summary: `Assistant: ${truncate(oneLine(r(text ?? "")), 160)}`,
        session_id: sid,
        detail: { text: text == null ? null : r(text), parent_tool_use_id: t(d.parent_tool_use_id), extra: { model: d.model } },
      });
      break;
    }
    case "final_report": {
      const fromResult = d.via === "stream:result";
      const text = t(d.text) ?? t(merged("text"));
      const limitations = ["The final report is the agent's own narrative; it must be checked against observed events."];
      if (!fromResult) limitations.push("No stream-json result message was captured; the text is the Stop hook's last_assistant_message.");
      const failed = fromResult && (d.is_error === true || (d.subtype !== null && d.subtype !== "success"));
      const extra: Obj = { kind: "final_report" };
      for (const k of ["subtype", "is_error", "num_turns", "stop_reason", "terminal_reason", "duration_ms", "total_cost_usd", "permission_denial_tool_use_ids"])
        if (d[k] !== undefined) extra[k] = d[k];
      extra.stop_hook_records = g.items.filter((i) => i.d.via === "hook:Stop").length;
      ev = buildEvent(ctx, p.rec, g.items, g.key, {
        event_type: "agent_message",
        outcome: failed ? "failed" : "succeeded",
        summary: `Final report: ${truncate(oneLine(r(text ?? "")), 160)}`,
        session_id: sid,
        limitations,
        detail: { text: text == null ? null : r(text), is_error: fromResult ? (d.is_error as boolean | null) : null, extra },
      });
      break;
    }
    case "instructions_loaded":
      ev = buildEvent(ctx, p.rec, g.items, g.key, {
        event_type: "instructions_loaded",
        outcome: "succeeded",
        summary: `Instructions loaded: ${t(d.target) ?? "?"}${d.load_reason ? ` (${String(d.load_reason)})` : ""}`,
        target: t(d.target),
        session_id: sid,
        limitations: ["Loading an instruction file does not mean the agent followed it."],
        detail: { extra: { memory_type: d.memory_type, load_reason: d.load_reason } },
      });
      break;
    case "config_change":
      ev = buildEvent(ctx, p.rec, g.items, g.key, {
        event_type: "config_change",
        outcome: "succeeded",
        summary: `Claude Code configuration changed: ${t(d.target) ?? "?"}${d.source ? ` (${String(d.source)})` : ""}`,
        target: t(d.target),
        session_id: sid,
        limitations: ["ConfigChange says Claude Code noticed a settings change; it does not say who or what changed it."],
        detail: { extra: { source: d.source } },
      });
      break;
    case "file_changed": {
      const change = t(d.change);
      const type: ReportedEventType =
        change === "add" ? "file_create" : change === "change" ? "file_write" : change === "unlink" ? "file_delete" : "agent_lifecycle";
      ev = buildEvent(ctx, p.rec, g.items, g.key, {
        event_type: type,
        outcome: "succeeded",
        summary: `Claude Code file watcher: ${change ?? "?"} ${t(d.target) ?? "?"}`,
        target: t(d.target),
        session_id: sid,
        limitations: [
          "Reported by Claude Code's own file watcher, which only watches the literal filenames configured in the FileChanged matcher; it does not say what changed the file.",
        ],
        detail: { extra: { change } },
      });
      break;
    }
    case "lifecycle": {
      const he = t(d.hook_event) ?? "?";
      ev = buildEvent(ctx, p.rec, g.items, g.key, {
        event_type: "agent_lifecycle",
        outcome: he === "StopFailure" ? "failed" : "succeeded",
        summary: `Claude Code ${he} hook event`,
        session_id: sid,
        detail: { extra: { hook_event: he, ...(isObj(d.fields) ? d.fields : {}) } },
      });
      break;
    }
    case "hook_execution": {
      const ok = (d.exit_code === 0 || d.exit_code == null) && (d.outcome === "success" || d.outcome == null);
      ev = buildEvent(ctx, p.rec, g.items, g.key, {
        event_type: "hook_execution",
        outcome: ok ? "succeeded" : "failed",
        summary: `Hook ${t(d.hook_name) ?? "?"} exit ${String(d.exit_code ?? "?")} (${t(d.outcome) ?? "?"})${d.decision ? `, decision ${String(d.decision)}` : ""}`,
        session_id: sid,
        limitations: ["stream-json hook_response records carry no tool_use_id; the tool call this hook ran for is not identified."],
        detail: { extra: { hook_name: d.hook_name, hook_event: d.hook_event, exit_code: d.exit_code, outcome: d.outcome, decision: d.decision } },
      });
      break;
    }
    case "raw":
      ev = buildEvent(ctx, p.rec, g.items, g.key, {
        event_type: "raw_record",
        outcome: "unknown",
        collection_status: "unparsed",
        summary: `Unparsed ${p.rec.channel} record (${p.rec.kind}): ${String(d.reason)}`,
        session_id: sid,
        limitations: ["The record was preserved but not understood by the adapter; it may describe actions not shown elsewhere."],
        detail: { extra: { reason: d.reason } },
      });
      break;
  }
  link(ev, p.rec, g.items);
  out.events.push(ev);
}

function attachPermissionRequests(c: Collector): void {
  const pending = c.pendingPR;
  const occ = new Occurrences();
  for (const { r, p } of pending) {
    const sid = str(p.session_id);
    const tool = str(p.tool_name);
    const input = isObj(p.tool_input) ? p.tool_input : null;
    const matches = c.findToolsByInput(sid, tool, input);
    if (matches.length >= 1) {
      // Several identical calls: attach to the earliest call still lacking a request marker.
      const target = matches.find((m) => !m.req.some((i) => i.permission_request)) ?? matches[0]!;
      c.addReq(sid, target.tool_use_id, {
        rec: r,
        priority: 8,
        via: "hook:PermissionRequest",
        tool_name: tool,
        input,
        agent_id: str(p.agent_id),
        parent_tool_use_id: null,
        permission_request: true,
      });
      if (matches.length > 1) c.warnings.push(`${r.locator}: PermissionRequest matched ${matches.length} identical tool calls`);
    } else {
      c.add("lifecycle", hookKey(sid, "PermissionRequest", p, occ), sid, {
        rec: r,
        priority: 3,
        d: { hook_event: "PermissionRequest", fields: { tool_name: tool } },
      });
      c.warnings.push(`${r.locator}: PermissionRequest could not be matched to a tool call by tool_name + tool_input`);
    }
  }
}

function toEvidence(rec: Rec, ctx: ParseContext): Evidence {
  return {
    id: rec.evidence_id,
    run_id: ctx.run_id,
    is_fixture: ctx.is_fixture ?? false,
    source_type: rec.channel === "hook_log" ? "hook_payload" : "transcript_entry",
    source_reference: rec.locator,
    timestamp: rec.ts ?? ctx.fallback_timestamp,
    integrity_metadata: {
      algorithm: "sha256",
      sha256: rec.sha256,
      size_bytes: rec.bytes,
      captured_by:
        rec.channel === "hook_log"
          ? "kw-hook forwarder (agent container)"
          : rec.channel === "stream_json"
            ? "host capture of claude -p stdout"
            : "Claude Code transcript file (agent container)",
      note: `Hash of the UTF-8 line without its newline. ${CHANNEL_CUSTODY[rec.channel]}`,
    },
    redaction_status: "not_scanned",
    excerpt: null,
  };
}

/** Parse any subset of a run's agent-side outputs into normalized reported events. Pure; no I/O. */
export function parseRunOutputs(outputs: RunOutputs, ctx: ParseContext): ParseResult {
  if (!isoOrNull(ctx.fallback_timestamp)) throw new Error("ParseContext.fallback_timestamp must be an ISO-8601 timestamp");
  const stream = readChannel("stream_json", outputs.streamJson, ctx);
  const transcriptInputs = Array.isArray(outputs.transcript) ? outputs.transcript : [outputs.transcript];
  const labels = new Set<string>();
  const transcript: Rec[] = [];
  transcriptInputs.forEach((t, i) => {
    if (t == null) return;
    const label = typeof t === "string" ? (i === 0 ? DEFAULT_LABEL.transcript : `transcript-${i}.jsonl`) : (t.label ?? `transcript-${i}.jsonl`);
    if (labels.has(label)) throw new Error(`duplicate transcript label "${label}"`);
    labels.add(label);
    transcript.push(...readChannel("transcript", { text: typeof t === "string" ? t : t.text, label }, ctx));
  });
  const hooks = readChannel("hook_log", outputs.hookLog, ctx);
  const c = new Collector();
  readConversation(stream, c, "stream_json");
  readConversation(transcript, c, "transcript");
  readHookLog(hooks, c);
  attachPermissionRequests(c);
  for (const recs of [stream, transcript, hooks]) fillNeighborTimestamps(recs);

  const out: Built = { events: [] };
  const warnings = [...c.warnings];
  for (const t of [...c.tools.values()].sort((a, b) => a.first_seen - b.first_seen)) buildToolEvents(t, ctx, out, warnings);
  for (const g of c.groups.values()) buildGroupEvent(g, ctx, out);

  const all = [...stream, ...transcript, ...hooks];
  for (const r of all) {
    if (r.disposition === null) {
      // Defensive: every record must be accounted for. Should be unreachable.
      r.disposition = "unparsed";
      r.reason = "record was not consumed by any parser";
      warnings.push(`${r.locator}: record was not consumed by any parser`);
    }
  }

  const order = (e: ReportedEvent) => CHANNEL_ORDER[e.detail.channel];
  out.events.sort(
    (a, b) =>
      timeKey(a.timestamp) - timeKey(b.timestamp) ||
      (a.detail.phase === "requested" ? 0 : 1) - (b.detail.phase === "requested" ? 0 : 1) ||
      order(a) - order(b) ||
      (a.source_sequence ?? 0) - (b.source_sequence ?? 0) ||
      a.id.localeCompare(b.id),
  );

  const stats = {} as ParseResult["stats"];
  for (const [ch, recs] of [["stream_json", stream], ["transcript", transcript], ["hook_log", hooks]] as const) {
    stats[ch] = { lines: recs.length, events: 0, corroboration: 0, metadata: 0, unparsed: 0 };
    for (const r of recs) {
      const k = r.disposition === "event" ? "events" : r.disposition!;
      stats[ch][k as "events" | "corroboration" | "metadata" | "unparsed"]++;
    }
  }

  const records: ParsedRecord[] = all.map((r) => ({
    evidence_id: r.evidence_id,
    channel: r.channel,
    line: r.line,
    locator: r.locator,
    record_kind: r.kind,
    session_id: r.session_id,
    disposition: r.disposition!,
    reason: r.reason,
    event_ids: [...r.event_ids].sort(),
  }));

  const tools = [...c.tools.values()];
  const finals = out.events.filter((e) => e.detail.extra.kind === "final_report");
  const hookSupplied = hooks.length > 0;
  const convSupplied = stream.length + transcript.length > 0;
  const completeness: Completeness = {
    result_message_present: finals.some((e) => e.detail.record_kind.startsWith("result")),
    session_end_hook_present: out.events.some((e) => e.event_type === "session_end"),
    tool_calls_without_result: out.events
      .filter((e) => e.detail.phase === "resolved" && e.outcome === "unknown")
      .map((e) => e.tool_use_id!)
      .sort(),
    tool_calls_missing_from_hook_log:
      hookSupplied && convSupplied
        ? tools.filter((t) => ![...t.req, ...t.res].some((i) => i.rec.channel === "hook_log")).map((t) => t.tool_use_id).sort()
        : [],
    unparsed_records: all.filter((r) => r.disposition === "unparsed").length,
    agent_record_complete: false,
  };
  completeness.agent_record_complete =
    completeness.result_message_present &&
    completeness.session_end_hook_present &&
    completeness.tool_calls_without_result.length === 0 &&
    completeness.unparsed_records === 0;

  return {
    events: out.events,
    completeness,
    evidence: all.map((r) => toEvidence(r, ctx)),
    records,
    session_ids: [...new Set(all.map((r) => r.session_id).filter((s): s is string => !!s))].sort(),
    warnings,
    stats,
  };
}

/** transcript_path / agent_transcript_path values reported in hook payloads (where to copy transcripts from). */
export function transcriptPathsFromHookLog(hookLog: string): string[] {
  const out = new Set<string>();
  for (const { text } of splitLines(hookLog)) {
    try {
      const v: unknown = JSON.parse(text);
      if (!isObj(v) || !isObj(v.payload)) continue;
      for (const k of ["transcript_path", "agent_transcript_path"]) if (str(v.payload[k])) out.add(str(v.payload[k])!);
    } catch {
      /* skip */
    }
  }
  return [...out].sort();
}
