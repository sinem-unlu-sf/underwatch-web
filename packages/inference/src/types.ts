import type { AskWitnessModelOutput } from "@kw/schema";
import type { AskWitnessCallOptions, AskWitnessHistoryEntry } from "./askwitness";
import type { EvidenceBundle } from "./bundle";
import type { CheckedExplanation, CheckedSafeguardProposal } from "./citations";
import type { PromptTemplate } from "./prompts";

/** Metadata recorded on EVERY result (ok or not) for reproducibility (PRD FR-7). Never contains secrets or bodies. */
export interface InferenceMeta {
  provider: string;
  /** Model id that was requested. */
  model: string;
  /** Model the provider says served the request (ai&: X-Model header). Provider-reported, not independently verified. */
  served_model: string | null;
  prompt_version: string;
  schema_version: string;
  /** sha256 of the canonical redacted bundle, or null when no bundle was involved (health). */
  bundle_sha256: string | null;
  cache_key: string | null;
  cache_hit: boolean;
  /** HTTP attempts made (0 for cache hits / not configured). */
  attempts: number;
  repair_attempted: boolean;
  structured_mode: "json_schema" | "json_object" | "prompt_only" | null;
  /** reasoning_effort that was requested (null = not sent; the model's own default applied). Part of the cache key. */
  reasoning_effort: string | null;
  /** Effort the provider says it applied (ai&: X-Reasoning-Effort header). Provider-reported; null when absent. */
  applied_reasoning_effort: string | null;
  request_id: string | null;
  finish_reason: string | null;
  usage: { input_tokens: number | null; output_tokens: number | null; reasoning_tokens: number | null; cached_tokens: number | null } | null;
  latency_ms: number;
  created_at: string;
}

export type UnavailableReason =
  | "not_configured"
  | "not_verified"
  | "transport_unreachable"
  | "auth_failed"
  | "insufficient_credits"
  | "model_not_found"
  | "forbidden"
  | "redaction_guard_tripped"
  | "provider_error"
  /** The configured ai& endpoint failed the HTTPS/host policy (or TLS verification is disabled); nothing was sent. */
  | "endpoint_rejected";

export type InferenceResult<T> =
  | { status: "ok"; value: T; meta: InferenceMeta }
  | { status: "unavailable"; reason: UnavailableReason; detail: string; meta: InferenceMeta }
  | { status: "rate_limited"; retry_after_ms: number | null; policy: string | null; detail: string; meta: InferenceMeta }
  | { status: "timeout"; detail: string; meta: InferenceMeta }
  | { status: "invalid_output"; errors: string[]; detail: string; meta: InferenceMeta }
  | { status: "error"; detail: string; http_status: number | null; meta: InferenceMeta };

export type InferenceStatus = InferenceResult<unknown>["status"];

export interface HealthInfo {
  reachable: boolean;
  /** Whether the configured model id appears in the provider's catalog (null when not checked). */
  model_listed: boolean | null;
  /** How far the integration has been verified: from docs only, or exercised end-to-end. */
  verification: "doc_verified" | "exercised" | "unverified";
  detail: string;
}

/**
 * Optional AI layer (PRD FR-7). Implementations must never throw into callers: every failure is a typed result.
 * Output is advisory data; it never changes finding status or evidence.
 */
export interface InferenceProvider {
  readonly id: string;
  readonly model: string;
  explainFinding(bundle: EvidenceBundle, opts?: CallOptions): Promise<InferenceResult<CheckedExplanation>>;
  proposeSafeguard(bundle: EvidenceBundle, opts?: CallOptions): Promise<InferenceResult<CheckedSafeguardProposal>>;
  health(opts?: CallOptions): Promise<InferenceResult<HealthInfo>>;
  /**
   * Ask Witness: one question about one finding's bundle, with truncated prior turns of the same investigation.
   * Returns shape-validated model output only; the caller assigns evidence labels (checkAskWitnessOutput).
   */
  askWitness(question: string, bundle: EvidenceBundle, history: readonly AskWitnessHistoryEntry[], opts?: AskWitnessCallOptions): Promise<InferenceResult<AskWitnessModelOutput>>;
  /** Generic structured call for app-defined prompt templates (see AiAndProvider.runTemplate). */
  runTemplate<T>(tpl: PromptTemplate, bundle: EvidenceBundle, validate: TemplateValidator<T>, opts?: TemplateCallOptions): Promise<InferenceResult<T>>;
}

/** Validates parsed model JSON; errors are fed back to the model once (repair pass), then surface as invalid_output. */
export type TemplateValidator<T> = (raw: unknown) => { ok: true; value: T } | { ok: false; errors: string[] };

export interface TemplateCallOptions extends CallOptions {
  /** Digest of every non-bundle input the template closes over (question, history...). Part of the cache key. */
  cacheVariant?: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Skip cache read (a fresh result is still written). */
  bypassCache?: boolean;
}

export function emptyMeta(partial: Partial<InferenceMeta> & Pick<InferenceMeta, "provider" | "model" | "prompt_version" | "schema_version">): InferenceMeta {
  return {
    served_model: null,
    bundle_sha256: null,
    cache_key: null,
    cache_hit: false,
    attempts: 0,
    repair_attempted: false,
    structured_mode: null,
    reasoning_effort: null,
    applied_reasoning_effort: null,
    request_id: null,
    finish_reason: null,
    usage: null,
    latency_ms: 0,
    created_at: new Date().toISOString(),
    ...partial,
  };
}
