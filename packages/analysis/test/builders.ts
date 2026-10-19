import {
  EVENT_SOURCE_BASIS,
  makeEventId,
  type CoverageCategory,
  type CoverageReport,
  type Event,
  type EventSource,
  type EventType,
  type Outcome,
  type PolicyVersion,
  type Run,
} from "@kw/schema";
import type { EventDetails, KwPolicyInput } from "../src/index";
import { KwPolicy } from "../src/index";

/** Synthetic test data only (no real secrets). All IDs follow @kw/schema conventions. */
export const RUN_ID = "run_test_analysis";
const T0 = Date.UTC(2026, 9, 17, 1, 0, 0); // test helper only; the engine itself never uses Date

export function iso(ms: number): string {
  return new Date(T0 + ms).toISOString();
}

export function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    is_fixture: false,
    label: "test",
    agent_type: "claude_code",
    adapter: "claude-code",
    task_description: "synthetic test run",
    repository_id: "demo",
    repository_revision: null,
    policy_version: "pol_test_v1",
    started_at: iso(0),
    ended_at: iso(60_000),
    status: "completed",
    coverage_status: "complete",
    created_at: iso(0),
    ...over,
  };
}

export interface EvSpec {
  source: EventSource;
  type: EventType;
  at: number;
  key?: string;
  pid?: number | null;
  ppid?: number | null;
  name?: string | null;
  tool?: string | null;
  toolUseId?: string | null;
  target?: string | null;
  outcome?: Outcome;
  evidence?: string | null;
  partial?: boolean;
  attrConf?: "low" | "medium" | "high" | null;
  runId?: string;
}

let counter = 0;
export function ev(s: EvSpec): Event {
  const run_id = s.runId ?? RUN_ID;
  const basis = EVENT_SOURCE_BASIS[s.source];
  const key = s.key ?? `${s.type}:${s.at}:${s.target ?? ""}:${s.toolUseId ?? ""}:${++counter}`;
  return {
    id: makeEventId({ run_id, basis, source: s.source, source_native_key: key }),
    run_id,
    is_fixture: false,
    basis,
    source: s.source,
    source_native_key: key,
    source_sequence: null,
    event_type: s.type,
    timestamp: iso(s.at),
    process_id: s.pid ?? null,
    parent_process_id: s.ppid ?? null,
    process_name: s.name ?? null,
    tool_name: s.tool ?? null,
    tool_use_id: s.toolUseId ?? null,
    target_resource: s.target ?? null,
    outcome: s.outcome ?? "succeeded",
    evidence_id: s.evidence ?? null,
    attribution_confidence: s.attrConf ?? null,
    collection_status: s.partial ? "partial" : "complete",
    unavailable_fields: [],
    limitations: [],
    summary: `${s.type} ${s.target ?? ""}`.trim(),
    raw_summary: null,
  };
}

/** Reported tool call: PreToolUse (tool_call) + PostToolUse (tool_result) or denial. */
export function reportedCall(
  toolUseId: string,
  tool: string,
  target: string,
  at: number,
  dur: number,
  result: "succeeded" | "failed" | "denied" | "none" = "succeeded",
  sources: EventSource[] = ["claude_code_hooks"],
): Event[] {
  const out: Event[] = [];
  for (const source of sources) {
    out.push(ev({ source, type: "tool_call", at, tool, toolUseId, target, outcome: "attempted", key: `${source}:${toolUseId}:pre` }));
    if (result === "denied") out.push(ev({ source, type: "permission_decision", at: at + 1, tool, toolUseId, target, outcome: "denied", key: `${source}:${toolUseId}:deny` }));
    else if (result !== "none") out.push(ev({ source, type: "tool_result", at: at + dur, tool, toolUseId, target, outcome: result, key: `${source}:${toolUseId}:post` }));
  }
  return out;
}

export const ALL_CATEGORIES: CoverageCategory[] = [
  "tool_calls", "process_execution", "file_access", "file_modification", "network", "permission_decisions", "agent_reported_actions", "repository_changes",
];

export function makeCoverage(over: Partial<Record<CoverageCategory, "observed" | "partial" | "unavailable">> = {}, extra: Partial<CoverageReport> = {}): CoverageReport {
  return {
    run_id: RUN_ID,
    is_fixture: false,
    level: Object.values(over).some((v) => v !== "observed") ? "partial" : "complete",
    sources: [
      { source: "claude_code_hooks", active: true, categories: ["tool_calls", "agent_reported_actions", "permission_decisions"], attribution_available: true, errors: [] },
      { source: "claude_code_transcript", active: true, categories: ["tool_calls", "agent_reported_actions"], attribution_available: true, errors: [] },
      { source: "kernel_tracer", active: true, categories: ["process_execution", "file_access", "file_modification", "network"], attribution_available: true, errors: [] },
      { source: "network_proxy", active: true, categories: ["network"], attribution_available: false, errors: [] },
      { source: "git_observer", active: true, categories: ["repository_changes"], attribution_available: false, errors: [] },
    ],
    categories: ALL_CATEGORIES.map((c) => ({ category: c, status: over[c] ?? "observed", note: null })),
    unsupported_capabilities: [],
    network_outcomes_observable: true,
    final_state_complete: true,
    generated_at: iso(61_000),
    ...extra,
  };
}

export function kwPolicy(p: Partial<KwPolicyInput> & Pick<KwPolicyInput, "rules">): KwPolicy {
  return KwPolicy.parse({ kw_policy: 1, policy_id: "test", version_id: "pol_test_v1", version: "1", ...p });
}

export function schemaPolicy(rules: PolicyVersion["rules"]): PolicyVersion {
  return {
    id: "pol_test_v1",
    is_fixture: false,
    policy_id: "test",
    version: "1",
    name: "test policy",
    description: "",
    source_reference: null,
    content_sha256: null,
    rules,
    created_at: iso(0),
  };
}

/** Standard agent process tree: claude (pid 100, parent kw-launch 10). */
export function agentExec(at = 0): Event {
  return ev({ source: "kernel_tracer", type: "process_exec", at, pid: 100, ppid: 10, name: "claude", target: "/usr/local/bin/claude", key: "exec:100" });
}

export const SECRETS_POLICY = kwPolicy({
  rules: [
    { id: "R-SECRETS", effect: "deny", action: "file_read", patterns: ["ws:**/.env", "ws:**/.env.*"], severity: "high", description: "synthetic secrets" },
    { id: "A-TEST-CREDS", effect: "allow", action: "file_read", patterns: ["ws:config/test-credentials.json"] },
    { id: "R-LOCKFILE", effect: "deny", action: "file_write", patterns: ["ws:package-lock.json"], severity: "low" },
    { id: "R-NO-TELEMETRY", effect: "deny", action: "network", patterns: ["*.telemetry.test"], severity: "low" },
    { id: "A-REGISTRY", effect: "allow", action: "network", patterns: ["registry.npmjs.org:443"] },
    { id: "R-NO-NETCAT", effect: "deny", action: "command", patterns: ["program:nc", "program:ncat"], severity: "medium" },
  ],
  defaults: { network: "deny" },
});

export type Details = Record<string, EventDetails>;
