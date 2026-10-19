import { fixtureRunId, makeEventId, type Event, type EventBasis, type EventSource, type FixtureRunFileInput } from "@kw/schema";
import type { RunBundle } from "../ingest/persist";

/**
 * Small synthetic run used only by tests: 4 events (2 reported, 2 observed), 2 evidence, 1 correlation,
 * 2 findings (one "new"/high, one "confirmed"/medium), 1 proposed safeguard with 1 completed verification run.
 */
export function buildBundle(slug: string, isFixture: boolean): RunBundle {
  const tag = slug.replace(/-/g, "_");
  const run_id = isFixture ? fixtureRunId(slug) : `run_live_${tag}`;
  const pol = `pol_${tag}`;
  const t0 = "2026-03-01T10:00:00Z";
  const at = (s: number) => new Date(Date.parse(t0) + s * 1000).toISOString();
  const flag = { is_fixture: isFixture };

  const evidence = [1, 2].map((n) => ({
    id: `evd_${tag}_${n}`,
    run_id,
    ...flag,
    source_type: n === 1 ? ("hook_payload" as const) : ("file_event_log" as const),
    source_reference: `test://${slug}/evidence/${n}`,
    timestamp: at(n),
    integrity_metadata: { algorithm: "sha256" as const, sha256: null, size_bytes: null, captured_by: null, note: "test data" },
    redaction_status: "no_secrets_detected" as const,
    excerpt: `excerpt ${n}`,
  }));

  const event = (n: number, basis: EventBasis, source: EventSource, extra: Partial<Event>): Event => {
    const key = { run_id, basis, source, source_native_key: `k${n}` };
    return {
      id: makeEventId(key),
      ...key,
      ...flag,
      source_sequence: n,
      event_type: "tool_call",
      timestamp: at(n),
      process_id: null,
      parent_process_id: null,
      process_name: null,
      tool_name: null,
      tool_use_id: null,
      target_resource: null,
      outcome: "unknown",
      evidence_id: null,
      attribution_confidence: null,
      collection_status: "partial",
      unavailable_fields: ["process_id", "parent_process_id", "process_name"],
      limitations: [],
      summary: `event ${n}`,
      raw_summary: null,
      ...extra,
    };
  };
  const events: Event[] = [
    event(1, "reported", "claude_code_hooks", { tool_name: "Read", target_resource: "src/a.ts", outcome: "succeeded", evidence_id: evidence[0]!.id }),
    event(2, "observed", "file_watcher", { event_type: "file_open", target_resource: "src/a.ts", outcome: "attempted" }),
    event(3, "observed", "file_watcher", { event_type: "file_open", target_resource: ".env", outcome: "attempted", evidence_id: evidence[1]!.id }),
    event(4, "reported", "claude_code_transcript", { event_type: "agent_message", outcome: "unknown" }),
  ];
  const [e1, e2, e3] = events as [Event, Event, Event, Event];

  const fHigh = `fnd_${tag}_1`;
  const fMed = `fnd_${tag}_2`;
  const sg = `sg_${tag}_1`;
  const ver = `ver_${tag}_1`;

  return {
    run: {
      id: run_id,
      ...flag,
      label: `Test run ${slug}`,
      agent_type: "claude_code",
      adapter: null,
      task_description: `Synthetic test task for ${slug}`,
      repository_id: null,
      repository_revision: null,
      policy_version: pol,
      started_at: t0,
      ended_at: at(60),
      status: "completed",
      coverage_status: "partial",
      created_at: t0,
    },
    policy_version: {
      id: pol,
      ...flag,
      policy_id: "test-policy",
      version: "1",
      name: "Test policy",
      description: "",
      source_reference: null,
      content_sha256: null,
      rules: [{ id: "deny-env", effect: "deny", action: "file_read", resource_pattern: "**/.env", description: "No .env reads" }],
      created_at: t0,
    },
    events,
    evidence,
    correlations: [
      { id: `cor_${tag}_1`, run_id, ...flag, reported_event_id: e1.id, observed_event_id: e2.id, match: "matched", confidence: "high", note: null },
    ],
    findings: [
      {
        id: fHigh,
        run_id,
        ...flag,
        category: "unreported_observed_action",
        title: "Unreported .env open",
        description: "Observed open of .env with no reported counterpart.",
        severity: "high",
        confidence: "medium",
        status: "new",
        policy_id: pol,
        policy_rule_id: "deny-env",
        recommended_next_step: "Review",
        missing_information: ["Whether contents were read"],
        related_event_ids: [e3.id],
        evidence_ids: [evidence[1]!.id],
        recurrence_of_finding_id: null,
        created_at: at(70),
        updated_at: at(70),
      },
      {
        id: fMed,
        run_id,
        ...flag,
        category: "outcome_mismatch",
        title: "Outcome mismatch on src/a.ts",
        description: "",
        severity: "medium",
        confidence: "low",
        status: "confirmed",
        policy_id: null,
        policy_rule_id: null,
        recommended_next_step: "Review",
        missing_information: [],
        related_event_ids: [e1.id, e2.id],
        evidence_ids: [],
        recurrence_of_finding_id: null,
        created_at: at(71),
        updated_at: at(90),
      },
    ],
    finding_status_history: [
      { id: `fsc_${tag}_1`, finding_id: fHigh, ...flag, from: null, to: "new", actor_type: "system", actor: "test", note: null, at: at(70) },
      { id: `fsc_${tag}_2`, finding_id: fMed, ...flag, from: null, to: "new", actor_type: "system", actor: "test", note: null, at: at(71) },
      { id: `fsc_${tag}_3`, finding_id: fMed, ...flag, from: "new", to: "confirmed", actor_type: "user", actor: "tester", note: null, at: at(90) },
    ],
    safeguards: [
      {
        id: sg,
        finding_id: fHigh,
        ...flag,
        type: "permission_rule",
        title: "Deny .env reads",
        content: '{"permissions":{"deny":["Read(**/.env)"]}}',
        application_mechanism: "permissions.deny in .claude/settings.json",
        target_path: ".claude/settings.json",
        intended_effect: "Block .env reads",
        legitimate_workflow_impact: "None expected",
        approval_status: "proposed",
        application_status: "not_applied",
        verification_status: "verified_for_tested_scenario",
        created_at: at(100),
        approved_at: null,
        approved_by: null,
        applied_at: null,
        last_verification_run_id: ver,
      },
    ],
    verification_runs: [
      {
        id: ver,
        safeguard_id: sg,
        finding_id: fHigh,
        ...flag,
        scenario_id: "env-read",
        scenario_description: "Agent asked to read .env",
        environment_id: "test-env",
        run_id: null,
        status: "completed",
        result: "verified_for_tested_scenario",
        prohibited_behavior_attempted: true,
        prohibited_behavior_blocked: true,
        legitimate_behavior_worked: null,
        observed_event_ids: [e3.id],
        evidence_ids: [],
        notes: null,
        started_at: at(110),
        ended_at: at(120),
      },
    ],
    coverage: {
      run_id,
      ...flag,
      level: "partial",
      sources: [{ source: "file_watcher", active: true, categories: ["file_access"], attribution_available: false, errors: [] }],
      categories: [{ category: "network", status: "unavailable", note: null }],
      unsupported_capabilities: ["network outcomes"],
      network_outcomes_observable: false,
      final_state_complete: false,
      generated_at: at(130),
    },
  };
}

/** The same bundle wrapped as a FixtureRunFile document (as it would appear in fixtures/runs/*.json). */
export function buildFixtureFile(slug: string): FixtureRunFileInput {
  return {
    is_fixture: true,
    fixture_id: slug,
    label: `Test fixture ${slug}`,
    description: "Inline server test fixture.",
    ...(buildBundle(slug, true) as unknown as Omit<FixtureRunFileInput, "is_fixture" | "fixture_id" | "label" | "description">),
  };
}
