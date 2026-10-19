import type { EvidenceBundle } from "./bundle";
import type { Explanation, SafeguardProposal } from "./schemas";

/**
 * "cited" means only that every cited id exists in the bundle and at least one id is cited. It does NOT mean the
 * evidence supports the statement (a model can cite a real but unrelated id). UIs must still label every AI
 * statement as advisory / unverified (ai& verifier omission #2; PRD FR-7).
 */
export type CitationStatus = "cited" | "unsupported";
export type UnsupportedReason = "no_citations" | "unknown_evidence_ids";

export interface CheckedClaim {
  text: string;
  evidence_ids: string[];
  citation_status: CitationStatus;
  unsupported_reason: UnsupportedReason | null;
  /** Cited ids that are not in the bundle (never shown as links). */
  unknown_evidence_ids: string[];
}

export interface CheckedExplanation {
  summary: string;
  claims: CheckedClaim[];
  missing_evidence: string[];
  next_steps: string[];
  insufficient_evidence: boolean;
  citation_check: { cited_claims: number; unsupported_claims: number; unknown_ids: string[] };
  /** Always true: AI output is advisory data, never evidence, never a status change. */
  advisory: true;
}

export interface CheckedSafeguardProposal extends SafeguardProposal {
  citation_status: CitationStatus;
  unsupported_reason: UnsupportedReason | null;
  unknown_evidence_ids: string[];
  /**
   * Cheap lexical flags for the human reviewer. The authoritative non-broadening check belongs to the safeguard
   * executor (FR-9); this only highlights obvious cases.
   */
  review_flags: Array<"possibly_broadens_permissions" | "cites_unknown_evidence" | "no_citations">;
  advisory: true;
  applied: false;
}

function checkIds(ids: readonly string[], allowed: ReadonlySet<string>): Pick<CheckedClaim, "citation_status" | "unsupported_reason" | "unknown_evidence_ids"> {
  const unknown = [...new Set(ids.filter((id) => !allowed.has(id)))];
  if (ids.length === 0) return { citation_status: "unsupported", unsupported_reason: "no_citations", unknown_evidence_ids: [] };
  if (unknown.length > 0) return { citation_status: "unsupported", unsupported_reason: "unknown_evidence_ids", unknown_evidence_ids: unknown };
  return { citation_status: "cited", unsupported_reason: null, unknown_evidence_ids: [] };
}

/** Mark every claim that cites nothing, or cites any id absent from the bundle, as unsupported. */
export function checkExplanationCitations(expl: Explanation, bundle: Pick<EvidenceBundle, "allowed_ids">): CheckedExplanation {
  const allowed = new Set(bundle.allowed_ids);
  const claims: CheckedClaim[] = expl.claims.map((c) => ({ text: c.text, evidence_ids: [...c.evidence_ids], ...checkIds(c.evidence_ids, allowed) }));
  const unknown = [...new Set(claims.flatMap((c) => c.unknown_evidence_ids))];
  return {
    summary: expl.summary,
    claims,
    missing_evidence: [...expl.missing_evidence],
    next_steps: [...expl.next_steps],
    insufficient_evidence: expl.insufficient_evidence,
    citation_check: {
      cited_claims: claims.filter((c) => c.citation_status === "cited").length,
      unsupported_claims: claims.filter((c) => c.citation_status === "unsupported").length,
      unknown_ids: unknown,
    },
    advisory: true,
  };
}

const BROADENING = /("allow"\s*:|\ballow\b|defaultMode|bypassPermissions|dangerously|--dangerously-skip-permissions|\*\*?\)|Bash\(\*\))/i;

export function checkSafeguardCitations(p: SafeguardProposal, bundle: Pick<EvidenceBundle, "allowed_ids">): CheckedSafeguardProposal {
  const res = checkIds(p.evidence_ids, new Set(bundle.allowed_ids));
  const flags: CheckedSafeguardProposal["review_flags"] = [];
  if (res.unsupported_reason === "no_citations") flags.push("no_citations");
  if (res.unsupported_reason === "unknown_evidence_ids") flags.push("cites_unknown_evidence");
  if ((p.type === "permission_rule" || p.type === "hook_policy") && BROADENING.test(p.content)) flags.push("possibly_broadens_permissions");
  return { ...p, evidence_ids: [...p.evidence_ids], ...res, review_flags: flags, advisory: true, applied: false };
}
