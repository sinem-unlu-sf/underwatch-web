import { createHash, randomUUID } from "node:crypto";
import { ASK_WITNESS_PROMPT_VERSION, ASK_WITNESS_SCOPED_PROMPT_VERSION, type AskWitnessHistoryEntry, type InferenceResult } from "@kw/inference";
import { safeRedact } from "@kw/redaction";
import {
  actionRecordsFromItems,
  checkAskWitnessOutput,
  flagUnconfirmedActionClaims,
  type ActionClaimFlag,
  type AskWitnessAnswer,
  type AskWitnessBody,
  type AskWitnessModelOutput,
  type AskWitnessResponse,
  type BundleEvidenceRef,
  type FindingInvestigationsResponse,
  type Investigation,
  type InvestigationDetailResponse,
  type InvestigationTurn,
} from "@kw/schema";
import type { ServerContext } from "../context";
import { transaction } from "../db/connection";
import { processRedactionOptions } from "../ingest/sanitize";
import { ApiHttpError, notFound } from "../errors";
import { getFindingBrief } from "../findings-brief/brief";
import { requireFinding } from "../repo/findings";
import { requireRun } from "../repo/runs";
import { forRun, forWorkspace, type ScopedBundleResult } from "../services/scope-retriever";
import type { EvidenceBundleResult, InvestigationService } from "../services/types";
import {
  getInvestigation,
  getTurnByRequestId,
  insertInvestigation,
  insertTurn,
  listInvestigations,
  listScopedInvestigations,
  listTurns,
  publicTurn,
  touchInvestigation,
  type TurnRecord,
} from "./store";

/**
 * sha256(finding US investigation-or-empty US question [US depth US style]): same client_request_id + different request
 * => 409. The mode suffix is added only for non-default depth/style so fingerprints of v2 requests are unchanged.
 */
export function requestFingerprint(findingId: string, investigationId: string | undefined, question: string, mode?: Pick<AskWitnessBody, "depth" | "style">): string {
  const depth = mode?.depth ?? "concise";
  const style = mode?.style ?? "standard";
  const suffix = depth === "concise" && style === "standard" ? "" : `\u001f${depth}\u001f${style}`;
  return createHash("sha256").update(`${findingId}\u001f${investigationId ?? ""}\u001f${question}${suffix}`, "utf8").digest("hex");
}

/**
 * Addendum C: the finding's deterministic brief (GET /api/findings/:id `brief`), projected to what helps phrasing and
 * redacted string by string before it can reach ai&. It is a presentation of the same records, not evidence; the
 * prompt marks it non-citable. Any failure means no brief (the bundle alone is sent), never a failed question.
 */
export function briefForPrompt(ctx: ServerContext, findingId: string): Record<string, unknown> | null {
  try {
    const b = getFindingBrief(ctx.db, findingId);
    const opts = processRedactionOptions(ctx.env);
    const clean = (v: unknown): unknown =>
      typeof v === "string" ? safeRedact(v, opts).text : Array.isArray(v) ? v.map(clean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) : v;
    return clean({
      brief_version: b.brief_version,
      is_fixture: b.is_fixture,
      problem: b.problem,
      why_it_matters: b.why_it_matters,
      terms: b.terms,
      how_to_fix: b.how_to_fix.map((a) => ({ text: a.text, mechanism: a.mechanism, enforces: a.enforces, mechanism_limit: a.mechanism_limit, status: a.status, status_label: a.status_label, status_basis: a.status_basis })),
      evidence_summary: { text: b.evidence_summary.text, coverage_level: b.evidence_summary.coverage_level, coverage_caveats: b.evidence_summary.coverage_caveats },
      uncertainty: b.uncertainty,
    }) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Addendum C: requested answer mode (defaults concise / standard). */
function answerMode(body: AskWitnessBody): { depth: NonNullable<AskWitnessBody["depth"]>; style: NonNullable<AskWitnessBody["style"]> } {
  return { depth: body.depth ?? "concise", style: body.style ?? "standard" };
}

/**
 * Addendum C: flags AI sentences that claim an action was performed / applied / tested / verified / fixed while no
 * record in the bundle that was sent confirms it, and adds an app-written limitation line. Deterministic.
 */
export function withActionClaimCheck(answer: AskWitnessAnswer, items: Parameters<typeof actionRecordsFromItems>[0]): AskWitnessAnswer {
  const flags: ActionClaimFlag[] = flagUnconfirmedActionClaims(answer, actionRecordsFromItems(items));
  const limitations = [...(answer.evidence_limitations ?? [])];
  if (flags.length > 0) {
    limitations.push(
      `${flags.length} AI statement(s) say an action was performed, applied, tested, verified or fixed, but no Underwatch record in the evidence sent confirms it; they are flagged as unconfirmed.`,
    );
  }
  return { ...answer, evidence_limitations: limitations, action_claim_flags: flags };
}

type Failure = Exclude<InferenceResult<AskWitnessModelOutput>, { status: "ok" }>;

/**
 * Safe, fixed error messages. Never include provider bodies, prompts, keys or evidence text. Only enum values and
 * numbers reach the client.
 */
export function failureToTurn(r: Failure): Pick<InvestigationTurn, "status" | "error"> {
  const unchanged = "The finding and its evidence are unchanged.";
  switch (r.status) {
    case "unavailable":
      if (r.reason === "not_configured") {
        return { status: "ai_unavailable", error: { code: "not_configured", message: `ai& is not configured on this server, so Ask Witness cannot answer. ${unchanged} You can still inspect the evidence directly.` } };
      }
      return {
        status: "ai_unavailable",
        error: {
          code: "unavailable",
          message:
            r.reason === "redaction_guard_tripped"
              ? `The request was blocked before sending because it looked like it contained a secret. ${unchanged}`
              : `ai& is unavailable (${r.reason}). ${unchanged} Try again later.`,
        },
      };
    case "rate_limited":
      return {
        status: "ai_unavailable",
        error: { code: "rate_limited", message: `ai& rate limit reached${r.retry_after_ms !== null ? `; retry in about ${Math.ceil(r.retry_after_ms / 1000)} s` : ""}. ${unchanged}` },
      };
    case "timeout":
      return { status: "ai_error", error: { code: "timeout", message: `ai& did not answer in time. ${unchanged} Try again.` } };
    case "invalid_output":
      return {
        status: "invalid_output",
        error: { code: "invalid_output", message: `The AI response did not match the required structure after one repair attempt, so it is not shown. ${unchanged}` },
      };
    case "error":
      return { status: "ai_error", error: { code: "provider_error", message: `ai& request failed${r.http_status !== null ? ` (HTTP ${r.http_status})` : ""}. ${unchanged}` } };
  }
}

/**
 * Application-generated limitations of the bundle that was actually sent (never written by the model). They make the
 * uncertainty explicit even when the model sounds confident.
 */
export function evidenceLimitations(ev: EvidenceBundleResult, answer: AskWitnessAnswer, modelSaidInsufficient: boolean): string[] {
  const out: string[] = [];
  const bases = [...ev.bases.values()];
  const cov = ev.bundle.items.find((i) => i.kind === "coverage");
  if (!bases.includes("observed")) {
    out.push("The evidence sent contains no independently observed events or records for this finding; statements about what actually happened rest on agent reports or Underwatch analysis only.");
  }
  if (cov) {
    const level = String(cov.fields.coverage_level);
    if (level !== "complete") out.push(`Observation coverage for this run is "${level}", so missing observed events do not prove that an action did not happen.`);
    const gaps = cov.fields.category_gaps;
    if (Array.isArray(gaps) && gaps.length > 0) out.push(`Coverage gaps recorded for this run: ${gaps.join("; ")}.`);
    const targets = cov.fields.finding_targets;
    if (Number(cov.fields.observed_events_on_targets_in_run) === 0 && Array.isArray(targets) && targets.length > 0) {
      out.push("No observed event in this run touches the finding's target resource(s); an absence is only meaningful for categories the active observers cover.");
    }
  }
  const om = ev.bundle.omitted;
  if (om.events + om.evidence > 0) out.push(`${om.events} event(s) and ${om.evidence} evidence record(s) were left out by the bundle size cap.`);
  if (om.not_provided > 0) out.push(`${om.not_provided} record(s) referenced by the finding were not available to send.`);
  const dropped = ev.bundle.items.filter((i) => i.content_omitted === "size_budget").length;
  if (dropped > 0) out.push(`${dropped} item(s) were sent without their captured text (size budget).`);
  if (answer.evidence_check.invalid > 0) {
    out.push(`The AI cited ${answer.evidence_check.invalid} id(s) that were not in the evidence sent; they are flagged as invalid and support nothing.`);
  }
  if (answer.unsupported_claims.length > 0) out.push(`${answer.unsupported_claims.length} statement(s) the AI presented as facts had no valid citation and were moved to unsupported claims.`);
  if (answer.insufficient_evidence && !modelSaidInsufficient) {
    out.push("Underwatch marked this answer as insufficient: no stated fact is backed by a valid citation to observed or agent-reported evidence.");
  }
  return out;
}

/** App-generated limitations for run / workspace bundles (never written by the model). */
export function scopedLimitations(ev: ScopedBundleResult, answer: AskWitnessAnswer, modelSaidInsufficient: boolean): string[] {
  const out: string[] = [];
  const bases = [...ev.bases.values()];
  out.push(
    ev.scope.kind === "workspace"
      ? `This answer used a capped selection of ${ev.bundle.items.length} Underwatch record(s) chosen deterministically from the question${ev.selection.matched_terms.length > 0 ? ` (matched: ${ev.selection.matched_terms.join(", ")})` : " (no matching terms; newest open findings were used)"}, not every record.`
      : `This answer used a capped selection of ${ev.bundle.items.length} record(s) from this run, not its full event log.`,
  );
  if (!bases.includes("observed")) out.push("The records sent contain no independently observed events; statements about what actually happened rest on agent reports or Underwatch analysis only.");
  const weak = ev.coverage_levels.filter((l) => l !== "complete");
  if (weak.length > 0) out.push(`Observation coverage is not complete (${[...new Set(weak)].join(", ")}), so missing observed events do not prove that an action did not happen.`);
  const om = ev.bundle.omitted;
  if (om.events + om.evidence > 0) out.push(`${om.events + om.evidence} record(s) were left out by the bundle size cap.`);
  const dropped = ev.bundle.items.filter((i) => i.content_omitted === "size_budget").length;
  if (dropped > 0) out.push(`${dropped} item(s) were sent without their captured text (size budget).`);
  if (answer.evidence_check.invalid > 0) out.push(`The AI cited ${answer.evidence_check.invalid} id(s) that were not in the records sent; they are flagged as invalid and support nothing.`);
  if (answer.unsupported_claims.length > 0) out.push(`${answer.unsupported_claims.length} statement(s) the AI presented as facts had no valid citation and were moved to unsupported claims.`);
  if (answer.insufficient_evidence && !modelSaidInsufficient) {
    out.push("Underwatch marked this answer as insufficient: no stated fact is backed by a valid citation to observed or agent-reported evidence (Underwatch analysis alone does not establish what happened).");
  }
  return out;
}

type ScopeRef = { kind: "run"; id: string } | { kind: "workspace"; id: null };

function scopeKey(scope: ScopeRef): string {
  return scope.kind === "run" ? `run:${scope.id}` : "workspace";
}

function dedupeRefs(refs: BundleEvidenceRef[]): BundleEvidenceRef[] {
  const m = new Map<string, BundleEvidenceRef>();
  for (const r of refs) if (!m.has(r.evidence_id)) m.set(r.evidence_id, r);
  return [...m.values()];
}

function aiStatus(ctx: ServerContext): InvestigationDetailResponse["ai"] {
  return ctx.inference.id === "null"
    ? { available: false, detail: "ai& is not configured; Ask Witness cannot answer. Findings and evidence remain fully usable." }
    : { available: true, detail: `ai& configured (model ${ctx.inference.model}); availability is checked on each request.` };
}

const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

export function createInvestigationService(ctx: ServerContext): InvestigationService {
  /** Concurrent identical requests in this process share one AI call. */
  const inflight = new Map<string, Promise<AskWitnessResponse>>();

  function replay(existing: TurnRecord, fingerprint: string): AskWitnessResponse {
    if (existing.request_fingerprint !== fingerprint) {
      throw new ApiHttpError("conflict", "This client_request_id was already used for a different question; generate a new id for a new question.");
    }
    const investigation = getInvestigation(ctx.db, existing.investigation_id);
    if (!investigation) throw new Error("turn without investigation");
    return { investigation, turn: publicTurn(existing), evidence_index: existing.evidence_index, replayed: true };
  }

  async function answer(findingId: string, body: AskWitnessBody, fingerprint: string): Promise<AskWitnessResponse> {
    const finding = requireFinding(ctx.db, findingId);
    let investigation: Investigation | null = null;
    if (body.investigation_id) {
      investigation = getInvestigation(ctx.db, body.investigation_id);
      if (!investigation || investigation.scope_kind !== "finding" || investigation.finding_id !== findingId) throw notFound("Investigation", body.investigation_id);
    }
    // Follow-ups reuse the finding's scope: retrieval is always for this finding only; prior turns are context, not evidence.
    const history: AskWitnessHistoryEntry[] = investigation
      ? listTurns(ctx.db, investigation.id).map((t) => ({ question: t.question, answer_summary: t.answer?.summary ?? null, status: t.status }))
      : [];
    // The question is untrusted free text: redact it before it is sent to ai& or stored (ISSUE 3, fail closed). The
    // fingerprint above still covers the original text so an identical retry replays.
    const question = safeRedact(body.question, {
      ...processRedactionOptions(ctx.env),
      onFailure: ({ error }) => console.error(`[kw] redaction failed for an Ask Witness question (${error}); stored [REDACTION_FAILED]`),
    }).text;
    const ev = await ctx.services.evidence.forFinding(findingId, question);
    const mode = answerMode(body);

    let result: InferenceResult<AskWitnessModelOutput>;
    try {
      result = await ctx.inference.askWitness(question, ev.bundle, history, { ...mode, brief: briefForPrompt(ctx, findingId) });
    } catch {
      result = { status: "error", http_status: null, detail: "provider threw", meta: { provider: ctx.inference.id, model: ctx.inference.model } as never };
    }

    let status: InvestigationTurn["status"];
    let answerValue: AskWitnessAnswer | null = null;
    let error: InvestigationTurn["error"] = null;
    if (result.status === "ok") {
      const checked = checkAskWitnessOutput(result.value, ev.bases);
      answerValue = withActionClaimCheck({ ...checked, evidence_limitations: evidenceLimitations(ev, checked, result.value.insufficient_evidence) }, ev.bundle.items);
      status = answerValue.insufficient_evidence ? "insufficient_evidence" : "answered";
    } else {
      ({ status, error } = failureToTurn(result));
    }

    const at = ctx.now().toISOString();
    const meta = result.meta as Partial<typeof result.meta> | undefined;
    const turn: TurnRecord = {
      id: `itn_${randomUUID()}`,
      investigation_id: investigation?.id ?? `inv_${randomUUID()}`,
      client_request_id: body.client_request_id,
      request_fingerprint: fingerprint,
      question,
      evidence_ids: [...ev.bundle.allowed_ids],
      bundle_hash: ev.bundle.sha256,
      model: meta?.model ?? ctx.inference.model,
      prompt_version: meta?.prompt_version ?? ASK_WITNESS_PROMPT_VERSION,
      status,
      answer: answerValue,
      error,
      evidence_index: ev.refs,
      created_at: at,
      depth: mode.depth,
      style: mode.style,
    };
    try {
      const inv = transaction(ctx.db, () => {
        const already = getTurnByRequestId(ctx.db, body.client_request_id);
        if (already) return null; // lost a race with another writer: replay theirs below
        let current = investigation;
        if (!current) {
          current = { id: turn.investigation_id, scope_kind: "finding", scope_id: finding.id, finding_id: finding.id, run_id: finding.run_id, status: "active", created_at: at, updated_at: at };
          insertInvestigation(ctx.db, current);
        } else {
          touchInvestigation(ctx.db, current.id, at);
          current = { ...current, updated_at: at };
        }
        // retrieval: graph traversal vs relational fallback (and why), kept with the turn for audit.
        insertTurn(ctx.db, turn, { ...(meta ?? {}), retrieval: ev.retrieval, answer_mode: mode });
        return current;
      });
      if (inv) return { investigation: inv, turn: publicTurn(turn), evidence_index: turn.evidence_index, replayed: false };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    const existing = getTurnByRequestId(ctx.db, body.client_request_id);
    if (!existing) throw new Error("turn insert failed");
    return replay(existing, fingerprint);
  }

  /** Run / workspace scope: same rules as finding scope (redacted question, sealed capped bundle, app-side labels). */
  async function answerScoped(scope: ScopeRef, body: AskWitnessBody, fingerprint: string): Promise<AskWitnessResponse> {
    if (scope.kind === "run") requireRun(ctx.db, scope.id);
    let investigation: Investigation | null = null;
    if (body.investigation_id) {
      investigation = getInvestigation(ctx.db, body.investigation_id);
      // Follow-ups stay in the same scope.
      if (!investigation || investigation.scope_kind !== scope.kind || (scope.kind === "run" && investigation.scope_id !== scope.id)) {
        throw notFound("Investigation", body.investigation_id);
      }
    }
    const history: AskWitnessHistoryEntry[] = investigation
      ? listTurns(ctx.db, investigation.id).map((t) => ({ question: t.question, answer_summary: t.answer?.summary ?? null, status: t.status }))
      : [];
    const question = safeRedact(body.question, {
      ...processRedactionOptions(ctx.env),
      onFailure: ({ error }) => console.error(`[kw] redaction failed for an Ask Witness question (${error}); stored [REDACTION_FAILED]`),
    }).text;
    const ev = scope.kind === "run" ? forRun(ctx, scope.id) : forWorkspace(ctx, question);
    const mode = answerMode(body);

    let result: InferenceResult<AskWitnessModelOutput>;
    try {
      result = await ctx.inference.askWitness(question, ev.bundle, history, mode);
    } catch {
      result = { status: "error", http_status: null, detail: "provider threw", meta: { provider: ctx.inference.id, model: ctx.inference.model } as never };
    }
    let status: InvestigationTurn["status"];
    let answerValue: AskWitnessAnswer | null = null;
    let error: InvestigationTurn["error"] = null;
    if (result.status === "ok") {
      const checked = checkAskWitnessOutput(result.value, ev.bases);
      answerValue = withActionClaimCheck({ ...checked, evidence_limitations: scopedLimitations(ev, checked, result.value.insufficient_evidence) }, ev.bundle.items);
      status = answerValue.insufficient_evidence ? "insufficient_evidence" : "answered";
    } else {
      ({ status, error } = failureToTurn(result));
      if (error) error = { ...error, message: error.message.replace("The finding and its evidence are unchanged.", "Underwatch records are unchanged.") };
    }
    const at = ctx.now().toISOString();
    const meta = result.meta as Partial<typeof result.meta> | undefined;
    const turn: TurnRecord = {
      id: `itn_${randomUUID()}`,
      investigation_id: investigation?.id ?? `inv_${randomUUID()}`,
      client_request_id: body.client_request_id,
      request_fingerprint: fingerprint,
      question,
      evidence_ids: [...ev.bundle.allowed_ids],
      bundle_hash: ev.bundle.sha256,
      model: meta?.model ?? ctx.inference.model,
      prompt_version: meta?.prompt_version ?? ASK_WITNESS_SCOPED_PROMPT_VERSION,
      status,
      answer: answerValue,
      error,
      evidence_index: ev.refs,
      created_at: at,
      depth: mode.depth,
      style: mode.style,
    };
    try {
      const inv = transaction(ctx.db, () => {
        if (getTurnByRequestId(ctx.db, body.client_request_id)) return null;
        let current = investigation;
        if (!current) {
          current = {
            id: turn.investigation_id,
            scope_kind: scope.kind,
            scope_id: scope.id,
            finding_id: null,
            run_id: scope.kind === "run" ? scope.id : null,
            status: "active",
            created_at: at,
            updated_at: at,
          };
          insertInvestigation(ctx.db, current);
        } else {
          touchInvestigation(ctx.db, current.id, at);
          current = { ...current, updated_at: at };
        }
        insertTurn(ctx.db, turn, { ...(meta ?? {}), retrieval: { retriever: "scoped", scope: { kind: scope.kind, id: scope.id }, selection: ev.selection }, answer_mode: mode });
        return current;
      });
      if (inv) return { investigation: inv, turn: publicTurn(turn), evidence_index: turn.evidence_index, replayed: false };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
    const existing = getTurnByRequestId(ctx.db, body.client_request_id);
    if (!existing) throw new Error("turn insert failed");
    return replay(existing, fingerprint);
  }

  /** Idempotency on client_request_id (stored replay, in-process de-duplication of concurrent identical requests). */
  async function idempotent(body: AskWitnessBody, fingerprint: string, run: () => Promise<AskWitnessResponse>): Promise<AskWitnessResponse> {
    const existing = getTurnByRequestId(ctx.db, body.client_request_id);
    if (existing) return replay(existing, fingerprint);
    const pending = inflight.get(body.client_request_id);
    if (pending) {
      const r = await pending;
      const turn = getTurnByRequestId(ctx.db, body.client_request_id);
      if (turn) return replay(turn, fingerprint);
      return { ...r, replayed: true };
    }
    const p = run();
    inflight.set(body.client_request_id, p);
    try {
      return await p;
    } finally {
      inflight.delete(body.client_request_id);
    }
  }

  return {
    async askRun(runId, body, _actor) {
      const scope: ScopeRef = { kind: "run", id: runId };
      const fingerprint = requestFingerprint(scopeKey(scope), body.investigation_id, body.question, body);
      return idempotent(body, fingerprint, () => answerScoped(scope, body, fingerprint));
    },

    async askWorkspace(body, _actor) {
      const scope: ScopeRef = { kind: "workspace", id: null };
      const fingerprint = requestFingerprint(scopeKey(scope), body.investigation_id, body.question, body);
      return idempotent(body, fingerprint, () => answerScoped(scope, body, fingerprint));
    },

    async listForRun(runId): Promise<FindingInvestigationsResponse> {
      requireRun(ctx.db, runId);
      return { items: listScopedInvestigations(ctx.db, "run", runId) };
    },

    async listWorkspace(): Promise<FindingInvestigationsResponse> {
      return { items: listScopedInvestigations(ctx.db, "workspace", null) };
    },

    async ask(findingId, body, _actor) {
      const fingerprint = requestFingerprint(findingId, body.investigation_id, body.question, body);
      const existing = getTurnByRequestId(ctx.db, body.client_request_id);
      if (existing) return replay(existing, fingerprint);
      const pending = inflight.get(body.client_request_id);
      if (pending) {
        const r = await pending;
        const turn = getTurnByRequestId(ctx.db, body.client_request_id);
        if (turn) return replay(turn, fingerprint);
        return { ...r, replayed: true };
      }
      const p = answer(findingId, body, fingerprint);
      inflight.set(body.client_request_id, p);
      try {
        return await p;
      } finally {
        inflight.delete(body.client_request_id);
      }
    },

    async listForFinding(findingId): Promise<FindingInvestigationsResponse> {
      requireFinding(ctx.db, findingId);
      return { items: listInvestigations(ctx.db, findingId) };
    },

    async get(investigationId): Promise<InvestigationDetailResponse> {
      const investigation = getInvestigation(ctx.db, investigationId);
      if (!investigation) throw notFound("Investigation", investigationId);
      const turns = listTurns(ctx.db, investigationId);
      if (investigation.scope_kind !== "finding" || investigation.finding_id === null) {
        const run = investigation.scope_kind === "run" && investigation.run_id ? requireRun(ctx.db, investigation.run_id) : null;
        return {
          investigation,
          finding: null,
          scope: { kind: investigation.scope_kind, id: investigation.scope_id, label: run ? (run.label ?? run.id) : "All Underwatch records" },
          turns: turns.map(publicTurn),
          evidence_index: dedupeRefs(turns.flatMap((t) => t.evidence_index)),
          ai: aiStatus(ctx),
        };
      }
      const finding = requireFinding(ctx.db, investigation.finding_id);
      return {
        investigation,
        scope: { kind: "finding", id: finding.id, label: finding.title },
        finding: { id: finding.id, title: finding.title, severity: finding.severity, run_id: finding.run_id, is_fixture: finding.is_fixture },
        turns: turns.map(publicTurn),
        evidence_index: dedupeRefs(turns.flatMap((t) => t.evidence_index)),
        ai: aiStatus(ctx),
      };
    },
  };
}
