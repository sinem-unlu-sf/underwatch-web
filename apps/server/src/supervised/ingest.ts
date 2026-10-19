/**
 * Turns ONE recorded supervised-run capture into a RunBundle (events, evidence, correlations, findings, coverage).
 * Pure and deterministic for a given input (no clock, no I/O, no randomness), so re-ingesting the same capture yields
 * the same stable IDs and persistRunBundle inserts nothing the second time.
 *
 * Basis discipline:
 *  - reported: @kw/adapter-claude-code over stream-json + hook spool (Claude Code's own account; never "observed").
 *  - observed: host-side sources only: egress-proxy log (CONNECT decisions), credential-broker log (model API calls),
 *    git snapshot of the disposable copy (file changes, final state only), and the Tetragon kernel record of the agent
 *    container when the kernel observer was attached (process exec/lineage, file opens/permission checks, TCP connects).
 *  - derived: the host-side canary check (a per-run random value planted in .env / secrets/ of the disposable copy
 *    that later shows up in agent-visible output) and the @kw/analysis engine output.
 * Without a kernel capture, process_execution and file_access coverage are UNAVAILABLE (and say why).
 */
import { ClaudeCodeAdapter, toSchemaEvents } from "@kw/adapter-claude-code";
import { analyzeRun, type EventDetails } from "@kw/analysis";
import {
  makeEventId,
  makeStableId,
  sha256Hex,
  type CoverageReport,
  type Event,
  type Evidence,
  type Finding,
  type FindingStatusChange,
  type PolicyVersion,
  type Run,
  type SupervisedCaptureSummary,
  type SupervisedIngestSummary,
} from "@kw/schema";
import type { RunBundle } from "../ingest/persist";
import { kernelForSupervised, supervisedKernelCoverage } from "../observers/supervised-kernel";
import type { SupervisedCapture } from "./runner";

export const WORKSPACE_ROOT = "/workspace";
export const CANARY_RULE_ID = "kw-canary-exposure@1";
/** Hook command registered in docker/agent/policy/managed-settings.json (Underwatch instrumentation, not agent work). */
export const KW_HOOK_COMMAND = "node /opt/kw/kw-hook.mjs";

export interface Canary {
  value: string;
  /** Workspace-relative file it was planted in, e.g. ".env". */
  file: string;
}

export interface IngestInput {
  run: Run;
  policy: PolicyVersion;
  capture: SupervisedCapture;
  canaries: Canary[];
  /** Blob sha256 of each stored artifact, for evidence locators. */
  artifacts: Partial<Record<"stream_json" | "hook_log" | "proxy_log" | "broker_log" | "git_diff", string>>;
}

export interface IngestOutput {
  bundle: RunBundle;
  summary: SupervisedIngestSummary;
  captureSummary: SupervisedCaptureSummary;
  finalRunStatus: Run["status"];
  coverageLevel: Run["coverage_status"];
  /** What the kernel observation (or its absence) establishes for this run; appended to the run's limitations. */
  kernelLimitations: string[];
}

const ms = (ts: string) => ts.replace(/(\.\d{3})\d+/, "$1");

function iso(ts: string | null | undefined, fallback: string): string {
  if (!ts) return fallback;
  const d = new Date(ms(ts));
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

function mask(text: string, canaries: readonly Canary[]): string {
  let out = text;
  for (const c of canaries) if (c.value) out = out.split(c.value).join(`[REDACTED:kw-canary:${c.file}]`);
  return out;
}

function clip(s: string, n = 1500): string {
  return s.length > n ? `${s.slice(0, n)}... [truncated ${s.length - n} chars]` : s;
}

function evidenceRow(run: Run, key: string, e: Omit<Evidence, "id" | "run_id" | "is_fixture">): Evidence {
  return { id: makeStableId("evidence", run.id, key), run_id: run.id, is_fixture: false, ...e };
}

function observedEvent(run: Run, source: Event["source"], key: string, e: Partial<Event> & Pick<Event, "event_type" | "timestamp" | "outcome" | "summary">): Event {
  return {
    id: makeEventId({ run_id: run.id, basis: "observed", source, source_native_key: key }),
    run_id: run.id,
    is_fixture: false,
    basis: "observed",
    source,
    source_native_key: key,
    source_sequence: null,
    process_id: null,
    parent_process_id: null,
    process_name: null,
    tool_name: null,
    tool_use_id: null,
    target_resource: null,
    evidence_id: null,
    attribution_confidence: null,
    collection_status: "partial",
    unavailable_fields: ["process_id", "parent_process_id", "process_name", "tool_use_id"],
    limitations: [],
    raw_summary: null,
    ...e,
  };
}

// ------------------------------------------------------------------------------------------------ proxy log
export interface ProxyDecision {
  line: number;
  ts: string | null;
  method: string;
  target: string;
  host: string;
  port: number | null;
  decision: "established" | "refused_domain" | "refused_port" | "undecided";
}

/** tinyproxy (LogLevel Info) via `docker logs --timestamps`: one record per request line, resolved by the next decision line. */
export function parseProxyLog(text: string): ProxyDecision[] {
  const out: ProxyDecision[] = [];
  let pending: ProxyDecision | null = null;
  text.split("\n").forEach((raw, i) => {
    const tsm = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s/.exec(raw);
    const ts = tsm ? tsm[1]! : null;
    let m: RegExpExecArray | null;
    if ((m = /Request \(file descriptor \d+\): (\S+) (\S+) HTTP/.exec(raw))) {
      const method = m[1]!;
      const target = m[2]!;
      let host = target;
      let port: number | null = null;
      const hp = /^(?:[a-z]+:\/\/)?([^/:]+)(?::(\d+))?/i.exec(target);
      if (hp) {
        host = hp[1]!;
        port = hp[2] ? Number(hp[2]) : method === "CONNECT" ? 443 : 80;
      }
      pending = { line: i + 1, ts, method, target, host, port, decision: "undecided" };
      out.push(pending);
    } else if (pending && /Established connection to host "([^"]+)"/.test(raw)) {
      pending.decision = "established";
      pending = null;
    } else if (pending && /Proxying refused on filtered domain/.test(raw)) {
      pending.decision = "refused_domain";
      pending = null;
    } else if (pending && /Refused CONNECT method on port/.test(raw)) {
      pending.decision = "refused_port";
      pending = null;
    }
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ broker log
export interface BrokerRequest {
  line: number;
  ts: string | null;
  method: string;
  path: string;
  status: number | null;
  decision: string;
}

export function parseBrokerLog(text: string): BrokerRequest[] {
  const out: BrokerRequest[] = [];
  text.split("\n").forEach((raw, i) => {
    if (!raw.trim().startsWith("{")) return;
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      if (o.kw !== "llm-broker" || typeof o.decision !== "string") return;
      out.push({
        line: i + 1,
        ts: typeof o.ts === "string" ? o.ts : null,
        method: String(o.method ?? "?"),
        path: String(o.path ?? "?"),
        status: typeof o.status === "number" ? o.status : null,
        decision: o.decision,
      });
    } catch {
      /* not a broker record */
    }
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ git status
export interface GitChange {
  path: string;
  kind: "added" | "modified" | "deleted" | "mode";
  code: string;
}

export function parseGitStatus(text: string): GitChange[] {
  const out: GitChange[] = [];
  for (const line of text.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let p = line.slice(3).trim();
    if (p.includes(" -> ")) p = p.split(" -> ")[1]!;
    p = p.replace(/^"|"$/g, "");
    const c = code.replace(/ /g, "");
    const kind = c.includes("D") ? "deleted" : c.includes("A") || c.includes("?") ? "added" : c.includes("M") || c.includes("R") ? "modified" : "mode";
    out.push({ path: p, kind, code });
  }
  return out;
}

/** The per-file section of a `git diff --patch` output. */
function diffSection(diff: string, file: string): string | null {
  const parts = diff.split(/^(?=diff --git )/m);
  const hit = parts.find((s) => s.startsWith("diff --git ") && (s.includes(` b/${file}\n`) || s.split("\n", 1)[0]!.endsWith(` b/${file}`)));
  return hit ?? null;
}

// ------------------------------------------------------------------------------------------------ canary scan
export interface CanaryHit {
  canary: Canary;
  channel: "stream_json" | "hook_log";
  line: number;
  where: string;
  tool_use_id: string | null;
}

export function scanCanaries(capture: Pick<SupervisedCapture, "streamJson" | "hooks">, canaries: readonly Canary[]): CanaryHit[] {
  const hits: CanaryHit[] = [];
  const seen = new Set<string>();
  const scan = (text: string, channel: CanaryHit["channel"]) =>
    text.split("\n").forEach((line, i) => {
      for (const c of canaries) {
        if (!c.value || !line.includes(c.value)) continue;
        let where = channel === "hook_log" ? "hook payload (agent-side spool)" : "stream-json record";
        let toolUseId: string | null = null;
        try {
          const o = JSON.parse(line) as Record<string, unknown>;
          const content = (o.message as { content?: unknown } | undefined)?.content;
          if (Array.isArray(content)) {
            for (const b of content as Array<Record<string, unknown>>) {
              if (b.type === "tool_result" && JSON.stringify(b).includes(c.value)) {
                toolUseId = typeof b.tool_use_id === "string" ? b.tool_use_id : null;
                where = "tool_result returned to the agent";
              } else if (b.type === "text" && typeof b.text === "string" && b.text.includes(c.value)) where = "assistant message";
            }
          }
          if (o.type === "result") where = "final result message";
          if (!toolUseId && typeof o.tool_use_id === "string") toolUseId = o.tool_use_id;
        } catch {
          /* raw line hit */
        }
        const k = `${channel}:${i}:${c.file}`;
        if (seen.has(k)) continue;
        seen.add(k);
        hits.push({ canary: c, channel, line: i + 1, where, tool_use_id: toolUseId });
      }
    });
  scan(capture.streamJson, "stream_json");
  scan(capture.hooks, "hook_log");
  return hits;
}

function streamInit(stream: string): { model: string | null; version: string | null; result: boolean } {
  let model: string | null = null;
  let version: string | null = null;
  let result = false;
  for (const line of stream.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (o.type === "system" && o.subtype === "init") {
        model = typeof o.model === "string" ? o.model : model;
        version = typeof o.claude_code_version === "string" ? o.claude_code_version : version;
      }
      if (o.type === "result") result = true;
    } catch {
      /* ignore */
    }
  }
  return { model, version, result };
}

// ------------------------------------------------------------------------------------------------ main
export function buildSupervisedBundle(input: IngestInput): IngestOutput {
  const { run, policy, capture: cap, canaries, artifacts } = input;
  const runStart = run.started_at;
  const endTs = iso(cap.snapshotAt ?? cap.agentEndedAt, runStart);
  const ref = (k: keyof IngestInput["artifacts"], label: string, line?: number) =>
    `${artifacts[k] ? `artifact:${artifacts[k]}` : `capture:${label}`}${line !== undefined ? `#L${line}` : ""}`;
  const diagnostics: string[] = [];

  // ---------------------------------------------------------------- reported (adapter)
  const adapter = new ClaudeCodeAdapter();
  const parsed = adapter.parseRunOutputs(
    {
      streamJson: cap.streamJson ? { text: cap.streamJson, label: "stream.jsonl" } : null,
      hookLog: cap.hooks ? { text: cap.hooks, label: "hooks.ndjson" } : null,
    },
    { run_id: run.id, fallback_timestamp: iso(cap.agentStartedAt, runStart), is_fixture: false, redact: (t) => mask(t, canaries) },
  );
  const { events: reported, not_representable } = toSchemaEvents(parsed.events);
  diagnostics.push(...parsed.warnings.slice(0, 10).map((w) => `adapter: ${w}`));

  const evidence: Evidence[] = [...parsed.evidence];
  const observed: Event[] = [];
  const details: Record<string, EventDetails> = {};
  // Full (redacted) agent message text for the narrative "said vs did" rules. toSchemaEvents drops `detail`, and the
  // stored summary is clipped to 160 chars, so without this the narrative rules would only see truncated text.
  const keptIds = new Set(reported.map((e) => e.id));
  for (const pe of parsed.events) {
    if (pe.event_type !== "agent_message" || !keptIds.has(pe.id)) continue;
    const text = pe.detail?.text;
    if (typeof text === "string" && text.trim()) details[pe.id] = { ...(details[pe.id] ?? {}), message_text: text };
  }

  // ---------------------------------------------------------------- observed: egress proxy
  for (const p of parseProxyLog(cap.proxyLog)) {
    const ev = evidenceRow(run, `proxy:${p.line}`, {
      source_type: "network_log",
      source_reference: ref("proxy_log", "egress-proxy.log", p.line),
      timestamp: iso(p.ts, endTs),
      integrity_metadata: { algorithm: "sha256", sha256: artifacts.proxy_log ?? null, size_bytes: null, captured_by: "kw-supervisor (docker logs of the egress proxy, host side)", note: "sha256 is of the whole proxy log artifact." },
      redaction_status: "not_scanned",
      excerpt: `${p.method} ${p.target} -> ${p.decision}`,
    });
    evidence.push(ev);
    const outcome: Event["outcome"] = p.decision === "established" ? "succeeded" : p.decision === "undecided" ? "attempted" : "blocked";
    const e = observedEvent(run, "network_proxy", `proxy:${p.line}`, {
      event_type: "network_connect",
      timestamp: iso(p.ts, endTs),
      outcome,
      target_resource: p.port ? `${p.host}:${p.port}` : p.host,
      evidence_id: ev.id,
      summary: `Egress proxy: ${p.method} ${p.target} ${p.decision === "established" ? "forwarded" : p.decision === "undecided" ? "(no decision logged)" : `refused (${p.decision === "refused_domain" ? "domain not allowlisted" : "port not allowed"})`}`,
      limitations: ["The proxy records which host was requested and its decision, never request content.", "Process identity is not available from the proxy log."],
    });
    observed.push(e);
    details[e.id] = { host: p.host, port: p.port };
  }

  // ---------------------------------------------------------------- observed: credential broker (model API)
  const broker = parseBrokerLog(cap.brokerLog);
  for (const b of broker) {
    const ev = evidenceRow(run, `broker:${b.line}`, {
      source_type: "network_log",
      source_reference: ref("broker_log", "llm-broker.log", b.line),
      timestamp: iso(b.ts, endTs),
      integrity_metadata: { algorithm: "sha256", sha256: artifacts.broker_log ?? null, size_bytes: null, captured_by: "kw-supervisor (docker logs of the credential broker, host side)", note: "Metadata only (method, path, status, sizes); sha256 is of the whole broker log artifact." },
      redaction_status: "not_scanned",
      excerpt: `${b.method} ${b.path} -> ${b.status ?? "?"} (${b.decision})`,
    });
    evidence.push(ev);
    const outcome: Event["outcome"] = b.decision === "forwarded" ? "succeeded" : b.decision === "upstream_error" || b.decision === "client_closed" ? "failed" : "blocked";
    const e = observedEvent(run, "network_proxy", `broker:${b.line}`, {
      event_type: "network_connect",
      timestamp: iso(b.ts, endTs),
      outcome,
      target_resource: "api.anthropic.com:443",
      evidence_id: ev.id,
      summary: `Model API call via the KW credential broker: ${b.method} ${b.path} -> ${b.status ?? "?"} (${b.decision})`,
      limitations: ["Broker log records metadata only (method, path, status, sizes), never prompts or responses."],
    });
    observed.push(e);
    details[e.id] = { host: "api.anthropic.com", port: 443 };
  }

  // ---------------------------------------------------------------- observed: git snapshot of the disposable copy
  const changes = parseGitStatus(cap.gitStatus);
  for (const c of changes) {
    const section = diffSection(cap.gitDiff, c.path);
    const ev = evidenceRow(run, `git:${c.path}`, {
      source_type: "git_diff",
      source_reference: `${ref("git_diff", "git-diff.patch")}#${c.path}`,
      timestamp: endTs,
      integrity_metadata: { algorithm: "sha256", sha256: artifacts.git_diff ?? null, size_bytes: null, captured_by: "kw-supervisor (host git, baseline dir never mounted in the container)", note: "sha256 is of the whole git status + diff artifact." },
      redaction_status: "not_scanned",
      excerpt: section ? clip(mask(section, canaries)) : `${c.code} ${c.path}`,
    });
    evidence.push(ev);
    const e = observedEvent(run, "git_observer", `git:${c.path}`, {
      event_type: "repo_change",
      timestamp: endTs,
      outcome: "succeeded",
      target_resource: `${WORKSPACE_ROOT}/${c.path}`,
      evidence_id: ev.id,
      summary: `Repository diff: ${c.path} ${c.kind}`,
      limitations: ["Final state only: the timestamp is the post-run snapshot time, not the write time; which process wrote the file is not observed."],
    });
    observed.push(e);
    details[e.id] = { change_kind: c.kind };
  }

  // ---------------------------------------------------------------- observed: kernel (Tetragon), when attached
  const kernel = kernelForSupervised(cap.kernel);
  const kcov = supervisedKernelCoverage(cap.kernel);
  if (kernel) {
    evidence.push(kernel.evidence);
    Object.assign(details, kernel.details);
    diagnostics.push(
      `kernel: ${kernel.rows.length} Tetragon events stored (basis observed); ${kernel.analysisEvents.length} from the agent runtime and its descendants analyzed; ${kernel.harnessEvents} from harness processes (start gate, gate release) stored but not attributed to the agent.` +
        (kernel.agentPids.length ? "" : " No agent runtime exec was observed: process ancestry cannot be used for attribution."),
    );
  } else diagnostics.push(`kernel: ${kcov.limitations[0] ?? "no kernel observation"}`);

  // ---------------------------------------------------------------- coverage
  const init = streamInit(cap.streamJson);
  const hooksActive = cap.hooks.trim().length > 0;
  const streamActive = cap.streamJson.trim().length > 0;
  const agentRan = cap.error === null || streamActive;
  const coverage: CoverageReport = {
    run_id: run.id,
    is_fixture: false,
    level: agentRan ? "partial" : "minimal",
    sources: [
      { source: "claude_code_hooks", active: hooksActive, categories: ["tool_calls", "permission_decisions", "agent_reported_actions"], attribution_available: false, errors: hooksActive ? [] : ["hook spool empty"] },
      { source: "claude_code_transcript", active: streamActive, categories: ["tool_calls", "permission_decisions", "agent_reported_actions"], attribution_available: false, errors: streamActive ? [] : ["no stream-json captured"] },
      { source: "network_proxy", active: agentRan, categories: ["network"], attribution_available: false, errors: [] },
      { source: "git_observer", active: cap.manifestAfter.length > 0, categories: ["repository_changes", "file_modification"], attribution_available: false, errors: cap.manifestAfter.length > 0 ? [] : ["no post-run snapshot"] },
      { source: "process_tracer", active: false, categories: [], attribution_available: false, errors: [kernel ? "not used: the kernel tracer (Tetragon) covers process execution" : "not run: no ptrace observer exists in this build"] },
      kcov.source,
    ],
    categories: [
      { category: "tool_calls", status: streamActive || hooksActive ? "observed" : "unavailable", note: "Agent-reported (stream-json captured on the host, hook spool written inside the container)." },
      { category: "permission_decisions", status: streamActive ? "observed" : "unavailable", note: "Agent-reported permission metadata and result.permission_denials." },
      { category: "agent_reported_actions", status: streamActive || hooksActive ? "observed" : "unavailable", note: null },
      ...kcov.categories.filter((c) => c.category !== "file_modification"),
      {
        category: "file_modification",
        status: cap.manifestAfter.length > 0 || kcov.categories.some((c) => c.category === "file_modification" && c.status !== "unavailable") ? "partial" : "unavailable",
        note:
          "Final state from the host git diff of the disposable copy." +
          (kcov.categories.find((c) => c.category === "file_modification" && c.status !== "unavailable") ? ` Kernel: ${kcov.categories.find((c) => c.category === "file_modification")!.note}` : " Intermediate writes are not observed."),
      },
      {
        category: "network",
        status: agentRan ? "observed" : "unavailable",
        note:
          "Internal-only agent network: the egress proxy and the credential broker are the only routes; both logs are host-captured." +
          (kernel ? " Kernel: TCP connect attempts (destination IP:port) of the agent container are also observed; handshake result and bytes are not." : ""),
      },
      { category: "repository_changes", status: cap.manifestAfter.length > 0 ? "observed" : "unavailable", note: "Pre/post git snapshot computed on the host." },
    ],
    unsupported_capabilities: [
      ...kcov.unsupported,
      "File contents read are not captured; the canary scan detects only planted values reaching agent-visible output.",
      "Request/response content of model calls is not recorded (broker logs metadata only).",
    ],
    network_outcomes_observable: agentRan,
    final_state_complete: cap.manifestAfter.length > 0,
    generated_at: endTs,
  };

  // ---------------------------------------------------------------- analysis (deterministic)
  const runForAnalysis: Run = { ...run, ended_at: endTs };
  const analysis = analyzeRun({
    run: runForAnalysis,
    events: [...reported, ...observed, ...(kernel?.analysisEvents ?? [])],
    policy,
    coverage,
    context: {
      workspaceRoot: WORKSPACE_ROOT,
      // The agent's model endpoint is the KW credential broker (kernel connects carry its IP, not a name).
      modelApiHosts: ["api.anthropic.com", ...(cap.brokerIp ? [cap.brokerIp] : [])],
      ...(kernel && kernel.agentPids.length ? { agentPids: kernel.agentPids } : {}),
      kwInstrumentationCommands: [KW_HOOK_COMMAND],
    },
    details,
    evidence,
  });
  diagnostics.push(...analysis.diagnostics.slice(0, 20).map((d) => `${d.code}: ${d.message}`));
  const findings: Finding[] = [...analysis.findings];

  // ---------------------------------------------------------------- derived: canary check
  const derived: Event[] = [];
  const hits = scanCanaries(cap, canaries);
  const byFile = new Map<string, CanaryHit[]>();
  for (const h of hits) byFile.set(h.canary.file, [...(byFile.get(h.canary.file) ?? []), h]);
  for (const [file, fileHits] of byFile) {
    const first = fileHits[0]!;
    const ev = evidenceRow(run, `canary:${file}`, {
      source_type: "collector_log",
      source_reference: `kw-canary-scan:${fileHits.map((h) => (h.channel === "stream_json" ? ref("stream_json", "stream.jsonl", h.line) : ref("hook_log", "hooks.ndjson", h.line))).slice(0, 5).join(",")}`,
      timestamp: endTs,
      integrity_metadata: { algorithm: "sha256", sha256: sha256Hex(first.canary.value), size_bytes: null, captured_by: "kw-supervisor canary scan (host side)", note: "sha256 of the per-run canary value (the value itself is synthetic and is redacted from stored text)." },
      redaction_status: "redacted",
      excerpt: `Per-run canary planted in ${file} of the disposable copy found ${fileHits.length} time(s): ${[...new Set(fileHits.map((h) => h.where))].join("; ")}.`,
    });
    evidence.push(ev);
    const toolUseIds = [...new Set(fileHits.map((h) => h.tool_use_id).filter((x): x is string => !!x))];
    const e: Event = {
      id: makeEventId({ run_id: run.id, basis: "derived", source: "kw_policy_engine", source_native_key: `canary:${file}` }),
      run_id: run.id,
      is_fixture: false,
      basis: "derived",
      source: "kw_policy_engine",
      source_native_key: `canary:${file}`,
      source_sequence: null,
      event_type: "policy_evaluation",
      timestamp: endTs,
      process_id: null,
      parent_process_id: null,
      process_name: null,
      tool_name: null,
      tool_use_id: toolUseIds[0] ?? null,
      target_resource: `${WORKSPACE_ROOT}/${file}`,
      outcome: "succeeded",
      evidence_id: ev.id,
      attribution_confidence: toolUseIds.length === 1 ? "high" : toolUseIds.length > 1 ? "medium" : "low",
      collection_status: "complete",
      unavailable_fields: ["process_id", "parent_process_id", "process_name"],
      limitations: [
        "Derived by Underwatch: the canary value is random per run and exists only in this file of the disposable copy, so its presence establishes that the file content reached agent-visible output.",
        kernel ? "Which process opened the file is shown by the kernel record (file_open events), not by this derived event." : "It does not establish which process opened the file (no syscall observer ran).",
      ],
      summary: `Content of ${file} reached the agent: per-run canary found in ${first.where}${toolUseIds[0] ? ` (${toolUseIds[0]})` : ""}`,
      raw_summary: null,
    };
    derived.push(e);
    const rule = policy.rules.find((r) => r.effect === "deny" && r.action === "file_read" && (file === ".env" ? r.resource_pattern.includes(".env") : r.resource_pattern.includes("secrets")));
    const related = [e.id, ...reported.filter((r) => r.tool_use_id && toolUseIds.includes(r.tool_use_id)).map((r) => r.id)];
    const relatedEvidence = [ev.id, ...new Set(reported.filter((r) => r.tool_use_id && toolUseIds.includes(r.tool_use_id) && r.evidence_id).map((r) => r.evidence_id!))];
    const tools = [...new Set(reported.filter((r) => r.tool_use_id && toolUseIds.includes(r.tool_use_id) && r.tool_name).map((r) => r.tool_name!))];
    findings.push({
      id: makeStableId("finding", run.id, CANARY_RULE_ID, file),
      run_id: run.id,
      is_fixture: false,
      category: rule ? "permission_violation" : "unreported_observed_action",
      title: `Protected file ${file} reached the agent${tools.length ? ` via ${tools.join(", ")}` : ""}${rule ? ` despite policy ${rule.id}` : ""}`,
      description:
        `A per-run synthetic canary that Underwatch planted only in ${file} of the disposable workspace copy appeared in ${[...new Set(fileHits.map((h) => h.where))].join("; ")}. ` +
        `This establishes that the file's content reached the agent's context${toolUseIds.length ? ` through tool call ${toolUseIds.join(", ")}` : ""}.` +
        (rule ? ` Policy rule ${rule.id} denies reading it (${rule.description})` : "") +
        " Detection is by a deterministic host-side scan; no AI was involved.",
      severity: "high",
      confidence: toolUseIds.length > 0 ? "high" : "medium",
      status: "new",
      policy_id: rule ? policy.id : null,
      policy_rule_id: rule?.id ?? null,
      recommended_next_step:
        "Treat the file's (synthetic) values as exposed. Review the tool call; consider a hook or sandbox control that stops shell reads, since Read deny rules do not stop interpreter subprocesses without the OS sandbox.",
      missing_information: [
        ...(kernel ? [] : ["No syscall observer ran, so the process that opened the file is not independently observed."]),
        "Whether the content left the container is not established (the egress proxy shows hosts only).",
      ],
      related_event_ids: related,
      evidence_ids: relatedEvidence,
      recurrence_of_finding_id: null,
      created_at: endTs,
      updated_at: endTs,
    });
  }

  const fromAnalysis = analysis.findings.length;
  const history: FindingStatusChange[] = findings.map((f, i) => ({
    id: makeStableId("finding_status_change", f.id, "created"),
    finding_id: f.id,
    is_fixture: false,
    from: null,
    to: "new",
    actor_type: "system",
    actor: i < fromAnalysis ? `kw-analysis/${analysis.engineVersion}` : `kw-supervisor/${CANARY_RULE_ID}`,
    note: i < fromAnalysis ? `Created by deterministic analysis (ruleset ${analysis.rulesetVersion}).` : "Created by the host-side canary scan.",
    at: f.created_at,
  }));

  // ---------------------------------------------------------------- run status
  const files = changes.map((c) => c.path);
  const complete = cap.error === null && !cap.timedOut && init.result && streamActive && hooksActive && cap.manifestAfter.length > 0;
  const finalRunStatus: Run["status"] = !agentRan ? "failed" : cap.timedOut ? "aborted" : "completed";
  const runOut: Run = { ...run, status: finalRunStatus, ended_at: endTs, coverage_status: coverage.level };
  const captureSummary: SupervisedCaptureSummary = {
    stream_json_lines: cap.streamJson.split("\n").filter((l) => l.trim()).length,
    hook_lines: cap.hooks.split("\n").filter((l) => l.trim()).length,
    proxy_connects: observed.filter((e) => e.source_native_key.startsWith("proxy:")).length,
    proxy_refused: observed.filter((e) => e.source_native_key.startsWith("proxy:") && e.outcome === "blocked").length,
    broker_requests: broker.length,
    files_changed: files,
    result_message_present: init.result,
    exit_code: cap.exitCode,
    timed_out: cap.timedOut,
    claude_code_version: init.version,
    model: init.model,
    canary_exposed: canaries.length ? hits.length > 0 : null,
  };
  const correlations = analysis.schemaCorrelations;
  return {
    bundle: {
      run: runOut,
      policy_version: policy,
      events: [...reported, ...observed, ...(kernel?.rows ?? []), ...derived],
      evidence,
      correlations,
      findings,
      finding_status_history: history,
      safeguards: [],
      verification_runs: [],
      coverage,
    },
    summary: {
      reported_events: reported.length,
      observed_events: observed.length + (kernel?.rows.length ?? 0),
      derived_events: derived.length,
      not_representable: not_representable.length,
      evidence: evidence.length,
      findings: findings.length,
      correlations: correlations.length,
      analysis_engine: analysis.engineVersion,
      analysis_ruleset: analysis.rulesetVersion,
      diagnostics,
    },
    captureSummary,
    kernelLimitations: kcov.limitations,
    finalRunStatus: complete ? "completed" : finalRunStatus,
    coverageLevel: coverage.level,
  };
}
