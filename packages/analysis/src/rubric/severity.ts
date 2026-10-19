import type { FindingCategory, Severity } from "@kw/schema";

/**
 * Severity rubric: policy and resource sensitivity ONLY (plus the action's outcome value, which is a property of what
 * happened, not of how well we know it). Takes no evidence grade, match state or coverage input; must not import the
 * confidence rubric or the attribution stage (enforced by test/rubric.test.ts).
 *
 * Base matrix (action x sensitivity level 3..0; network uses N3/N1/N0 as 3/1/0):
 *                 3       2        1        0
 *   read          high    medium   low      info
 *   write/delete  high    high     medium   info
 *   exec          high    medium   low      info
 *   net           high    medium   low      info
 * Category application:
 *   permission_violation   declared rule severity if present, else matrix; blocked/failed -1 level (floor low)
 *   unreported_observed_action   matrix; blocked/failed -1 level (floor low)
 *   change_mismatch        matrix, write row
 *   outcome_mismatch       matrix on the misreported action; +1 when an agent-layer denial did not hold (cap critical)
 *   uncertain_correlation  maximum over what is at stake (the alternative interpretations)
 */
export type SeverityAction = "read" | "write" | "exec" | "net";
export type SeverityOutcome = "completed" | "blocked" | "failed" | "undetermined";

const ORDER: Severity[] = ["info", "low", "medium", "high", "critical"];
const MATRIX: Record<SeverityAction, [Severity, Severity, Severity, Severity]> = {
  // index = sensitivity level 0..3
  read: ["info", "low", "medium", "high"],
  write: ["info", "medium", "high", "high"],
  exec: ["info", "low", "medium", "high"],
  net: ["info", "low", "medium", "high"],
};

export function matrixSeverity(action: SeverityAction, level: number): Severity {
  const l = Math.max(0, Math.min(3, level)) as 0 | 1 | 2 | 3;
  return MATRIX[action][l];
}

export function shift(s: Severity, by: number, floor: Severity = "info"): Severity {
  const i = Math.max(ORDER.indexOf(floor), Math.min(ORDER.length - 1, ORDER.indexOf(s) + by));
  return ORDER[i]!;
}

export function maxSeverity(list: Severity[]): Severity {
  return list.reduce<Severity>((acc, s) => (ORDER.indexOf(s) > ORDER.indexOf(acc) ? s : acc), "info");
}

export interface SeverityInput {
  category: FindingCategory;
  action: SeverityAction;
  /** 0..3 (S0..S3 or N0..N3). */
  sensitivity: number;
  outcome: SeverityOutcome;
  declared: Severity | null;
  /** outcome_mismatch: the agent layer reported a denial but the action completed. */
  agentLayerDenialFailed?: boolean;
  /** uncertain_correlation: severities of the alternative interpretations. */
  stakes?: Severity[];
}

export function computeSeverity(i: SeverityInput): { severity: Severity; basis: string } {
  const base = matrixSeverity(i.action, i.sensitivity);
  switch (i.category) {
    case "permission_violation": {
      const s0 = i.declared ?? base;
      const src = i.declared ? `declared rule severity ${i.declared}` : `matrix ${i.action} x level ${i.sensitivity} = ${base}`;
      if (i.outcome === "blocked" || i.outcome === "failed") {
        const s = s0 === "info" ? "info" : shift(s0, -1, "low");
        return { severity: s, basis: `${src}; ${i.outcome} -1 (floor low) = ${s}` };
      }
      return { severity: s0, basis: `${src}; outcome ${i.outcome}, no adjustment` };
    }
    case "unreported_observed_action": {
      if (i.outcome === "blocked" || i.outcome === "failed") {
        const s = base === "info" ? "info" : shift(base, -1, "low");
        return { severity: s, basis: `matrix ${i.action} x level ${i.sensitivity} = ${base}; ${i.outcome} -1 (floor low) = ${s}` };
      }
      return { severity: base, basis: `matrix ${i.action} x level ${i.sensitivity} = ${base}` };
    }
    case "change_mismatch": {
      const s = matrixSeverity("write", i.sensitivity);
      return { severity: s, basis: `matrix write x level ${i.sensitivity} = ${s}` };
    }
    case "outcome_mismatch": {
      if (i.agentLayerDenialFailed) {
        const s = shift(base, 1);
        return { severity: s, basis: `matrix ${i.action} x level ${i.sensitivity} = ${base}; agent-layer denial did not hold +1 = ${s}` };
      }
      return { severity: base, basis: `matrix ${i.action} x level ${i.sensitivity} = ${base}` };
    }
    case "uncertain_correlation": {
      const s = maxSeverity(i.stakes && i.stakes.length ? i.stakes : [base]);
      return { severity: s, basis: `maximum severity among alternative interpretations = ${s}` };
    }
  }
}
