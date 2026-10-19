import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeRun, computeSeverity, confidenceFromClaims } from "../src/index";
import { POLICY, SCENARIOS } from "./scenarios";

const get = (id: string) => SCENARIOS.find((s) => s.id.startsWith(id))!;

describe("confidence and severity are independent", () => {
  it("all four high/low combinations occur (2x2)", () => {
    const cells = new Map<string, string>();
    for (const id of ["s03", "s13", "s12", "s14"]) {
      const f = analyzeRun(get(id).input).findings.find((x) => x.category === "permission_violation")!;
      const sev = f.severity === "high" || f.severity === "critical" ? "high" : f.severity === "low" || f.severity === "info" ? "low" : "mid";
      cells.set(`${f.confidence}-confidence/${sev}-severity`, id);
    }
    expect([...cells.keys()].sort()).toEqual([
      "high-confidence/high-severity",
      "high-confidence/low-severity",
      "low-confidence/high-severity",
      "low-confidence/low-severity",
    ]);
  });

  it("changing only evidence quality moves confidence, never severity", () => {
    const base = get("s03").input;
    const degraded = { ...base, events: base.events.map((e) => (e.event_type === "file_open" ? { ...e, collection_status: "partial" as const, outcome: "attempted" as const } : e)) };
    const a = analyzeRun(base).findings[0]!;
    const b = analyzeRun(degraded).findings[0]!;
    expect(a.severity).toBe(b.severity);
    expect(a.confidence).toBe("high");
    expect(b.confidence).toBe("low");
  });

  it("changing only the policy's declared severity moves severity, never confidence", () => {
    const base = get("s03").input;
    const lowered = { ...base, policy: { ...POLICY, rules: POLICY.rules.map((r) => (r.id === "R-SECRETS" ? { ...r, severity: "low" as const } : r)) } };
    const a = analyzeRun(base).findings[0]!;
    const b = analyzeRun(lowered).findings[0]!;
    expect(a.confidence).toBe(b.confidence);
    expect(a.severity).toBe("high");
    expect(b.severity).toBe("low");
  });

  it("rubric functions take disjoint inputs", () => {
    expect(confidenceFromClaims([{ claim: "occurred", grade: "high", reason: "" }, { claim: "outcome", grade: "medium", reason: "" }])).toBe("medium");
    expect(computeSeverity({ category: "permission_violation", action: "read", sensitivity: 3, outcome: "blocked", declared: null }).severity).toBe("medium");
    expect(computeSeverity({ category: "permission_violation", action: "write", sensitivity: 1, outcome: "blocked", declared: "low" }).severity).toBe("low");
    const sevSrc = readFileSync(fileURLToPath(new URL("../src/rubric/severity.ts", import.meta.url)), "utf8");
    const confSrc = readFileSync(fileURLToPath(new URL("../src/rubric/confidence.ts", import.meta.url)), "utf8");
    expect(sevSrc).not.toMatch(/from "\.\/confidence"|from "\.\.\/attribution"|from "\.\.\/coverage"/);
    expect(confSrc).not.toMatch(/from "\.\/severity"|from "\.\.\/policy"|from "\.\.\/sensitivity"/);
  });
});
