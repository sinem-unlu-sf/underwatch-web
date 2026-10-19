// Helpers for hand-authoring synthetic fixture runs. Nothing here observes anything: it only assembles records
// so that IDs are computed with the schema helpers instead of hand-typed.
import {
  EVENT_SOURCE_BASIS,
  fixtureRunId,
  makeEventId,
  sha256Hex,
  type CollectionStatus,
  type Confidence,
  type CorrelationMatch,
  type EventSource,
  type EventType,
  type EvidenceSourceType,
  type FixtureRunFileInput,
  type Outcome,
  type RedactionStatus,
} from "../../packages/schema/src/index";

export type FixtureEvent = FixtureRunFileInput["events"][number];
export type FixtureEvidence = FixtureRunFileInput["evidence"][number];
export type FixtureFinding = FixtureRunFileInput["findings"][number];
export type FixtureStatusChange = FixtureRunFileInput["finding_status_history"][number];
export type FixtureSafeguard = FixtureRunFileInput["safeguards"][number];
export type FixtureCorrelation = NonNullable<FixtureRunFileInput["correlations"]>[number];
export type FixtureCoverage = FixtureRunFileInput["coverage"];
export type FixturePolicy = FixtureRunFileInput["policy_version"];

export const REPO_ID = "fixture/demo-repo";
export const CWD = "/workspace/demo-repo";
export const FIXTURE_ACTOR = "fixture-author";
export const FIXTURE_REVIEWER = "fixture-reviewer";

const INTEGRITY_NOTE = "Synthetic fixture excerpt written by hand; no raw bytes were captured, so no hash is recorded.";

/** Pseudo raw-log file each source's evidence lines point into (fixture://<fixture_id>/<file>#L<n>). */
const SOURCE_FILE: Record<EventSource, { file: string; type: EvidenceSourceType } | null> = {
  claude_code_hooks: { file: "hooks.jsonl", type: "hook_payload" },
  claude_code_transcript: { file: "transcript.jsonl", type: "transcript_entry" },
  claude_code_otel: { file: "otel.jsonl", type: "otel_record" },
  process_tracer: { file: "observed.jsonl", type: "process_trace" },
  kernel_tracer: { file: "kernel-trace.jsonl", type: "kernel_trace" },
  file_watcher: { file: "file-watcher.log", type: "file_event_log" },
  network_proxy: { file: "proxy.log", type: "network_log" },
  git_observer: { file: "git-diff.patch", type: "git_diff" },
  sandbox_runtime: { file: "sandbox.log", type: "collector_log" },
  kw_correlator: null,
  kw_policy_engine: null,
};

export const abs = (rel: string) => `${CWD}/${rel}`;

export interface EventSpec {
  source: EventSource;
  key: string;
  type: EventType;
  at: string;
  outcome: Outcome;
  summary: string;
  raw?: string | null;
  /** Evidence excerpt; defaults to `raw`. Pass null to withhold. */
  excerpt?: string | null;
  redaction?: RedactionStatus;
  /** Override the evidence pseudo-file (e.g. collector status lines go to collector.log). */
  evidenceFile?: { file: string; type: EvidenceSourceType };
  noEvidence?: boolean;
  pid?: number | null;
  ppid?: number | null;
  pname?: string | null;
  tool?: string | null;
  toolUseId?: string | null;
  target?: string | null;
  attribution?: Confidence | null;
  status?: CollectionStatus;
  unavailable?: string[];
  limitations?: string[];
}

export type ToolResult =
  | { kind: "ok"; response: unknown; durationMs: number; summary?: string }
  | { kind: "fail"; error: string; durationMs: number }
  | { kind: "hook_deny"; reason: string };

export interface ToolUse {
  call: string;
  decision: string | null;
  result: string;
}

const FILE_OPEN_LIMITATION = "A successful open does not by itself prove the file contents were read.";
const WRITE_LIMITATION = "Written bytes are not captured by the process tracer; see the repository diff for content.";
const GIT_LIMITATION = "A repository diff shows final state only; it does not identify which process made the change.";
const HOOK_LIMITATION = "Hook payloads are the agent runtime's own account of the tool call; they do not show OS-level side effects.";

export class RunBuilder {
  readonly runId: string;
  readonly short: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly events: FixtureEvent[] = [];
  readonly evidence: FixtureEvidence[] = [];
  readonly correlations: FixtureCorrelation[] = [];
  readonly findings: FixtureFinding[] = [];
  readonly history: FixtureStatusChange[] = [];
  readonly safeguards: FixtureSafeguard[] = [];
  private readonly base: number;
  private readonly lines = new Map<string, number>();
  private readonly seq = new Map<EventSource, number>();
  private readonly tagged = new Map<string, string>();

  constructor(
    readonly fixtureId: string,
    startIso: string,
  ) {
    this.runId = fixtureRunId(fixtureId);
    this.short = fixtureId.slice(0, 5).replace("-", "");
    this.sessionId = `fixture-session-${this.short}`;
    this.promptId = `fixture-prompt-${this.short}`;
    this.base = Date.parse(startIso);
  }

  /** Timestamp `sec` seconds after run start. */
  at(sec: number): string {
    return new Date(this.base + Math.round(sec * 1000)).toISOString();
  }

  /** Remember an event id under a name so findings/correlations can refer to it. */
  tag(name: string, id: string): string {
    this.tagged.set(name, id);
    return id;
  }

  id(name: string): string {
    const v = this.tagged.get(name);
    if (!v) throw new Error(`${this.fixtureId}: unknown event tag ${name}`);
    return v;
  }

  /** Evidence id attached to an event (throws for derived events, which carry none). */
  evidenceOf(eventId: string): string {
    const e = this.events.find((x) => x.id === eventId);
    if (!e?.evidence_id) throw new Error(`${this.fixtureId}: event ${eventId} has no evidence`);
    return e.evidence_id;
  }

  evd(file: string, type: EvidenceSourceType, at: string, excerpt: string | null, redaction: RedactionStatus = "not_scanned"): string {
    const n = (this.lines.get(file) ?? 0) + 1;
    this.lines.set(file, n);
    const id = `evd_${this.short}_${String(this.evidence.length + 1).padStart(3, "0")}`;
    this.evidence.push({
      id,
      run_id: this.runId,
      is_fixture: true,
      source_type: type,
      source_reference: `fixture://${this.fixtureId.slice(0, 5)}/${file}#L${n}`,
      timestamp: at,
      integrity_metadata: { algorithm: "sha256", sha256: null, size_bytes: null, captured_by: "hand-authored fixture", note: INTEGRITY_NOTE },
      redaction_status: redaction,
      excerpt,
    });
    return id;
  }

  event(s: EventSpec): string {
    const basis = EVENT_SOURCE_BASIS[s.source];
    const id = makeEventId({ run_id: this.runId, basis, source: s.source, source_native_key: s.key });
    const n = (this.seq.get(s.source) ?? 0) + 1;
    this.seq.set(s.source, n);
    const where = s.evidenceFile ?? SOURCE_FILE[s.source];
    const raw = s.raw ?? null;
    const excerpt = s.excerpt === undefined ? raw : s.excerpt;
    const evidenceId = s.noEvidence || !where ? null : this.evd(where.file, where.type, s.at, excerpt, s.redaction);
    const unavailable = s.unavailable ?? [];
    this.events.push({
      id,
      run_id: this.runId,
      is_fixture: true,
      basis,
      source: s.source,
      source_native_key: s.key,
      source_sequence: n,
      event_type: s.type,
      timestamp: s.at,
      process_id: s.pid ?? null,
      parent_process_id: s.ppid ?? null,
      process_name: s.pname ?? null,
      tool_name: s.tool ?? null,
      tool_use_id: s.toolUseId ?? null,
      target_resource: s.target ?? null,
      outcome: s.outcome,
      evidence_id: evidenceId,
      attribution_confidence: s.attribution ?? null,
      collection_status: s.status ?? (unavailable.length > 0 ? "partial" : "complete"),
      unavailable_fields: unavailable,
      limitations: s.limitations ?? [],
      summary: s.summary,
      raw_summary: raw === null ? null : truncate(oneLine(raw), 240),
    });
    return id;
  }

  // ---- agent-reported (Claude Code hooks / transcript) ----

  private hookPayload(hookEvent: string, extra: Record<string, unknown>): string {
    return JSON.stringify({
      session_id: this.sessionId,
      prompt_id: this.promptId,
      cwd: CWD,
      permission_mode: "default",
      hook_event_name: hookEvent,
      ...extra,
    });
  }

  sessionStart(at: string): string {
    return this.event({
      source: "claude_code_hooks",
      key: `${this.sessionId}:SessionStart`,
      type: "session_start",
      at,
      outcome: "succeeded",
      summary: "Claude Code session started",
      raw: JSON.stringify({ session_id: this.sessionId, cwd: CWD, hook_event_name: "SessionStart", source: "startup" }),
      limitations: [HOOK_LIMITATION],
    });
  }

  userPrompt(at: string, prompt: string): string {
    return this.event({
      source: "claude_code_hooks",
      key: `${this.sessionId}:UserPromptSubmit:1`,
      type: "user_prompt",
      at,
      outcome: "succeeded",
      summary: `Task prompt submitted: "${truncate(prompt, 90)}"`,
      raw: this.hookPayload("UserPromptSubmit", { prompt }),
    });
  }

  /** Final assistant message as delivered to the Stop hook: the agent's own report of what it did. */
  finalReport(at: string, message: string): string {
    return this.event({
      source: "claude_code_hooks",
      key: `${this.sessionId}:Stop:1`,
      type: "agent_message",
      at,
      outcome: "succeeded",
      summary: `Agent final report: "${truncate(message, 110)}"`,
      raw: this.hookPayload("Stop", { stop_hook_active: false, last_assistant_message: message }),
      limitations: ["The final report is the agent's own claim; it is compared against observed events, not trusted."],
    });
  }

  sessionEnd(at: string): string {
    return this.event({
      source: "claude_code_hooks",
      key: `${this.sessionId}:SessionEnd`,
      type: "session_end",
      at,
      outcome: "succeeded",
      summary: "Claude Code session ended",
      raw: JSON.stringify({ session_id: this.sessionId, cwd: CWD, hook_event_name: "SessionEnd", reason: "other" }),
    });
  }

  /** One tool invocation as Claude Code reports it: PreToolUse, then PostToolUse / PostToolUseFailure or a hook denial. */
  toolUse(p: { id: string; tool: string; input: Record<string, unknown>; at: number; target: string; result: ToolResult }): ToolUse {
    const call = this.event({
      source: "claude_code_hooks",
      key: `${this.sessionId}:${p.id}:PreToolUse`,
      type: "tool_call",
      at: this.at(p.at),
      outcome: "attempted",
      summary: `${p.tool} requested: ${describeInput(p.tool, p.input)}`,
      raw: this.hookPayload("PreToolUse", { tool_name: p.tool, tool_input: p.input, tool_use_id: p.id }),
      tool: p.tool,
      toolUseId: p.id,
      target: p.target,
      limitations: [HOOK_LIMITATION],
    });

    const r = p.result;
    if (r.kind === "hook_deny") {
      const decision = this.event({
        source: "claude_code_hooks",
        key: `${this.sessionId}:${p.id}:PreToolUse:decision`,
        type: "permission_decision",
        at: this.at(p.at + 0.05),
        outcome: "denied",
        summary: `kw-policy PreToolUse hook denied ${p.tool} on ${p.target}`,
        raw: JSON.stringify({
          tool_use_id: p.id,
          tool_name: p.tool,
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: r.reason },
        }),
        tool: p.tool,
        toolUseId: p.id,
        target: p.target,
      });
      const content = `PreToolUse:${p.tool} hook error: ${r.reason}`;
      const result = this.event({
        source: "claude_code_transcript",
        key: `${this.sessionId}:${p.id}:tool_result`,
        type: "tool_result",
        at: this.at(p.at + 0.1),
        outcome: "blocked",
        summary: `${p.tool} on ${p.target} was blocked before execution`,
        raw: JSON.stringify({
          type: "user",
          promptId: this.promptId,
          message: { role: "user", content: [{ type: "tool_result", content, is_error: true, tool_use_id: p.id }] },
          timestamp: this.at(p.at + 0.1),
          toolUseResult: `Error: ${content}`,
          toolDenialKind: "permission-rule",
          permissionDecision: { decision: "reject", source: "hook", reasonType: "hook" },
        }),
        tool: p.tool,
        toolUseId: p.id,
        target: p.target,
      });
      return { call, decision, result };
    }

    const end = p.at + (r.durationMs / 1000);
    const result =
      r.kind === "ok"
        ? this.event({
            source: "claude_code_hooks",
            key: `${this.sessionId}:${p.id}:PostToolUse`,
            type: "tool_result",
            at: this.at(end),
            outcome: "succeeded",
            summary: r.summary ?? `${p.tool} completed: ${describeInput(p.tool, p.input)}`,
            raw: this.hookPayload("PostToolUse", {
              tool_name: p.tool,
              tool_input: p.input,
              tool_response: r.response,
              tool_use_id: p.id,
              duration_ms: r.durationMs,
            }),
            tool: p.tool,
            toolUseId: p.id,
            target: p.target,
            limitations: [HOOK_LIMITATION],
          })
        : this.event({
            source: "claude_code_hooks",
            key: `${this.sessionId}:${p.id}:PostToolUseFailure`,
            type: "tool_result",
            at: this.at(end),
            outcome: "failed",
            summary: `${p.tool} failed: ${truncate(oneLine(r.error), 80)}`,
            raw: this.hookPayload("PostToolUseFailure", {
              tool_name: p.tool,
              tool_input: p.input,
              tool_use_id: p.id,
              error: r.error,
              is_interrupt: false,
              duration_ms: r.durationMs,
            }),
            tool: p.tool,
            toolUseId: p.id,
            target: p.target,
          });
    return { call, decision: null, result };
  }

  // ---- independently observed (process tracer, egress proxy, repository observer) ----

  private trace(line: Record<string, unknown>, at: string): string {
    return JSON.stringify({ ts: at, ...line });
  }

  exec(p: { pid: number; ppid: number; comm: string; argv: string[]; at: number }): string {
    const at = this.at(p.at);
    return this.event({
      source: "process_tracer",
      key: `exec:${p.pid}`,
      type: "process_exec",
      at,
      outcome: "succeeded",
      summary: `exec ${p.argv.join(" ")} (pid ${p.pid}, parent ${p.ppid})`,
      raw: this.trace({ pid: p.pid, ppid: p.ppid, comm: p.comm, syscall: "execve", argv: p.argv, ret: 0 }, at),
      pid: p.pid,
      ppid: p.ppid,
      pname: p.comm,
      target: p.argv[0] ?? p.comm,
      attribution: "high",
    });
  }

  exit(p: { pid: number; ppid: number; comm: string; code: number; at: number }): string {
    const at = this.at(p.at);
    return this.event({
      source: "process_tracer",
      key: `exit:${p.pid}`,
      type: "process_exit",
      at,
      outcome: p.code === 0 ? "succeeded" : "failed",
      summary: `${p.comm} (pid ${p.pid}) exited with status ${p.code}`,
      raw: this.trace({ pid: p.pid, ppid: p.ppid, comm: p.comm, event: "exit_group", status: p.code }, at),
      pid: p.pid,
      ppid: p.ppid,
      pname: p.comm,
      attribution: "high",
    });
  }

  open(p: { pid: number; ppid: number; comm: string; path: string; at: number; fd?: number; errno?: string }): string {
    const at = this.at(p.at);
    const ok = p.errno === undefined;
    return this.event({
      source: "process_tracer",
      key: `openat:${p.pid}:${p.path}:${p.at}`,
      type: "file_open",
      at,
      outcome: ok ? "succeeded" : "failed",
      summary: `${p.comm} (pid ${p.pid}) opened ${p.path} for reading${ok ? "" : ` - ${p.errno}`}`,
      raw: this.trace(
        { pid: p.pid, ppid: p.ppid, comm: p.comm, syscall: "openat", path: abs(p.path), flags: "O_RDONLY|O_CLOEXEC", ret: ok ? (p.fd ?? 3) : -1, ...(ok ? {} : { errno: p.errno }) },
        at,
      ),
      pid: p.pid,
      ppid: p.ppid,
      pname: p.comm,
      target: abs(p.path),
      attribution: "high",
      limitations: [FILE_OPEN_LIMITATION],
    });
  }

  read(p: { pid: number; ppid: number; comm: string; path: string; bytes: number; at: number; fd?: number }): string {
    const at = this.at(p.at);
    return this.event({
      source: "process_tracer",
      key: `read:${p.pid}:${p.path}:${p.at}`,
      type: "file_read",
      at,
      outcome: "succeeded",
      summary: `${p.comm} (pid ${p.pid}) read ${p.bytes} bytes from ${p.path}`,
      raw: this.trace({ pid: p.pid, ppid: p.ppid, comm: p.comm, syscall: "read", fd: p.fd ?? 3, path: abs(p.path), ret: p.bytes }, at),
      pid: p.pid,
      ppid: p.ppid,
      pname: p.comm,
      target: abs(p.path),
      attribution: "high",
      limitations: ["Only the byte count is recorded; the bytes themselves were not captured."],
    });
  }

  write(p: { pid: number; ppid: number; comm: string; path: string; bytes: number; at: number }): string {
    const at = this.at(p.at);
    return this.event({
      source: "process_tracer",
      key: `write:${p.pid}:${p.path}:${p.at}`,
      type: "file_write",
      at,
      outcome: "succeeded",
      summary: `${p.comm} (pid ${p.pid}) wrote ${p.bytes} bytes to ${p.path}`,
      raw: this.trace(
        { pid: p.pid, ppid: p.ppid, comm: p.comm, syscall: "openat+write", path: abs(p.path), flags: "O_WRONLY|O_CREAT|O_TRUNC", ret: p.bytes },
        at,
      ),
      pid: p.pid,
      ppid: p.ppid,
      pname: p.comm,
      target: abs(p.path),
      attribution: "high",
      limitations: [WRITE_LIMITATION],
    });
  }

  connect(p: { host: string; port: number; decision: "allow" | "deny"; rule: string; at: number; attributedTo: string; bytesUp: number; bytesDown: number }): string {
    const at = this.at(p.at);
    const target = `${p.host}:${p.port}`;
    return this.event({
      source: "network_proxy",
      key: `connect:${target}:${p.at}`,
      type: "network_connect",
      at,
      outcome: p.decision === "allow" ? "allowed" : "denied",
      summary: `Egress proxy ${p.decision === "allow" ? "allowed" : "denied"} CONNECT ${target} (rule ${p.rule})`,
      raw: `${at} CONNECT ${target} decision=${p.decision} rule=${p.rule} client=sandbox-net bytes_up=${p.bytesUp} bytes_down=${p.bytesDown}`,
      target,
      attribution: "medium",
      unavailable: ["process_id", "parent_process_id", "process_name"],
      limitations: [
        "The egress proxy sees connections, not processes; pid is unavailable.",
        `Attributed to ${p.attributedTo} only by time window: it was the only traced process running at that moment.`,
      ],
    });
  }

  repoChange(p: { path: string; change: "modified" | "added" | "deleted"; plus: number; minus: number; diff: string; at: number }): string {
    return this.event({
      source: "git_observer",
      key: `diff:${p.path}`,
      type: "repo_change",
      at: this.at(p.at),
      outcome: "succeeded",
      summary: `${p.path} ${p.change} in final repository state (+${p.plus} -${p.minus})`,
      raw: p.diff,
      target: p.path,
      limitations: [GIT_LIMITATION],
    });
  }

  // ---- derived / analysis records ----

  correlate(reported: string | null, observed: string | null, match: CorrelationMatch, confidence: Confidence, note: string | null): void {
    this.correlations.push({
      id: `cor_${this.short}_${String(this.correlations.length + 1).padStart(3, "0")}`,
      run_id: this.runId,
      is_fixture: true,
      reported_event_id: reported,
      observed_event_id: observed,
      match,
      confidence,
      note,
    });
  }

  finding(f: Omit<FixtureFinding, "run_id" | "is_fixture" | "recurrence_of_finding_id"> & { recurrence_of_finding_id?: string | null }): string {
    this.findings.push({ run_id: this.runId, is_fixture: true, recurrence_of_finding_id: null, ...f });
    return f.id;
  }

  statusChange(c: Omit<FixtureStatusChange, "id" | "is_fixture">): void {
    const n = this.history.filter((h) => h.finding_id === c.finding_id).length + 1;
    this.history.push({ id: `fsc_${c.finding_id.slice(4)}_${n}`, is_fixture: true, ...c });
  }
}

export function contentSha256(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

function describeInput(tool: string, input: Record<string, unknown>): string {
  if (tool === "Bash" && typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path.replace(`${CWD}/`, "");
  return JSON.stringify(input);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
