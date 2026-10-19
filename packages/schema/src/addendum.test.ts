import { describe, expect, it } from "vitest";
import {
  API_CONTRACT,
  API_ROUTES,
  AskWitnessModelOutput,
  ClaudeMdRelPath,
  MECHANISMS,
  SafeguardApproveBody,
  SafeguardType,
  checkAskWitnessOutput,
  claudeMdBlockMarkers,
  deriveVerificationState,
  legacySafeguardStatuses,
  lifecycleFromLegacy,
  mergeClaudeMdBlock,
  removeClaudeMdBlock,
  type EventBasis,
  type VerificationCaseOutcome,
} from "./index";

describe("CLAUDE.md managed blocks", () => {
  const sg = "sg_test1";
  it("appends after existing content and preserves it byte-for-byte", () => {
    const before = "# Project\n\n- keep tests green\n";
    const after = mergeClaudeMdBlock(before, sg, "Do not read .env files.");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain(claudeMdBlockMarkers(sg).begin);
    expect(removeClaudeMdBlock(after, sg)).toBe(before);
  });
  it("replaces only its own block on re-version", () => {
    const v1 = mergeClaudeMdBlock("intro\n", sg, "v1 text");
    const withOther = mergeClaudeMdBlock(v1, "sg_other", "other text");
    const v2 = mergeClaudeMdBlock(withOther, sg, "v2 text");
    expect(v2).toContain("v2 text");
    expect(v2).not.toContain("v1 text");
    expect(v2).toContain("other text");
    expect(v2.split(claudeMdBlockMarkers(sg).begin)).toHaveLength(2);
  });
  it("creates a file from nothing and adds a missing trailing newline", () => {
    expect(mergeClaudeMdBlock(null, sg, "x")).toBe(`${claudeMdBlockMarkers(sg).begin}\nx\n${claudeMdBlockMarkers(sg).end}\n`);
    expect(mergeClaudeMdBlock("no newline", sg, "x").startsWith("no newline\n\n")).toBe(true);
  });
  it("only accepts workspace-relative CLAUDE.md paths", () => {
    for (const ok of ["CLAUDE.md", "apps/web/CLAUDE.md"]) expect(ClaudeMdRelPath.safeParse(ok).success).toBe(true);
    for (const bad of ["/etc/CLAUDE.md", "../CLAUDE.md", "a/../CLAUDE.md", ".claude/CLAUDE.md", "README.md", "CLAUDE.md/x", ""]) {
      expect(ClaudeMdRelPath.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("Ask Witness answer validation", () => {
  const bases = new Map<string, EventBasis | null>([
    ["evt_obs", "observed"],
    ["evt_rep", "reported"],
    ["fnd_x", "derived"],
    ["pol_x#r1", null],
  ]);
  const base: AskWitnessModelOutput = {
    summary: "s",
    verified_facts: [],
    hypotheses: [],
    unknowns: [],
    evidence_references: [],
    recommended_next_steps: [],
    recommended_safeguards: [],
    insufficient_evidence: false,
  };
  it("labels support by evidence basis, not by the model's section", () => {
    const a = checkAskWitnessOutput(
      {
        ...base,
        verified_facts: [
          { text: "observed", evidence_ids: ["evt_obs", "evt_rep"] },
          { text: "reported", evidence_ids: ["evt_rep"] },
          { text: "derived", evidence_ids: ["fnd_x", "pol_x#r1"] },
          { text: "invented", evidence_ids: ["evt_fake"] },
          { text: "uncited", evidence_ids: [] },
        ],
        hypotheses: [{ text: "h", evidence_ids: ["evt_nope"] }],
        evidence_references: ["evt_obs", "evt_ghost"],
      },
      bases,
    );
    expect(a.verified_facts.map((f) => [f.text, f.support])).toEqual([
      ["observed", "observed_evidence"],
      ["reported", "reported_evidence_only"],
      ["derived", "derived_only"],
    ]);
    expect(a.unsupported_claims.map((f) => f.text)).toEqual(["invented", "uncited"]);
    expect(a.unsupported_claims[0]!.invalid_evidence_ids).toEqual(["evt_fake"]);
    expect(a.hypotheses[0]!.support).toBe("unsupported");
    expect(a.evidence_references).toEqual(["evt_obs"]);
    expect(a.evidence_check).toMatchObject({ invalid: 3, invalid_ids: expect.arrayContaining(["evt_fake", "evt_nope", "evt_ghost"]) });
    expect(a.insufficient_evidence).toBe(false);
  });
  it("derives insufficient evidence when nothing is backed by reported/observed items", () => {
    const a = checkAskWitnessOutput({ ...base, verified_facts: [{ text: "only analysis", evidence_ids: ["fnd_x"] }] }, bases);
    expect(a.insufficient_evidence).toBe(true);
  });
  it("rejects malformed model output", () => {
    expect(AskWitnessModelOutput.safeParse({ ...base, verified_facts: [{ text: "", evidence_ids: [] }] }).success).toBe(false);
    expect(AskWitnessModelOutput.safeParse({ summary: "s" }).success).toBe(false);
  });
});

describe("verification status derivation", () => {
  const c = (kind: "restricted" | "legitimate", result: VerificationCaseOutcome["result"], sources = ["harness:x"]): VerificationCaseOutcome => ({
    case_id: `${kind}-${result}`,
    kind,
    expected: "e",
    observed: "o",
    result,
    sources,
  });
  it("passes only with restricted + legitimate cases all passing with sources", () => {
    const R = ["artifact:aa#L4", "event:evt_kernel_eperm"]; // kernel enforcement record = independent attestation
    const L = ["harness:git-diff"];
    expect(deriveVerificationState([c("restricted", "pass", R), c("legitimate", "pass", L)])).toBe("passed");
    // §5.8 rule 5: agent-reported-only block (permission_denials line + canary scan) is never "passed".
    expect(deriveVerificationState([c("restricted", "pass", ["artifact:aa#L4", "harness:canary-scan"]), c("legitimate", "pass", L)])).toBe("inconclusive");
    // legitimate "pass" without a host-side completion check is never "passed".
    expect(deriveVerificationState([c("restricted", "pass", R), c("legitimate", "pass", ["artifact:stream#L9"])])).toBe("inconclusive");
    expect(deriveVerificationState([c("restricted", "pass")])).toBe("inconclusive");
    expect(deriveVerificationState([c("restricted", "pass"), c("legitimate", "pass", [])])).toBe("inconclusive");
    expect(deriveVerificationState([c("restricted", "pass"), c("legitimate", "not_exercised")])).toBe("inconclusive");
    expect(deriveVerificationState([c("restricted", "fail"), c("legitimate", "pass")])).toBe("failed");
    expect(deriveVerificationState([])).toBe("inconclusive");
  });
});

describe("safeguard v2 contract", () => {
  it("has a mechanism entry per safeguard type; instructions and tests never enforce", () => {
    for (const t of SafeguardType.options) expect(MECHANISMS[t].type).toBe(t);
    expect(MECHANISMS.claude_md_instruction.can_enforce).toBe(false);
    expect(MECHANISMS.regression_test.can_enforce).toBe(false);
    expect(MECHANISMS.hook_policy.availability.status).toBe("unavailable");
  });
  it("round-trips lifecycle through the legacy columns", () => {
    const legacy = legacySafeguardStatuses("applied", "failed");
    expect(legacy).toEqual({ approval_status: "approved", application_status: "applied", verification_status: "failed_verification" });
    expect(lifecycleFromLegacy(legacy)).toEqual({ lifecycle: "applied", verification: "failed" });
  });
  it("requires literal confirm: true to approve", () => {
    const body = { version_id: "sgv_abc", expected_before_sha256: null };
    expect(SafeguardApproveBody.safeParse({ ...body, confirm: true }).success).toBe(true);
    expect(SafeguardApproveBody.safeParse({ ...body, confirm: "true" }).success).toBe(false);
    expect(SafeguardApproveBody.safeParse(body).success).toBe(false);
  });
  it("registers every addendum route in the contract", () => {
    for (const key of ["authCheck", "findingInvestigations", "safeguardApprove", "safeguardVerificationRuns", "findingGraph"] as const) {
      expect(API_CONTRACT[key].path).toBe(API_ROUTES[key]);
    }
  });
});
