import { z } from "zod";
import {
  CoverageReport,
  Event,
  EventCorrelation,
  Evidence,
  Finding,
  FindingStatusChange,
  PolicyVersion,
  Run,
  Safeguard,
  VerificationRun,
} from "./entities";
import { EVENT_SOURCE_BASIS } from "./enums";
import { makeEventId } from "./ids";

const fixtureFlag = { is_fixture: z.literal(true) };

/**
 * On-disk format of fixtures/runs/*.json. One file = one synthetic run with everything attached.
 * Every nested record must carry is_fixture: true. Event IDs must equal makeEventId(...) of their parts, so
 * fixture JSON is best produced by a small generator script that imports @kw/schema.
 */
export const FixtureRunFile = z
  .object({
    is_fixture: z.literal(true),
    /** Stable slug, e.g. "fx-unreported-env-read". Also used to derive the run id "run_fx_<slug>". */
    fixture_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    label: z.string().min(1),
    /** What scenario this fixture represents and which PRD validation case (section 11) it maps to. */
    description: z.string().min(1),
    run: Run.extend(fixtureFlag),
    policy_version: PolicyVersion.extend(fixtureFlag),
    events: z.array(Event.extend(fixtureFlag)),
    evidence: z.array(Evidence.extend(fixtureFlag)),
    correlations: z.array(EventCorrelation.extend(fixtureFlag)).default([]),
    findings: z.array(Finding.extend(fixtureFlag)),
    finding_status_history: z.array(FindingStatusChange.extend(fixtureFlag)),
    safeguards: z.array(Safeguard.extend(fixtureFlag)),
    verification_runs: z.array(VerificationRun.extend(fixtureFlag)).default([]),
    coverage: CoverageReport.extend(fixtureFlag),
  })
  .superRefine((f, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const runId = f.run.id;

    if (runId !== fixtureRunId(f.fixture_id)) issue(["run", "id"], `run.id must be ${fixtureRunId(f.fixture_id)}`);
    if (f.run.policy_version !== null && f.run.policy_version !== f.policy_version.id) {
      issue(["run", "policy_version"], "run.policy_version must equal policy_version.id");
    }
    if (f.coverage.run_id !== runId) issue(["coverage", "run_id"], "coverage.run_id must equal run.id");
    if (f.coverage.level !== f.run.coverage_status) issue(["coverage", "level"], "coverage.level must equal run.coverage_status");

    const eventIds = new Set<string>();
    const evidenceIds = new Set(f.evidence.map((e) => e.id));
    const findingIds = new Set(f.findings.map((x) => x.id));
    const safeguardIds = new Set(f.safeguards.map((s) => s.id));
    const verificationIds = new Set(f.verification_runs.map((v) => v.id));

    f.evidence.forEach((e, i) => {
      if (e.run_id !== runId) issue(["evidence", i, "run_id"], "evidence.run_id must equal run.id");
    });

    f.events.forEach((e, i) => {
      if (e.run_id !== runId) issue(["events", i, "run_id"], "event.run_id must equal run.id");
      if (eventIds.has(e.id)) issue(["events", i, "id"], "duplicate event id");
      eventIds.add(e.id);
      const expected = makeEventId({ run_id: e.run_id, basis: e.basis, source: e.source, source_native_key: e.source_native_key });
      if (e.id !== expected) issue(["events", i, "id"], `event id must be makeEventId(...) = ${expected}`);
      if (EVENT_SOURCE_BASIS[e.source] !== e.basis) issue(["events", i, "basis"], `source ${e.source} implies basis ${EVENT_SOURCE_BASIS[e.source]}`);
      if (e.evidence_id !== null && !evidenceIds.has(e.evidence_id)) issue(["events", i, "evidence_id"], "unknown evidence id");
    });

    f.correlations.forEach((c, i) => {
      if (c.run_id !== runId) issue(["correlations", i, "run_id"], "correlation.run_id must equal run.id");
      for (const key of ["reported_event_id", "observed_event_id"] as const) {
        const id = c[key];
        if (id !== null && !eventIds.has(id)) issue(["correlations", i, key], "unknown event id");
      }
    });

    f.findings.forEach((x, i) => {
      if (x.run_id !== runId) issue(["findings", i, "run_id"], "finding.run_id must equal run.id");
      if (x.policy_id !== null && x.policy_id !== f.policy_version.id) issue(["findings", i, "policy_id"], "unknown policy id");
      x.related_event_ids.forEach((id, j) => eventIds.has(id) || issue(["findings", i, "related_event_ids", j], "unknown event id"));
      x.evidence_ids.forEach((id, j) => evidenceIds.has(id) || issue(["findings", i, "evidence_ids", j], "unknown evidence id"));
      const history = f.finding_status_history.filter((h) => h.finding_id === x.id).sort((a, b) => a.at.localeCompare(b.at));
      const last = history.at(-1);
      if (!last) issue(["findings", i], "finding needs at least one finding_status_history row (from: null)");
      else if (last.to !== x.status) issue(["findings", i, "status"], "finding.status must equal the latest history row's `to`");
    });

    f.finding_status_history.forEach((h, i) => {
      if (!findingIds.has(h.finding_id)) issue(["finding_status_history", i, "finding_id"], "unknown finding id");
    });

    f.safeguards.forEach((s, i) => {
      if (!findingIds.has(s.finding_id)) issue(["safeguards", i, "finding_id"], "unknown finding id");
      if (s.last_verification_run_id !== null && !verificationIds.has(s.last_verification_run_id)) {
        issue(["safeguards", i, "last_verification_run_id"], "unknown verification run id");
      }
    });

    f.verification_runs.forEach((v, i) => {
      if (!safeguardIds.has(v.safeguard_id)) issue(["verification_runs", i, "safeguard_id"], "unknown safeguard id");
      if (!findingIds.has(v.finding_id)) issue(["verification_runs", i, "finding_id"], "unknown finding id");
      v.observed_event_ids.forEach((id, j) => eventIds.has(id) || issue(["verification_runs", i, "observed_event_ids", j], "unknown event id"));
      v.evidence_ids.forEach((id, j) => evidenceIds.has(id) || issue(["verification_runs", i, "evidence_ids", j], "unknown evidence id"));
    });
  });
export type FixtureRunFile = z.infer<typeof FixtureRunFile>;
export type FixtureRunFileInput = z.input<typeof FixtureRunFile>;

export function fixtureRunId(fixtureId: string): string {
  return `run_fx_${fixtureId.replace(/-/g, "_")}`;
}
