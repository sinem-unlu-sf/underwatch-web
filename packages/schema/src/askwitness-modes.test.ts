/** Addendum C (judge feedback) extensions to Ask Witness: suggested questions, answer modes, action-claim check. */
import { describe, expect, it } from "vitest";
import {
  actionRecordsFromItems,
  ASK_WITNESS_INVESTIGATOR_QUESTIONS,
  ASK_WITNESS_SUGGESTED_QUESTIONS,
  AskWitnessBody,
  flagUnconfirmedActionClaims,
  InvestigationTurn,
} from "./index";

const claim = (text: string) => ({ text, evidence_ids: ["evt_x"], invalid_evidence_ids: [], support: "observed_evidence" as const, cited_bases: ["observed" as const] });
const answer = (summary: string, facts: string[] = [], hyps: string[] = []) => ({ summary, verified_facts: facts.map(claim), hypotheses: hyps.map(claim) });
const sg = (fields: Record<string, unknown>) => ({ evidence_id: "sg_fx04_deny_read_env", kind: "safeguard", fields });
const NOTHING = actionRecordsFromItems([sg({ approval_status: "proposed", application_status: "not_applied", legacy_safeguard_verification_status: "not_tested", last_verification_run_status: null })]);

describe("Ask Witness suggested questions (Addendum C section 4)", () => {
  it("finding scope offers the judge's eight questions; the earlier ones stay available", () => {
    expect(ASK_WITNESS_SUGGESTED_QUESTIONS).toEqual([
      "Why is this a problem?",
      "Can you explain this in simpler terms?",
      "What evidence supports this conclusion?",
      "What could happen if this issue is ignored?",
      "Why does the agent's report differ from the observed behavior?",
      "How should I fix this issue?",
      "How can I verify that the fix works?",
      "What additional technical details should I know?",
    ]);
    expect(ASK_WITNESS_INVESTIGATOR_QUESTIONS).toContain("Why was this finding flagged?");
    expect(ASK_WITNESS_INVESTIGATOR_QUESTIONS).toHaveLength(8);
  });
});

describe("Ask Witness answer modes", () => {
  it("depth/style are additive and optional on the body and the turn", () => {
    const base = { question: "Why?", client_request_id: "req-mode-0001" };
    expect(AskWitnessBody.parse(base)).toEqual(base);
    expect(AskWitnessBody.parse({ ...base, depth: "detailed", style: "simple" })).toMatchObject({ depth: "detailed", style: "simple" });
    expect(AskWitnessBody.safeParse({ ...base, depth: "verbose" }).success).toBe(false);
    expect(AskWitnessBody.safeParse({ ...base, style: "pirate" }).success).toBe(false);
    expect(InvestigationTurn.shape.depth.isOptional()).toBe(true);
  });
});

describe("unconfirmed action claims", () => {
  it("flags claims of verification / testing / application / fixes when no record confirms them", () => {
    const flags = flagUnconfirmedActionClaims(
      answer("The access was denied. The safeguard has been verified and the regression test passed.", ["The deny-read safeguard was applied to settings.json."], ["The issue has been fixed by the hook."]),
      NOTHING,
    );
    expect(flags.map((f) => [f.location, f.claim])).toEqual([
      ["summary", "verified"],
      ["verified_fact", "applied"],
      ["hypothesis", "fixed"],
    ]);
    expect(flags[0]!.text).toBe("The safeguard has been verified and the regression test passed.");
    expect(flags[0]!.reason).toMatch(/No Underwatch record/);
  });

  it("does not flag negated, hedged or recommended statements, or policy facts that are not remediations", () => {
    const flags = flagUnconfirmedActionClaims(
      answer(
        "The safeguard has not been verified. It should be tested before it is applied. No fix has been applied yet. A deny rule is in place in the policy. Once applied, the hook would block the read.",
      ),
      NOTHING,
    );
    expect(flags).toEqual([]);
  });

  it("accepts the claim when a record confirms it", () => {
    const verified = actionRecordsFromItems([
      sg({ application_status: "applied", legacy_safeguard_verification_status: "verified_for_tested_scenario", last_verification_run_status: "completed", security_outcome: "blocked", security_outcome_basis: "observed" }),
    ]);
    expect(verified.verified).toEqual(["sg_fx04_deny_read_env"]);
    expect(verified.tested).toEqual(["sg_fx04_deny_read_env"]);
    expect(verified.applied).toEqual(["sg_fx04_deny_read_env"]);
    expect(flagUnconfirmedActionClaims(answer("The safeguard has been verified for the tested scenario and was applied."), verified)).toEqual([]);
    const resolved = actionRecordsFromItems([{ evidence_id: "fnd_x", kind: "finding", fields: { status: "resolved" } }]);
    expect(flagUnconfirmedActionClaims(answer("The finding has been resolved."), resolved)).toEqual([]);
    expect(flagUnconfirmedActionClaims(answer("The finding has been resolved."), NOTHING)).toHaveLength(1);
  });

  it("a completed verification run without an observed block counts as tested, not verified", () => {
    const tested = actionRecordsFromItems([sg({ last_verification_run_status: "completed", security_outcome: "unknown", security_outcome_basis: "inferred" })]);
    expect(tested.tested).toHaveLength(1);
    expect(tested.verified).toHaveLength(0);
    const flags = flagUnconfirmedActionClaims(answer("The safeguard was tested. It passed verification."), tested);
    expect(flags.map((f) => f.claim)).toEqual(["verified"]);
  });
});
