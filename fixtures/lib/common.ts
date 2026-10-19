import type { CoverageCategory, EventSource, FixtureRunFileInput } from "../../packages/schema/src/index";
import { contentSha256, REPO_ID, type FixtureCoverage, type FixturePolicy, type RunBuilder } from "./builder";

export const POLICY_ID = "pol_fx_policy_v1";

const POLICY_RULES: FixturePolicy["rules"] = [
  {
    id: "R1",
    effect: "deny",
    action: "file_read",
    resource_pattern: "**/.env",
    description:
      "The agent must not read .env files. Enforced for the Read tool by the kw-policy PreToolUse hook; reads through other paths (e.g. Bash) are detected, not blocked.",
  },
  {
    id: "R2",
    effect: "deny",
    action: "file_read",
    resource_pattern: "**/secrets/**",
    description: "The agent must not read anything under secrets/. Enforced by the Claude Code permission rule Read(./secrets/**).",
  },
  {
    id: "R3",
    effect: "allow",
    action: "file_write",
    resource_pattern: "{src,tests}/**",
    description: "The agent may modify source and test files when the task calls for it.",
  },
  {
    id: "R4",
    effect: "allow",
    action: "file_write",
    resource_pattern: "README.md",
    description: "The agent may edit project documentation.",
  },
  {
    id: "R5",
    effect: "deny",
    action: "file_write",
    resource_pattern: ".claude/**",
    description: "The agent must not modify its own Claude Code configuration or hooks.",
  },
  {
    id: "R6",
    effect: "allow",
    action: "Bash",
    resource_pattern: "cat *|grep *|ls *|python -m pytest *|make test|pip install *",
    description: "Read-only shell utilities, the test runner and dependency installs run without prompting. Deny rules (R1, R2) take precedence.",
  },
  {
    id: "R7",
    effect: "allow",
    action: "network_connect",
    resource_pattern: "pypi.org:443|files.pythonhosted.org:443",
    description: "Package index egress is allowed through the proxy.",
  },
  {
    id: "R8",
    effect: "deny",
    action: "network_connect",
    resource_pattern: "*",
    description: "Default-deny for all other egress through the proxy.",
  },
];

export const POLICY_V1: FixturePolicy = {
  id: POLICY_ID,
  is_fixture: true,
  policy_id: "kw-default",
  version: "policy-v1",
  name: "[fixture] Demo repository policy v1",
  description: "Synthetic policy used by every fixture run. Shared across fixture files: identical content, identical id.",
  source_reference: "fixture://policy/policy-v1.json",
  content_sha256: contentSha256(POLICY_RULES),
  rules: POLICY_RULES,
  created_at: "2026-10-15T12:00:00.000Z",
};

export const POLICY_EXCERPT = JSON.stringify({
  version: "policy-v1",
  rules: POLICY_RULES.map((r) => `${r.id} ${r.effect} ${r.action} ${r.resource_pattern}`),
});

type SourceEntry = FixtureCoverage["sources"][number];
type CategoryEntry = FixtureCoverage["categories"][number];

const BASE_SOURCES: Record<string, SourceEntry> = {
  hooks: {
    source: "claude_code_hooks",
    active: true,
    categories: ["tool_calls", "permission_decisions", "agent_reported_actions"],
    attribution_available: false,
    errors: [],
  },
  transcript: {
    source: "claude_code_transcript",
    active: true,
    categories: ["tool_calls", "permission_decisions", "agent_reported_actions"],
    attribution_available: false,
    errors: [],
  },
  tracer: {
    source: "process_tracer",
    active: true,
    categories: ["process_execution", "file_access", "file_modification"],
    attribution_available: true,
    errors: [],
  },
  proxy: {
    source: "network_proxy",
    active: true,
    categories: ["network"],
    attribution_available: false,
    errors: [],
  },
  git: {
    source: "git_observer",
    active: true,
    categories: ["repository_changes"],
    attribution_available: false,
    errors: [],
  },
};

const COMPLETE_CATEGORIES: CategoryEntry[] = [
  { category: "tool_calls", status: "observed", note: "PreToolUse/PostToolUse hook payloads for every tool call." },
  { category: "process_execution", status: "observed", note: "Process tracer followed the agent's full process tree." },
  { category: "file_access", status: "observed", note: "openat/read captured for the traced process tree only." },
  { category: "file_modification", status: "observed", note: null },
  { category: "network", status: "observed", note: "Egress proxy active for the whole run; loopback traffic is not proxied." },
  { category: "permission_decisions", status: "observed", note: "Denials captured from hook decisions and transcript tool_result entries." },
  { category: "agent_reported_actions", status: "observed", note: null },
  { category: "repository_changes", status: "observed", note: "Pre/post git snapshots." },
];

const COMMON_UNSUPPORTED = [
  "File contents read or written are not captured (byte counts and paths only).",
  "DNS resolution is not captured separately; the proxy records CONNECT host:port.",
];

export function completeCoverage(b: RunBuilder, generatedAtSec: number): FixtureCoverage {
  const s = BASE_SOURCES;
  return {
    run_id: b.runId,
    is_fixture: true,
    level: "complete",
    sources: [s.hooks!, s.transcript!, s.tracer!, s.proxy!, s.git!],
    categories: COMPLETE_CATEGORIES,
    unsupported_capabilities: COMMON_UNSUPPORTED,
    network_outcomes_observable: true,
    final_state_complete: true,
    generated_at: b.at(generatedAtSec),
  };
}

export function partialCoverage(
  b: RunBuilder,
  generatedAtSec: number,
  p: {
    sourceOverrides: Partial<Record<EventSource, Partial<SourceEntry>>>;
    extraSources: SourceEntry[];
    categoryOverrides: Partial<Record<CoverageCategory, Omit<CategoryEntry, "category">>>;
    extraUnsupported: string[];
  },
): FixtureCoverage {
  const sources = [...Object.values(BASE_SOURCES), ...p.extraSources].map((src) => ({ ...src, ...(p.sourceOverrides[src.source] ?? {}) }));
  const categories = COMPLETE_CATEGORIES.map((c) => ({ ...c, ...(p.categoryOverrides[c.category] ?? {}) }));
  return {
    run_id: b.runId,
    is_fixture: true,
    level: "partial",
    sources,
    categories,
    unsupported_capabilities: [...COMMON_UNSUPPORTED, ...p.extraUnsupported],
    network_outcomes_observable: false,
    final_state_complete: true,
    generated_at: b.at(generatedAtSec),
  };
}

export interface RunMeta {
  label: string;
  description: string;
  task: string;
  endSec: number;
  revision: string;
  coverage: FixtureCoverage;
}

export function assemble(b: RunBuilder, m: RunMeta): FixtureRunFileInput {
  return {
    is_fixture: true,
    fixture_id: b.fixtureId,
    label: m.label,
    description: m.description,
    run: {
      id: b.runId,
      is_fixture: true,
      label: m.label,
      agent_type: "claude_code",
      adapter: null,
      task_description: m.task,
      repository_id: REPO_ID,
      repository_revision: m.revision,
      policy_version: POLICY_ID,
      started_at: b.at(0),
      ended_at: b.at(m.endSec),
      status: "completed",
      coverage_status: m.coverage.level,
      created_at: b.at(-2),
    },
    policy_version: POLICY_V1,
    events: [...b.events].sort((x, y) => x.timestamp.localeCompare(y.timestamp)),
    evidence: b.evidence,
    correlations: b.correlations,
    findings: b.findings,
    finding_status_history: b.history,
    safeguards: b.safeguards,
    verification_runs: [],
    coverage: m.coverage,
  };
}

export const FIXTURE_FINDING_PREFIX = "Hand-labeled fixture expectation, not detection output.";
