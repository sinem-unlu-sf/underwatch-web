/** Issue 4 repair: the AI evidence bundle never presents legacy single-value verification fields as task outcomes. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Event, Evidence, Finding, PolicyVersion, Safeguard, VerificationRun } from "@kw/schema";
import { describe, expect, it } from "vitest";
import { askWitnessTemplate, buildEvidenceBundle, EXPLAIN_FINDING_V1 } from "./index";

const fx = JSON.parse(readFileSync(fileURLToPath(new URL("./__fixtures__/fx-04-env-read-via-bash.json", import.meta.url)), "utf8")) as {
  events: Event[];
  evidence: Evidence[];
  findings: Finding[];
  policy_version: PolicyVersion;
  safeguards: Safeguard[];
};
const sg = { ...fx.safeguards[0]!, verification_status: "verified_for_tested_scenario" } as Safeguard;
// A legacy (v1) run whose old single verdict says "verified" and whose legacy task flag says true.
const legacyRun = {
  id: "verification_run_kwinf_0001",
  safeguard_id: sg.id,
  finding_id: sg.finding_id,
  is_fixture: true,
  scenario_id: "scn",
  scenario_description: "legacy",
  environment_id: null,
  run_id: null,
  status: "completed",
  result: "verified_for_tested_scenario",
  prohibited_behavior_attempted: true,
  prohibited_behavior_blocked: true,
  legitimate_behavior_worked: true,
  observed_event_ids: [],
  evidence_ids: [],
  notes: null,
  started_at: "2026-10-17T03:00:00.000Z",
  ended_at: "2026-10-17T03:01:00.000Z",
} as unknown as VerificationRun;

describe("evidence bundle: legacy verification fields are namespaced", () => {
  const bundle = buildEvidenceBundle({ finding: fx.findings[0]!, events: fx.events, evidence: fx.evidence, policy: fx.policy_version, safeguards: [{ safeguard: sg, verification: legacyRun }] });
  const item = bundle.items.find((i) => i.kind === "safeguard")!;

  it("sends the separate outcomes, with task unknown for a legacy 'verified' run", () => {
    expect(item.fields.task_outcome).toBe("unknown");
    expect(item.fields.task_outcome_basis).toBeNull();
    expect(item.fields.security_outcome_basis).not.toBe("observed");
  });

  it("never sends the unprefixed legacy names", () => {
    for (const k of ["legitimate_behavior_worked", "prohibited_behavior_blocked", "last_verification_result", "verification_status"]) expect(item.fields).not.toHaveProperty(k);
    expect(item.fields.legacy_legitimate_behavior_worked).toBe(true);
    expect(item.fields.legacy_last_verification_result).toBe("verified_for_tested_scenario");
    expect(item.fields.legacy_safeguard_verification_status).toBe("verified_for_tested_scenario");
  });

  it("both prompts say task_outcome is authoritative and legacy_ fields are not task outcomes", () => {
    for (const msgs of [askWitnessTemplate("did the fix work?", []).build(bundle), EXPLAIN_FINDING_V1.build(bundle)]) {
      const system = msgs.map((m) => m.content).join("\n");
      expect(system).toMatch(/security_outcome \/ task_outcome and their \*_basis fields are authoritative/);
      expect(system).toMatch(/prefixed legacy_ are old single-value records/);
    }
  });
});
