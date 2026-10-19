import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  API_CONTRACT,
  API_ROUTES,
  FINDING_STATUS_TRANSITIONS,
  FindingStatus,
  FixtureRunFile,
  RunsQuery,
  checkFindingTransition,
  fixtureRunId,
  makeEventId,
  sha256Hex,
  type FixtureRunFileInput,
} from "./index";

describe("sha256Hex", () => {
  it.each(["", "abc", "kernel witness é\u{1f600}", "x".repeat(1000)])("matches node:crypto for %#", (s) => {
    expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
  });
});

describe("makeEventId", () => {
  const parts = { run_id: "run_a", basis: "observed", source: "file_watcher", source_native_key: "k1" } as const;
  it("is stable and prefixed", () => {
    expect(makeEventId(parts)).toBe(makeEventId({ ...parts }));
    expect(makeEventId(parts)).toMatch(/^evt_[0-9a-f]{64}$/);
  });
  it("changes with any part", () => {
    expect(makeEventId({ ...parts, source_native_key: "k2" })).not.toBe(makeEventId(parts));
    expect(makeEventId({ ...parts, basis: "reported" })).not.toBe(makeEventId(parts));
  });
});

describe("finding transitions", () => {
  it("covers every status and has no self-transitions", () => {
    for (const s of FindingStatus.options) {
      expect(FINDING_STATUS_TRANSITIONS[s]).toBeDefined();
      expect(FINDING_STATUS_TRANSITIONS[s]).not.toContain(s);
    }
  });
  it("enforces notes and allowed edges", () => {
    expect(checkFindingTransition("new", "confirmed", null)).toEqual({ ok: true });
    expect(checkFindingTransition("new", "resolved", "x")).toMatchObject({ ok: false, code: "invalid_transition" });
    expect(checkFindingTransition("new", "dismissed", "  ")).toMatchObject({ ok: false, code: "note_required" });
  });
});

describe("api query parsing", () => {
  it("coerces query strings", () => {
    const q = RunsQuery.parse({ has_findings: "true", limit: "10" });
    expect(q).toMatchObject({ has_findings: true, limit: 10, offset: 0, fixture: "include" });
    expect(() => RunsQuery.parse({ has_findings: "yes" })).toThrow();
  });
  it("has a contract entry per route", () => {
    // 32 base routes (incl. Ask Witness scopes) + Addendum C additions (findingGraphSummary, findingBrief) + live feed (runLive). One entry per route key.
    expect(Object.keys(API_CONTRACT).sort()).toEqual(Object.keys(API_ROUTES).sort());
    expect(Object.keys(API_CONTRACT)).toContain("findingBrief");
    expect(Object.keys(API_CONTRACT)).toContain("runLive");
    expect(API_CONTRACT.runLive.path).toBe("/api/runs/:id/live");
    expect(Object.keys(API_CONTRACT).length).toBeGreaterThanOrEqual(34);
  });
});

function minimalFixture(): FixtureRunFileInput {
  const fixture_id = "fx-minimal";
  const run_id = fixtureRunId(fixture_id);
  const t = "2026-01-01T00:00:00Z";
  const evidence: FixtureRunFileInput["evidence"][number] = {
    id: "evd_fx_minimal_1",
    run_id,
    is_fixture: true,
    source_type: "file_event_log",
    source_reference: "fixture://fx-minimal/file-events#1",
    timestamp: t,
    integrity_metadata: { algorithm: "sha256", sha256: null, size_bytes: null, captured_by: null, note: "synthetic fixture" },
    redaction_status: "no_secrets_detected",
    excerpt: "OPEN .env",
  };
  const keyParts = { run_id, basis: "observed", source: "file_watcher", source_native_key: "line-1" } as const;
  const event: FixtureRunFileInput["events"][number] = {
    id: makeEventId(keyParts),
    ...keyParts,
    is_fixture: true,
    source_sequence: 1,
    event_type: "file_open",
    timestamp: t,
    process_id: null,
    parent_process_id: null,
    process_name: null,
    tool_name: null,
    tool_use_id: null,
    target_resource: ".env",
    outcome: "attempted",
    evidence_id: evidence.id,
    attribution_confidence: null,
    collection_status: "partial",
    unavailable_fields: ["process_id", "parent_process_id", "process_name"],
    limitations: ["A file-open event does not prove the contents were read."],
    summary: "Open of .env observed",
    raw_summary: null,
  };
  return {
    is_fixture: true,
    fixture_id,
    label: "Minimal",
    description: "Schema self-test.",
    run: {
      id: run_id,
      is_fixture: true,
      label: "Minimal",
      agent_type: "claude_code",
      adapter: null,
      task_description: "test",
      repository_id: null,
      repository_revision: null,
      policy_version: "pol_fx_minimal",
      started_at: t,
      ended_at: null,
      status: "completed",
      coverage_status: "minimal",
      created_at: t,
    },
    policy_version: {
      id: "pol_fx_minimal",
      is_fixture: true,
      policy_id: "default",
      version: "1",
      name: "Default",
      description: "",
      source_reference: null,
      content_sha256: null,
      rules: [],
      created_at: t,
    },
    events: [event],
    evidence: [evidence],
    findings: [
      {
        id: "fnd_fx_minimal_1",
        run_id,
        is_fixture: true,
        category: "unreported_observed_action",
        title: "Unreported .env open",
        description: "",
        severity: "medium",
        confidence: "low",
        status: "new",
        policy_id: null,
        policy_rule_id: null,
        recommended_next_step: "Review",
        missing_information: [],
        related_event_ids: [event.id],
        evidence_ids: [evidence.id],
        recurrence_of_finding_id: null,
        created_at: t,
        updated_at: t,
      },
    ],
    finding_status_history: [
      { id: "fsc_fx_minimal_1", finding_id: "fnd_fx_minimal_1", is_fixture: true, from: null, to: "new", actor_type: "system", actor: "fixture", note: null, at: t },
    ],
    safeguards: [],
    coverage: {
      run_id,
      is_fixture: true,
      level: "minimal",
      sources: [],
      categories: [],
      unsupported_capabilities: [],
      network_outcomes_observable: false,
      final_state_complete: false,
      generated_at: t,
    },
  };
}

describe("FixtureRunFile", () => {
  it("accepts a consistent fixture", () => {
    const r = FixtureRunFile.safeParse(minimalFixture());
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it("rejects a wrong event id and non-fixture records", () => {
    const f = minimalFixture();
    const bad = { ...f, events: [{ ...f.events[0]!, id: "evt_" + "0".repeat(64) }] };
    expect(FixtureRunFile.safeParse(bad).success).toBe(false);
    expect(FixtureRunFile.safeParse({ ...f, run: { ...f.run, is_fixture: false } }).success).toBe(false);
  });
});
