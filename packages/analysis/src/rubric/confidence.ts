import type { Confidence } from "@kw/schema";
import type { ConfidenceClaim } from "../types";

/**
 * Confidence rubric: evidence quality and attribution strength ONLY.
 * A finding is decomposed into claims (occurred, attributed, outcome, reported, policy_applies, correlation); each claim
 * is graded from the evidence behind it, and the finding's confidence is the weakest claim. This module deliberately
 * takes no policy, severity, or resource-sensitivity input (independence is enforced by test/rubric.test.ts).
 */
const RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

export function confidenceFromClaims(claims: ConfidenceClaim[]): Confidence {
  if (claims.length === 0) return "low";
  return claims.reduce<Confidence>((acc, c) => (RANK[c.grade] < RANK[acc] ? c.grade : acc), "high");
}

export function minConfidence(a: Confidence, b: Confidence): Confidence {
  return RANK[a] <= RANK[b] ? a : b;
}
