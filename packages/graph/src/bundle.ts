import { z } from "zod";
import {
  CoverageReport,
  Event,
  EventCorrelation,
  Evidence,
  Finding,
  FindingStatusChange,
  FixtureRunFile,
  PolicyVersion,
  Run,
  Safeguard,
  VerificationRun,
} from "@kw/schema";

/**
 * PROPOSED SCHEMA ADDITION. Everything known about one run, as persisted in the relational store. Same shape as
 * FixtureRunFile but without the fixture-only constraints (is_fixture may be false, no fixture_id/label/description,
 * policy_version and coverage may be absent), so the server can project live runs with the same code path.
 * FixtureRunFile output is assignable to RunBundle.
 */
export const RunBundle = z.object({
  run: Run,
  policy_version: PolicyVersion.nullable(),
  events: z.array(Event),
  evidence: z.array(Evidence),
  correlations: z.array(EventCorrelation).default([]),
  findings: z.array(Finding),
  finding_status_history: z.array(FindingStatusChange).default([]),
  safeguards: z.array(Safeguard).default([]),
  verification_runs: z.array(VerificationRun).default([]),
  coverage: CoverageReport.nullable().default(null),
  /** Present for fixtures; copied onto the Run node. */
  fixture_id: z.string().optional(),
});
export type RunBundle = z.infer<typeof RunBundle>;
export type RunBundleInput = z.input<typeof RunBundle>;

export type BundleParseResult = { ok: true; bundle: RunBundle } | { ok: false; issues: string[] };

/**
 * Validate a bundle. Inputs that look like a fixture file (`fixture_id` present or `is_fixture: true` at top level)
 * are validated with the stricter FixtureRunFile (referential checks, makeEventId checks); others with RunBundle.
 */
export function parseRunBundle(input: unknown): BundleParseResult {
  const looksFixture = typeof input === "object" && input !== null && ("fixture_id" in input || (input as { is_fixture?: unknown }).is_fixture === true);
  const fmt = (issues: readonly { path: readonly PropertyKey[]; message: string }[]) =>
    issues.slice(0, 20).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
  if (looksFixture) {
    const r = FixtureRunFile.safeParse(input);
    if (!r.success) return { ok: false, issues: fmt(r.error.issues) };
    return { ok: true, bundle: { ...r.data, fixture_id: r.data.fixture_id } };
  }
  const r = RunBundle.safeParse(input);
  if (!r.success) return { ok: false, issues: fmt(r.error.issues) };
  return { ok: true, bundle: r.data };
}
