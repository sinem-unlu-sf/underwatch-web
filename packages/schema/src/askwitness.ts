/**
 * Ask Witness (addendum Feature A). Two shapes on purpose:
 * - AskWitnessModelOutput: what ai& is asked to return. Untrusted. Never shown directly.
 * - AskWitnessAnswer: what the app stores/returns AFTER deterministic validation. Every fact/hypothesis carries an
 *   app-assigned `support` computed from the evidence bundle that was actually sent, never from the model's choice of
 *   section. The UI must label claims with EVIDENCE_SUPPORT_LABELS and must never call a claim "verified" because the
 *   model placed it in verified_facts.
 * AI responses live in investigation_turns, separate from evidence/events, and are never projected as event records.
 */
import { z } from "zod";
import { EventBasis, SafeguardType, Severity } from "./enums";
import { FindingId, RunId, Timestamp } from "./entities";
import { idPattern } from "./ids";

export const InvestigationId = z.string().regex(idPattern("investigation"));
export const InvestigationTurnId = z.string().regex(idPattern("investigation_turn"));

/** Client-generated idempotency key (UUID recommended). Re-sending the same key returns the stored result, never a duplicate. */
export const ClientRequestId = z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9_.:-]+$/);
export type ClientRequestId = z.infer<typeof ClientRequestId>;

export const InvestigationStatus = z.enum(["active", "closed"]);
export type InvestigationStatus = z.infer<typeof InvestigationStatus>;

/**
 * What an investigation is about. finding: one finding (v1). run: one agent run. workspace: all of Underwatch's own
 * records (findings, runs, coverage, safeguards, verification results, digest). Follow-ups always stay in their scope;
 * retrieval is deterministic and reads Underwatch's database only (never repository files, the web, or model SQL).
 */
export const InvestigationScopeKind = z.enum(["finding", "run", "workspace"]);
export type InvestigationScopeKind = z.infer<typeof InvestigationScopeKind>;

export const Investigation = z.object({
  id: InvestigationId,
  /** Additive (default "finding" for v1 rows). */
  scope_kind: InvestigationScopeKind.default("finding"),
  /** Finding id (finding scope), run id (run scope), null (workspace scope). */
  scope_id: z.string().nullable().default(null),
  /** Null for run / workspace scope. */
  finding_id: FindingId.nullable(),
  /** Null for workspace scope. */
  run_id: RunId.nullable(),
  status: InvestigationStatus,
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type Investigation = z.infer<typeof Investigation>;

// ---------------------------------------------------------------------------------------------------------------
// Model output (sent to ai& as the response schema; validated locally even in strict json_schema mode)
// ---------------------------------------------------------------------------------------------------------------

const text = (max: number) => z.string().trim().min(1).max(max);
const modelIds = z.array(z.string().min(1).max(200)).max(20);

export const ModelClaim = z.object({ text: text(1000), evidence_ids: modelIds });
export type ModelClaim = z.infer<typeof ModelClaim>;

export const AskWitnessModelOutput = z.object({
  summary: text(2000),
  verified_facts: z.array(ModelClaim).max(12),
  hypotheses: z.array(ModelClaim).max(8),
  unknowns: z.array(z.object({ text: text(600) })).max(10),
  evidence_references: modelIds,
  recommended_next_steps: z.array(text(400)).max(8),
  recommended_safeguards: z.array(z.object({ type: SafeguardType, description: text(800) })).max(4),
  /** Model's own flag; the app ALSO derives insufficiency (see AskWitnessAnswer.insufficient_evidence). */
  insufficient_evidence: z.boolean(),
});
export type AskWitnessModelOutput = z.infer<typeof AskWitnessModelOutput>;

/** JSON Schema for ai& response_format (conservative keyword subset, every key required; limits enforced by Zod above). */
export const ASK_WITNESS_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    verified_facts: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, evidence_ids: { type: "array", items: { type: "string" } } },
        required: ["text", "evidence_ids"],
        additionalProperties: false,
      },
    },
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, evidence_ids: { type: "array", items: { type: "string" } } },
        required: ["text", "evidence_ids"],
        additionalProperties: false,
      },
    },
    unknowns: {
      type: "array",
      items: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    },
    evidence_references: { type: "array", items: { type: "string" } },
    recommended_next_steps: { type: "array", items: { type: "string" } },
    recommended_safeguards: {
      type: "array",
      items: {
        type: "object",
        properties: { type: { type: "string", enum: [...SafeguardType.options] }, description: { type: "string" } },
        required: ["type", "description"],
        additionalProperties: false,
      },
    },
    insufficient_evidence: { type: "boolean" },
  },
  required: [
    "summary",
    "verified_facts",
    "hypotheses",
    "unknowns",
    "evidence_references",
    "recommended_next_steps",
    "recommended_safeguards",
    "insufficient_evidence",
  ],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Validated answer (stored + returned)
// ---------------------------------------------------------------------------------------------------------------

/**
 * App-assigned evidence basis of a claim, from the VALID cited ids only:
 * observed_evidence:       cites >= 1 in-bundle item whose basis is "observed".
 * reported_evidence_only:  valid citations, at least one "reported", none "observed".
 * derived_only:            valid citations are only "derived" items (findings, correlations, policy rules) - KW's own analysis.
 * unsupported:             no valid citation at all (none given, or every cited id is absent from the bundle).
 */
export const EvidenceSupport = z.enum(["observed_evidence", "reported_evidence_only", "derived_only", "unsupported"]);
export type EvidenceSupport = z.infer<typeof EvidenceSupport>;

/** The ONLY labels the UI may use for claims. Note: none of them says "verified". */
export const EVIDENCE_SUPPORT_LABELS: Record<EvidenceSupport, string> = {
  observed_evidence: "Backed by observed evidence",
  reported_evidence_only: "Agent-reported evidence only",
  derived_only: "Underwatch analysis only",
  unsupported: "Unsupported (no valid citation)",
};

/** Kinds of action claims that need a confirming Underwatch record (Addendum C: never claim unconfirmed actions). */
export const ActionClaimKind = z.enum(["verified", "tested", "applied", "fixed"]);
export type ActionClaimKind = z.infer<typeof ActionClaimKind>;

export const ActionClaimFlag = z.object({
  /** Where the sentence was found in the AI answer. */
  location: z.enum(["summary", "verified_fact", "hypothesis"]),
  claim: ActionClaimKind,
  /** The AI sentence that makes the claim (verbatim, clipped). */
  text: z.string(),
  /** App-written reason (never model text). */
  reason: z.string(),
});
export type ActionClaimFlag = z.infer<typeof ActionClaimFlag>;

export const CheckedClaim = z.object({
  text: z.string(),
  /** Cited ids that exist in the bundle that was sent (clickable). */
  evidence_ids: z.array(z.string()),
  /** Cited ids NOT in the bundle (never rendered as links). */
  invalid_evidence_ids: z.array(z.string()),
  support: EvidenceSupport,
  /** Distinct bases of the valid cited items. */
  cited_bases: z.array(EventBasis),
});
export type CheckedClaim = z.infer<typeof CheckedClaim>;

export const AskWitnessAnswer = z.object({
  summary: z.string(),
  /** Claims the model put in verified_facts that have >= 1 valid citation, each labeled by `support`. */
  verified_facts: z.array(CheckedClaim),
  /** Hypotheses keep their place even when unsupported (they are hypotheses), labeled by `support`. */
  hypotheses: z.array(CheckedClaim),
  unknowns: z.array(z.object({ text: z.string() })),
  /** Model's evidence_references filtered to in-bundle ids. */
  evidence_references: z.array(z.string()),
  recommended_next_steps: z.array(z.string()),
  recommended_safeguards: z.array(z.object({ type: SafeguardType, description: z.string() })),
  /** Facts that ended up with support "unsupported", moved out of verified_facts. */
  unsupported_claims: z.array(CheckedClaim),
  evidence_check: z.object({
    /** Distinct ids cited anywhere in the model output. */
    cited: z.number().int().nonnegative(),
    valid: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    invalid_ids: z.array(z.string()),
  }),
  /** model flag OR no fact with support observed_evidence/reported_evidence_only. */
  insufficient_evidence: z.boolean(),
  /** Always true: advisory interpretation, not evidence, never a status change. */
  advisory: z.literal(true),
  /**
   * App-generated (NOT model) statements about gaps in the bundle that was sent: no observed events, coverage gaps,
   * omitted items, invalid citations. Optional for compatibility; the server always sets it.
   */
  evidence_limitations: z.array(z.string()).optional(),
  /**
   * App-generated (Addendum C): statements in the AI text that say an action was performed / applied / tested /
   * verified / fixed while no Underwatch record in the bundle confirms it. Optional for compatibility.
   */
  action_claim_flags: z.array(ActionClaimFlag).optional(),
});
export type AskWitnessAnswer = z.infer<typeof AskWitnessAnswer>;

/** Answer depth (Addendum C): concise by default, more depth on request. */
export const AskWitnessDepth = z.enum(["concise", "detailed"]);
export type AskWitnessDepth = z.infer<typeof AskWitnessDepth>;
/** Answer style: simple = plain language without jargon (same evidence rules). */
export const AskWitnessStyle = z.enum(["standard", "simple"]);
export type AskWitnessStyle = z.infer<typeof AskWitnessStyle>;
export const ASK_WITNESS_DEFAULT_DEPTH: AskWitnessDepth = "concise";
export const ASK_WITNESS_DEFAULT_STYLE: AskWitnessStyle = "standard";

export const InvestigationTurnStatus = z.enum(["answered", "insufficient_evidence", "ai_unavailable", "ai_error", "invalid_output"]);
export type InvestigationTurnStatus = z.infer<typeof InvestigationTurnStatus>;

/** Safe error codes for failed turns. Messages never include prompts, keys, or raw provider bodies. */
export const InvestigationTurnErrorCode = z.enum(["not_configured", "unavailable", "rate_limited", "timeout", "provider_error", "invalid_output"]);
export type InvestigationTurnErrorCode = z.infer<typeof InvestigationTurnErrorCode>;

export const InvestigationTurn = z.object({
  id: InvestigationTurnId,
  investigation_id: InvestigationId,
  client_request_id: ClientRequestId,
  question: z.string(),
  /** allowed_ids of the bundle sent (or that would have been sent) for this turn. */
  evidence_ids: z.array(z.string()),
  bundle_hash: z.string().nullable(),
  /** Requested model id ("none" when ai& is not configured). */
  model: z.string(),
  prompt_version: z.string(),
  status: InvestigationTurnStatus,
  answer: AskWitnessAnswer.nullable(),
  error: z.object({ code: InvestigationTurnErrorCode, message: z.string() }).nullable(),
  created_at: Timestamp,
  /** Additive (Addendum C): the depth/style this turn was asked with. Absent on older turns (= concise/standard). */
  depth: AskWitnessDepth.optional(),
  style: AskWitnessStyle.optional(),
});
export type InvestigationTurn = z.infer<typeof InvestigationTurn>;

/** Display index so every cited id in an answer can be opened (event inspector / evidence panel / finding). */
export const BundleEvidenceRef = z.object({
  evidence_id: z.string(),
  /** coverage / safeguard / related_finding: Ask Witness context items (additive; Underwatch records, basis "derived"). */
  kind: z.enum(["finding", "event", "evidence", "policy_rule", "coverage", "safeguard", "related_finding", "run", "overview", "verification", "digest"]),
  basis: EventBasis.nullable(),
  source: z.string().nullable(),
  timestamp: Timestamp.nullable(),
  /** Short, redacted one-liner (event summary / evidence source_reference / rule description). */
  summary: z.string(),
  /** Where the UI navigates: event -> run timeline (run_id + event id), evidence -> /api/evidence/:id, finding -> finding page. */
  run_id: RunId.nullable(),
});
export type BundleEvidenceRef = z.infer<typeof BundleEvidenceRef>;

/** Run-scope starters (questions about one agent run). */
export const ASK_WITNESS_RUN_SUGGESTED_QUESTIONS = [
  "What did the agent do in this run, and what was blocked?",
  "Where does the agent's report differ from what was observed?",
  "Which findings in this run are still open?",
  "What could the observers not see in this run?",
] as const;

/** Workspace-scope starters (questions across all of Underwatch's records). */
export const ASK_WITNESS_WORKSPACE_SUGGESTED_QUESTIONS = [
  "What was blocked across all runs and what is still uncertain?",
  "Which open findings are the most severe?",
  "What happened today?",
  "Which safeguards have been verified, and what did verification show?",
  "Where is observation coverage weakest?",
] as const;

/**
 * Finding-scope starters (Addendum C section 4: the judge's eight questions). The earlier investigator questions stay
 * available as ASK_WITNESS_INVESTIGATOR_QUESTIONS.
 */
export const ASK_WITNESS_SUGGESTED_QUESTIONS = [
  "Why is this a problem?",
  "Can you explain this in simpler terms?",
  "What evidence supports this conclusion?",
  "What could happen if this issue is ignored?",
  "Why does the agent's report differ from the observed behavior?",
  "How should I fix this issue?",
  "How can I verify that the fix works?",
  "What additional technical details should I know?",
] as const;

/** Pre-Addendum-C finding-scope starters (kept; shown as "more questions" in the panel). */
export const ASK_WITNESS_INVESTIGATOR_QUESTIONS = [
  "Why was this finding flagged?",
  "Did the agent actually access the file, or was the attempt blocked?",
  "Which evidence supports this conclusion?",
  "What happened immediately before and after this event?",
  "Is there another plausible explanation?",
  "What information is still missing?",
  "Have similar findings occurred in other runs?",
  "What safeguard would reduce the chance of recurrence?",
] as const;

// ---------------------------------------------------------------------------------------------------------------
// API bodies / responses
// ---------------------------------------------------------------------------------------------------------------

/** POST /api/findings/:id/investigations. Omit investigation_id to start a new investigation; pass it for follow-ups. */
export const AskWitnessBody = z.object({
  investigation_id: InvestigationId.optional(),
  question: z.string().trim().min(1).max(2000),
  client_request_id: ClientRequestId,
  /** Additive (Addendum C). Omitted = "concise". */
  depth: AskWitnessDepth.optional(),
  /** Additive (Addendum C). Omitted = "standard". */
  style: AskWitnessStyle.optional(),
});
export type AskWitnessBody = z.infer<typeof AskWitnessBody>;

/**
 * Always HTTP 200 once the question is accepted: AI failures are recorded as a turn with status ai_unavailable /
 * ai_error / invalid_output (evidence untouched). replayed = true when client_request_id was seen before.
 */
export const AskWitnessResponse = z.object({
  investigation: Investigation,
  turn: InvestigationTurn,
  evidence_index: z.array(BundleEvidenceRef),
  replayed: z.boolean(),
});
export type AskWitnessResponse = z.infer<typeof AskWitnessResponse>;

export const InvestigationSummary = Investigation.extend({
  turn_count: z.number().int().nonnegative(),
  last_question: z.string().nullable(),
});
export type InvestigationSummary = z.infer<typeof InvestigationSummary>;

export const FindingInvestigationsResponse = z.object({ items: z.array(InvestigationSummary) });

/** GET /api/runs/:id/investigations and GET /api/investigations?scope=workspace share this list shape. */
export const ScopedInvestigationsResponse = FindingInvestigationsResponse;
export type ScopedInvestigationsResponse = FindingInvestigationsResponse;
export const InvestigationsListQuery = z.object({ scope: z.literal("workspace").default("workspace") });
export type InvestigationsListQuery = z.infer<typeof InvestigationsListQuery>;
export type FindingInvestigationsResponse = z.infer<typeof FindingInvestigationsResponse>;

export const InvestigationDetailResponse = z.object({
  investigation: Investigation,
  /** The finding for finding-scope investigations; null for run / workspace scope. */
  finding: z.object({ id: FindingId, title: z.string(), severity: Severity, run_id: RunId, is_fixture: z.boolean() }).nullable(),
  /** Additive: what the investigation is about (label is a short display string). */
  scope: z.object({ kind: InvestigationScopeKind, id: z.string().nullable(), label: z.string() }).optional(),
  /** Ordered by created_at asc. */
  turns: z.array(InvestigationTurn),
  /** Union over all turns. */
  evidence_index: z.array(BundleEvidenceRef),
  /** ai& status at read time, for the panel's banner (never contains secrets). */
  ai: z.object({ available: z.boolean(), detail: z.string() }),
});
export type InvestigationDetailResponse = z.infer<typeof InvestigationDetailResponse>;

// ---------------------------------------------------------------------------------------------------------------
// Deterministic validation helper (shared so server and tests agree)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Converts validated model output into an AskWitnessAnswer. `bases` maps every in-bundle id to its basis
 * (null basis items such as policy rules count as "derived").
 */
export function checkAskWitnessOutput(out: AskWitnessModelOutput, bases: ReadonlyMap<string, EventBasis | null>): AskWitnessAnswer {
  const cited = new Set<string>();
  const invalid = new Set<string>();
  const check = (c: ModelClaim): CheckedClaim => {
    const valid: string[] = [];
    const bad: string[] = [];
    for (const id of new Set(c.evidence_ids)) {
      cited.add(id);
      if (bases.has(id)) valid.push(id);
      else {
        bad.push(id);
        invalid.add(id);
      }
    }
    const cb = [...new Set(valid.map((id) => bases.get(id) ?? "derived"))] as EventBasis[];
    const support: EvidenceSupport =
      valid.length === 0 ? "unsupported" : cb.includes("observed") ? "observed_evidence" : cb.includes("reported") ? "reported_evidence_only" : "derived_only";
    return { text: c.text, evidence_ids: valid, invalid_evidence_ids: bad, support, cited_bases: cb };
  };
  const facts = out.verified_facts.map(check);
  const hypotheses = out.hypotheses.map(check);
  for (const id of out.evidence_references) {
    cited.add(id);
    if (!bases.has(id)) invalid.add(id);
  }
  const supportedFacts = facts.filter((f) => f.support !== "unsupported");
  const insufficient = out.insufficient_evidence || !supportedFacts.some((f) => f.support === "observed_evidence" || f.support === "reported_evidence_only");
  return {
    summary: out.summary,
    verified_facts: supportedFacts,
    hypotheses,
    unknowns: out.unknowns.map((u) => ({ text: u.text })),
    evidence_references: [...new Set(out.evidence_references.filter((id) => bases.has(id)))],
    recommended_next_steps: [...out.recommended_next_steps],
    recommended_safeguards: out.recommended_safeguards.map((s) => ({ type: s.type, description: s.description })),
    unsupported_claims: facts.filter((f) => f.support === "unsupported"),
    evidence_check: { cited: cited.size, valid: cited.size - invalid.size, invalid: invalid.size, invalid_ids: [...invalid] },
    insufficient_evidence: insufficient,
    advisory: true,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Action-claim check (Addendum C section 4): the AI must not say that something was performed, applied, tested,
// verified or fixed unless a Underwatch record in the bundle that was sent confirms it.
// ---------------------------------------------------------------------------------------------------------------

/** Ids of bundle records that confirm each kind of action (empty = no record confirms it). */
export interface ActionRecordStatus {
  verified: string[];
  tested: string[];
  applied: string[];
  fixed: string[];
}

type RecordLike = { evidence_id: string; kind: string; fields: Readonly<Record<string, unknown>> };

const TESTED_SAFEGUARD_STATES = new Set(["verified_for_tested_scenario", "failed_verification", "verification_inconclusive"]);

/**
 * Derives which actions the records confirm, from bundle items only (finding, safeguard and verification records).
 * verified: a safeguard verified_for_tested_scenario, or a completed verification run whose security outcome is an
 * observed block. tested: any completed verification run / tested safeguard state. applied: application_status
 * "applied". fixed: finding status "resolved" (or an applied safeguard, which is a recorded mitigation).
 */
export function actionRecordsFromItems(items: readonly RecordLike[]): ActionRecordStatus {
  const r: ActionRecordStatus = { verified: [], tested: [], applied: [], fixed: [] };
  for (const i of items) {
    const f = i.fields;
    const sgState = f.legacy_safeguard_verification_status ?? f.verification_status;
    const runCompleted = f.last_verification_run_status === "completed" || (i.kind === "verification" && f.status === "completed");
    const observedBlock = f.security_outcome === "blocked" && f.security_outcome_basis === "observed";
    if (i.kind === "safeguard" || i.kind === "verification") {
      if (sgState === "verified_for_tested_scenario" || (runCompleted && observedBlock)) r.verified.push(i.evidence_id);
      if (runCompleted || (typeof sgState === "string" && TESTED_SAFEGUARD_STATES.has(sgState))) r.tested.push(i.evidence_id);
      if (f.application_status === "applied") {
        r.applied.push(i.evidence_id);
        r.fixed.push(i.evidence_id);
      }
    }
    if (i.kind === "finding" && f.status === "resolved") r.fixed.push(i.evidence_id);
  }
  return r;
}

const ACTION_PATTERNS: Record<ActionClaimKind, RegExp> = {
  verified: /\b(?:has|have|had|was|were|been|is|are)\s+(?:been\s+)?(?:now\s+)?(?:successfully\s+)?verified\b|\bverification\s+(?:passed|succeeded|confirmed)\b|\bpassed\s+(?:its\s+|the\s+)?verification\b/i,
  tested: /\b(?:has|have|had|was|were|been)\s+(?:been\s+)?(?:successfully\s+)?tested\b|\b(?:regression\s+)?tests?\s+(?:passed|succeeded)\b|\bpassed\s+(?:the\s+|its\s+|a\s+)?(?:regression\s+)?tests?\b/i,
  applied: /\b(?:has|have|had|was|were|been)\s+(?:been\s+)?(?:successfully\s+)?(?:applied|deployed|installed|enabled|rolled\s+out|added)\b|\b(?:is|are)\s+(?:now\s+)?(?:active|in\s+place|in\s+effect)\b|\bnow\s+(?:blocks|prevents|enforces)\b/i,
  fixed: /\b(?:has|have|had|was|were|been|is|are)\s+(?:been\s+)?(?:now\s+)?(?:fixed|resolved|remediated|patched|mitigated)\b/i,
};
/** Applied-claims only count when they are about a remediation (a deny rule that existed during the run is policy, not an action). */
const REMEDIATION_SUBJECT = /\b(?:safeguards?|fix(?:es)?|patch|remediation|hooks?|instructions?|CLAUDE\.md|regression\s+tests?|permission\s+rules?|guardrails?|change)\b/i;
/** Negated, hedged, conditional or recommended statements are not claims that something happened. */
const HEDGE =
  /\b(?:not|never|no|none|nothing|cannot|unverified|untested|unapplied|yet|pending|whether|if|until|once|would|should|could|might|may|must|can|need|needs|recommend\w*|propos\w*|consider|unless|suggest\w*|plan(?:ned)?|intended|without|unknown|unclear)\b|n't\b|\bto\s+be\b/i;

const CLAIM_REASON: Record<ActionClaimKind, string> = {
  verified: "No Underwatch record in the evidence sent shows a passed verification; treat this as unconfirmed.",
  tested: "No Underwatch record in the evidence sent shows that a test or verification run was carried out.",
  applied: "No Underwatch record in the evidence sent shows that a safeguard or change was applied.",
  fixed: "No Underwatch record in the evidence sent shows that this was fixed or resolved.",
};

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** Flags AI sentences that assert an action happened without a confirming record. App-side, deterministic, conservative. */
export function flagUnconfirmedActionClaims(answer: Pick<AskWitnessAnswer, "summary" | "verified_facts" | "hypotheses">, records: ActionRecordStatus): ActionClaimFlag[] {
  const out: ActionClaimFlag[] = [];
  const scan = (text: string, location: ActionClaimFlag["location"]) => {
    for (const s of sentences(text)) {
      if (HEDGE.test(s)) continue;
      for (const kind of ActionClaimKind.options) {
        if (!ACTION_PATTERNS[kind].test(s)) continue;
        if (kind === "applied" && !REMEDIATION_SUBJECT.test(s)) continue;
        if (records[kind].length > 0) continue;
        out.push({ location, claim: kind, text: s.length > 400 ? `${s.slice(0, 400)}…` : s, reason: CLAIM_REASON[kind] });
        break;
      }
    }
  };
  scan(answer.summary, "summary");
  for (const f of answer.verified_facts) scan(f.text, "verified_fact");
  for (const h of answer.hypotheses) scan(h.text, "hypothesis");
  return out;
}
