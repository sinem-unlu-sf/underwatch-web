import { redact, scanForLeaks } from "@kw/redaction";
import type { AskWitnessModelOutput } from "@kw/schema";
import { askWitnessCacheVariant, askWitnessTemplate, type AskWitnessCallOptions, type AskWitnessHistoryEntry, validateAskWitnessOutput } from "../askwitness";
import { type EvidenceBundle, verifyBundleHash } from "../bundle";
import { createCache, inferenceCacheKey, type InferenceCache } from "../cache";
import { checkExplanationCitations, checkSafeguardCitations, type CheckedExplanation, type CheckedSafeguardProposal } from "../citations";
import { type ChatMessage, EXPLAIN_FINDING_V1, PROPOSE_SAFEGUARD_V1, type PromptTemplate, repairMessage } from "../prompts";
import { Explanation, parseJsonLoose, SafeguardProposal, zodErrors } from "../schemas";
import { createAiAndHttpsTransport, EndpointPolicyError, guardAiAndTransport, tlsVerificationProblem, validateAiAndEndpoint } from "../endpoint-policy";
import { type HttpResponse, type HttpTransport, parseRetryAfter, requestWithTimeout, TimeoutError } from "../transport";
import { type CallOptions, emptyMeta, type HealthInfo, type InferenceMeta, type InferenceProvider, type InferenceResult, type TemplateCallOptions, type TemplateValidator } from "../types";

/**
 * ai& Inference API surface, as verified from primary documentation on 2026-10-17 (research report facts ai-and-03/04/
 * 05/07/10/11/14/18/20, all "confirmed" by the fact-check pass; live re-fetch of llms-full.txt, /v1/models and
 * openapi.json byte-identical to the research evidence).
 *
 * EXERCISED 2026-10-17 (~10:50 JST) by `pnpm --filter @kw/inference smoke` with the user's key: GET /v1/models listed
 * 13 models including the default; POST /v1/chat/completions with deepseek-ai/deepseek-v4-flash, reasoning_effort
 * "none" and response_format json_schema (strict) returned 200 with schema-valid JSON on the first attempt (2 calls).
 * UNVERIFIED: that strict json_schema is actually ENFORCED (vs. followed) by this or any other model (docs: "depends on
 * the model"; tool-calling models "generally" handle it) - output is therefore always validated locally.
 * UNVERIFIED: every model other than deepseek-ai/deepseek-v4-flash.
 * UNVERIFIED: the server-side request timeout (undocumented); the client uses its own deadline.
 * The keyed /v1/models list for the user's key contained the default model on 2026-10-17; catalogs are per org/tier, so
 * health() re-checks it at runtime rather than assuming it.
 * NOTE: ai& documents prompt caching as a billing discount on a repeated prefix, not as a latency guarantee.
 */
export const AIAND_API_SURFACE = {
  base_url: "https://api.aiand.com/v1",
  chat_completions_path: "/chat/completions",
  models_path: "/models",
  auth_header: "Authorization: Bearer <key>",
  key_env_var: "AIAND_API_KEY",
  /** docs examples + cheapest output price in the keyless catalog; lists reasoning_effort "none". */
  default_model: "deepseek-ai/deepseek-v4-flash",
  default_reasoning_effort: "none",
  verification: "exercised" as "doc_verified" | "exercised" | "unverified",
  sources: [
    "https://docs.aiand.com/getting-started/",
    "https://docs.aiand.com/authentication/",
    "https://docs.aiand.com/api/chat-completions/",
    "https://docs.aiand.com/capabilities/structured-outputs/",
    "https://docs.aiand.com/reference/rate-limits/",
    "https://docs.aiand.com/errors/",
    "https://api.aiand.com/openapi.json",
  ],
} as const;

export type StructuredMode = "json_schema" | "json_object" | "prompt_only";

export interface AiAndConfig {
  /** Held privately by the provider; never logged, returned, or written to cache. */
  apiKey: string | null;
  baseUrl: string;
  model: string;
  /** Sent as reasoning_effort when non-null. Must be one of the model's catalog `reasoning_efforts`. */
  reasoningEffort: string | null;
  structuredOutput: StructuredMode;
  maxCompletionTokens: number;
  temperature: number;
  timeoutMs: number;
  /** Retries after the first attempt for 429 (time-based) / 5xx / network errors. */
  maxRetries: number;
  /**
   * Whether a client-side timeout is retried. Default false: a request that already ran for `timeoutMs` is unlikely to
   * finish on an identical retry, each retry can multiply the wait (3 x 60 s per pass), and whether an aborted request
   * is still billed is undocumented.
   */
  retryOnTimeout: boolean;
  /** A 429 whose Retry-After exceeds this is returned as rate_limited instead of waited out. */
  maxRetryWaitMs: number;
  baseBackoffMs: number;
  /** Where the key came from (name/path only, never the value). */
  configuredVia: string | null;
  /** Optional on-disk cache directory (JSON files). */
  cacheDir: string | null;
}

export const DEFAULT_AIAND_CONFIG: Omit<AiAndConfig, "apiKey" | "configuredVia"> = {
  baseUrl: AIAND_API_SURFACE.base_url,
  model: AIAND_API_SURFACE.default_model,
  reasoningEffort: AIAND_API_SURFACE.default_reasoning_effort,
  structuredOutput: "json_schema",
  maxCompletionTokens: 3000,
  temperature: 0,
  timeoutMs: 60_000,
  maxRetries: 2,
  retryOnTimeout: false,
  maxRetryWaitMs: 30_000,
  baseBackoffMs: 1_000,
  cacheDir: null,
};

export interface AiAndDeps {
  transport?: HttpTransport;
  cache?: InferenceCache;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /**
   * Env consulted by the endpoint policy at construction AND before every request (NODE_ENV,
   * KW_ALLOW_INSECURE_AIAND_HTTP, KW_AIAND_ALLOWED_HOSTS). Default: the live process.env. NODE_TLS_REJECT_UNAUTHORIZED is
   * always also checked on the real process.env.
   */
  policyEnv?: () => NodeJS.ProcessEnv;
}

type ChatOk = {
  kind: "ok";
  applied_reasoning_effort: string | null;
  content: string | null;
  refusal: string | null;
  finish_reason: string | null;
  served_model: string | null;
  request_id: string | null;
  usage: InferenceMeta["usage"];
};
type FailureResult = Exclude<InferenceResult<never>, { status: "ok" }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Terminal = { kind: "terminal"; result: DistributiveOmit<FailureResult, "meta"> };

const CANCELLED = "cancelled by caller";
const CONCURRENCY_POLICIES = new Set(["concurrency", "global_concurrency"]);

function safeProviderMessage(body: string): string {
  let msg = "";
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown; code?: unknown } };
    const m = typeof j.error?.message === "string" ? j.error.message : "";
    const c = typeof j.error?.code === "string" ? j.error.code : "";
    msg = [c, m].filter(Boolean).join(": ");
  } catch {
    msg = "non-JSON error body"; // e.g. a proxy (Cloudflare) page; never echo it
  }
  return redact(msg.slice(0, 300)).text;
}

function providerErrorCode(body: string): string | null {
  try {
    const j = JSON.parse(body) as { error?: { code?: unknown } };
    return typeof j.error?.code === "string" ? j.error.code : null;
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export class AiAndProvider implements InferenceProvider {
  readonly id = "aiand";
  readonly model: string;
  readonly #apiKey: string | null;
  readonly #cfg: Omit<AiAndConfig, "apiKey">;
  readonly #transport: HttpTransport;
  readonly #cache: InferenceCache;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  /** Single-flight: concurrent calls for the same cache key share one upstream request. */
  readonly #inflight = new Map<string, Promise<InferenceResult<unknown>>>();
  /** Non-null when the configured endpoint failed the policy at construction; no request is ever attempted then. */
  readonly #endpointError: string | null;

  constructor(config: Partial<AiAndConfig> & { apiKey: string | null }, deps: AiAndDeps = {}) {
    const { apiKey, ...rest } = config;
    this.#apiKey = apiKey && apiKey.trim().length > 0 ? apiKey.trim() : null;
    this.#cfg = { ...DEFAULT_AIAND_CONFIG, configuredVia: null, ...rest };
    const policyEnv = deps.policyEnv ?? (() => process.env);
    const ep = validateAiAndEndpoint(this.#cfg.baseUrl, policyEnv());
    // Never keep a rejected URL around: it may carry credentials and describe() would expose it.
    this.#endpointError = ep.ok ? tlsVerificationProblem(process.env, policyEnv()) : ep.reason;
    this.#cfg.baseUrl = ep.ok ? ep.url : "[rejected]";
    this.model = this.#cfg.model;
    // Every request (injected test transports included) is re-validated immediately before it is sent.
    this.#transport = guardAiAndTransport(deps.transport ?? createAiAndHttpsTransport(), policyEnv);
    this.#cache = deps.cache ?? createCache({ dir: this.#cfg.cacheDir });
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#random = deps.random ?? Math.random;
  }

  /** Where the key came from, as a NAME only ("AIAND_API_KEY (process env)" / "AIAND_API_KEY (.env.local)"); never the value or a path. */
  get keySource(): string | null {
    const v = this.#cfg.configuredVia;
    if (!v) return this.#apiKey ? "AIAND_API_KEY" : null;
    if (v.includes("process env")) return "AIAND_API_KEY (process env)";
    const m = /in (.+)$/.exec(v);
    return m ? `AIAND_API_KEY (${m[1]!.split(/[\\/]/).pop()})` : "AIAND_API_KEY";
  }

  /** Host of the configured endpoint (no path, no credentials), or null when the endpoint was rejected. */
  get baseHost(): string | null {
    try {
      return new URL(this.#cfg.baseUrl).host;
    } catch {
      return null;
    }
  }

  get configured(): boolean {
    return this.#apiKey !== null;
  }

  /** Safe description for status pages: never includes the key. */
  describe() {
    const { cacheDir, ...cfg } = this.#cfg;
    return { ...cfg, cache: cacheDir ? "memory+file" : "memory", api_key: this.#apiKey ? "[configured]" : null, endpoint_error: this.#endpointError, verification: AIAND_API_SURFACE.verification };
  }

  toJSON() {
    return this.describe();
  }

  explainFinding(bundle: EvidenceBundle, opts?: CallOptions): Promise<InferenceResult<CheckedExplanation>> {
    return this.#run(EXPLAIN_FINDING_V1, bundle, (raw) => {
      const p = Explanation.safeParse(raw);
      return p.success ? { ok: true, value: checkExplanationCitations(p.data, bundle) } : { ok: false, errors: zodErrors(p.error) };
    }, opts);
  }

  proposeSafeguard(bundle: EvidenceBundle, opts?: CallOptions): Promise<InferenceResult<CheckedSafeguardProposal>> {
    return this.#run(PROPOSE_SAFEGUARD_V1, bundle, (raw) => {
      const p = SafeguardProposal.safeParse(raw);
      return p.success ? { ok: true, value: checkSafeguardCitations(p.data, bundle) } : { ok: false, errors: zodErrors(p.error) };
    }, opts);
  }

  /**
   * Generic structured call for app-defined tasks (Ask Witness, safeguard proposals v2). `tpl.build` may close over
   * extra inputs (question, history, CLAUDE.md excerpt); those inputs MUST be summarised in `opts.cacheVariant`
   * (e.g. sha256 of the canonical inputs) or different questions over the same bundle would share a cache entry.
   * Same guarantees as explainFinding: never throws, bundle hash verified, output validated by `validate`.
   */
  runTemplate<T>(tpl: PromptTemplate, bundle: EvidenceBundle, validate: TemplateValidator<T>, opts?: TemplateCallOptions): Promise<InferenceResult<T>> {
    return this.#run(tpl, bundle, validate, opts, opts?.cacheVariant);
  }

  askWitness(question: string, bundle: EvidenceBundle, history: readonly AskWitnessHistoryEntry[], opts?: AskWitnessCallOptions): Promise<InferenceResult<AskWitnessModelOutput>> {
    const { depth, style, brief, ...call } = opts ?? {};
    const mode = { depth, style, brief };
    return this.runTemplate(askWitnessTemplate(question, history, bundle.scope, mode), bundle, validateAskWitnessOutput, { ...call, cacheVariant: askWitnessCacheVariant(question, history, mode) });
  }

  async health(opts: CallOptions = {}): Promise<InferenceResult<HealthInfo>> {
    const t0 = Date.now();
    const meta = (extra: Partial<InferenceMeta> = {}) =>
      emptyMeta({ provider: this.id, model: this.model, prompt_version: "health", schema_version: "health", latency_ms: Date.now() - t0, ...extra });
    try {
      if (!this.#apiKey) return { status: "unavailable", reason: "not_configured", detail: "ai& not configured", meta: meta() };
      if (this.#endpointError) return { status: "unavailable", reason: "endpoint_rejected", detail: `ai& endpoint rejected: ${this.#endpointError}`, meta: meta() };
      let res: HttpResponse;
      try {
        res = await requestWithTimeout(
          this.#transport,
          { method: "GET", url: `${this.#cfg.baseUrl}${AIAND_API_SURFACE.models_path}`, headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: "application/json" } },
          Math.min(this.#cfg.timeoutMs, 15_000),
          opts.signal,
        );
      } catch (e) {
        if (e instanceof EndpointPolicyError) return { status: "unavailable", reason: "endpoint_rejected", detail: e.message, meta: meta({ attempts: 1 }) };
        if (e instanceof TimeoutError) return { status: "timeout", detail: e.message, meta: meta({ attempts: 1 }) };
        return { status: "unavailable", reason: "transport_unreachable", detail: "could not reach ai& (network error)", meta: meta({ attempts: 1 }) };
      }
      const m = meta({ attempts: 1, request_id: res.headers["x-request-id"] ?? null });
      if (res.status === 401) return { status: "unavailable", reason: "auth_failed", detail: "ai& rejected the API key (401)", meta: m };
      if (res.status !== 200) return { status: "error", http_status: res.status, detail: `GET /models returned ${res.status}: ${safeProviderMessage(res.body)}`, meta: m };
      let ids: string[] = [];
      try {
        const j = JSON.parse(res.body) as { data?: Array<{ id?: unknown }> };
        ids = (j.data ?? []).map((d) => (typeof d.id === "string" ? d.id.toLowerCase() : "")).filter(Boolean);
      } catch {
        return { status: "error", http_status: 200, detail: "GET /models returned non-JSON", meta: m };
      }
      const listed = ids.includes(this.model.toLowerCase());
      return {
        status: "ok",
        value: {
          reachable: true,
          model_listed: listed,
          verification: AIAND_API_SURFACE.verification,
          detail: listed ? `model ${this.model} is listed for this key (${ids.length} models)` : `model ${this.model} is NOT in this key's catalog (${ids.length} models)`,
        },
        meta: m,
      };
    } catch (e) {
      return { status: "error", http_status: null, detail: `unexpected: ${e instanceof Error ? e.name : "error"}`, meta: meta() };
    }
  }

  // -----------------------------------------------------------------------------------------------------------

  async #run<T>(
    tpl: PromptTemplate,
    bundle: EvidenceBundle,
    validate: (raw: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
    opts: CallOptions = {},
    variant?: string,
  ): Promise<InferenceResult<T>> {
    const t0 = Date.now();
    const st = { attempts: 0, repair: false, mode: this.#cfg.structuredOutput as StructuredMode, cacheKey: null as string | null };
    let last: Partial<InferenceMeta> = {};
    const meta = (extra: Partial<InferenceMeta> = {}): InferenceMeta =>
      emptyMeta({
        provider: this.id,
        model: this.model,
        prompt_version: tpl.prompt_version,
        schema_version: tpl.schema_version,
        bundle_sha256: typeof bundle?.sha256 === "string" ? bundle.sha256 : null,
        cache_key: st.cacheKey,
        attempts: st.attempts,
        repair_attempted: st.repair,
        structured_mode: st.mode,
        reasoning_effort: this.#cfg.reasoningEffort,
        latency_ms: Date.now() - t0,
        ...last,
        ...extra,
      });
    try {
      if (!this.#apiKey) return { status: "unavailable", reason: "not_configured", detail: "ai& not configured", meta: meta({ structured_mode: null }) };
      if (this.#endpointError) return { status: "unavailable", reason: "endpoint_rejected", detail: `ai& endpoint rejected: ${this.#endpointError}`, meta: meta({ structured_mode: null }) };
      if (!bundle || !Array.isArray(bundle.allowed_ids) || !verifyBundleHash(bundle)) {
        return { status: "error", http_status: null, detail: "evidence bundle failed its integrity check (modified after build?)", meta: meta() };
      }
      st.cacheKey = inferenceCacheKey(
        bundle.sha256,
        tpl.prompt_version,
        this.model,
        `reasoning_effort=${this.#cfg.reasoningEffort ?? "(model default)"}` + (variant === undefined ? "" : `\u001fvariant=${variant}`),
      );
      if (!opts.bypassCache) {
        const hit = (await this.#cache.get(st.cacheKey)) as { value?: unknown; meta?: InferenceMeta } | undefined;
        if (hit && hit.value !== undefined && hit.meta) {
          // Re-validate on read: a corrupted or stale cache entry must not be presented as a result.
          const raw = (hit.value as { __raw?: unknown }).__raw;
          const v = validate(raw);
          if (v.ok) return { status: "ok", value: v.value, meta: { ...hit.meta, cache_hit: true, cache_key: st.cacheKey, attempts: 0, latency_ms: Date.now() - t0 } };
        }
      }

      if (opts.bypassCache) return await this.#generate(tpl, bundle, validate, opts, st, meta, (l) => (last = l));
      const key = st.cacheKey;
      const pending = this.#inflight.get(key) as Promise<InferenceResult<T>> | undefined;
      if (pending) {
        // Another caller is already generating this exact analysis; share its result instead of paying for a second call.
        // A result that only reflects the other caller's cancellation is not shared.
        const shared = await pending;
        if (!(shared.status === "error" && shared.detail === CANCELLED)) {
          return { ...shared, meta: { ...shared.meta, attempts: 0, latency_ms: Date.now() - t0 } } as InferenceResult<T>;
        }
      }
      const p = this.#generate(tpl, bundle, validate, opts, st, meta, (l) => (last = l));
      this.#inflight.set(key, p as Promise<InferenceResult<unknown>>);
      try {
        return await p;
      } finally {
        if (this.#inflight.get(key) === p) this.#inflight.delete(key);
      }
    } catch (e) {
      return { status: "error", http_status: null, detail: `unexpected: ${e instanceof Error ? e.name : "error"}`, meta: meta() };
    }
  }

  async #generate<T>(
    tpl: PromptTemplate,
    bundle: EvidenceBundle,
    validate: (raw: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
    opts: CallOptions,
    st: { attempts: number; repair: boolean; mode: StructuredMode; cacheKey: string | null },
    meta: (extra?: Partial<InferenceMeta>) => InferenceMeta,
    setLast: (l: Partial<InferenceMeta>) => void,
  ): Promise<InferenceResult<T>> {
    try {
      let messages: ChatMessage[] = tpl.build(bundle);
      for (let pass = 0; pass < 2; pass++) {
        const call = await this.#chat(messages, tpl, st, opts.signal);
        if (call.kind === "terminal") return { ...call.result, meta: meta() } as InferenceResult<T>;
        setLast({
          served_model: call.served_model,
          applied_reasoning_effort: call.applied_reasoning_effort,
          request_id: call.request_id,
          finish_reason: call.finish_reason,
          usage: call.usage,
        });

        let errors: string[];
        let raw: unknown;
        if (call.refusal) errors = [`model refused: ${redact(call.refusal.slice(0, 200)).text}`];
        else if (!call.content || call.content.trim() === "") errors = [`empty message content (finish_reason=${call.finish_reason ?? "null"})`];
        else {
          const parsed = parseJsonLoose(call.content);
          if (!parsed.ok) errors = [parsed.error];
          else {
            raw = parsed.value;
            const v = validate(raw);
            if (v.ok) {
              const m = meta();
              await this.#cache.set(st.cacheKey!, { value: { __raw: raw }, meta: m });
              return { status: "ok", value: v.value, meta: m };
            }
            errors = v.errors;
          }
        }
        if (call.finish_reason === "length") errors.push("output was cut off (finish_reason=length); keep the answer short");
        if (pass === 0) {
          st.repair = true;
          // An empty assistant turn is rejected by some OpenAI-compatible servers; only echo non-empty content.
          const prior: ChatMessage[] = call.content && call.content.trim() !== "" ? [{ role: "assistant", content: call.content }] : [];
          messages = [...messages, ...prior, repairMessage(errors)];
          continue;
        }
        return { status: "invalid_output", errors, detail: "model output failed validation after one repair attempt; not shown as fact", meta: meta() };
      }
      return { status: "error", http_status: null, detail: "unreachable", meta: meta() };
    } catch (e) {
      return { status: "error", http_status: null, detail: `unexpected: ${e instanceof Error ? e.name : "error"}`, meta: meta() };
    }
  }

  #backoff(attempt: number): number {
    const base = this.#cfg.baseBackoffMs * 4 ** attempt; // 1s, 4s, 16s
    return Math.round(base * (0.8 + 0.4 * this.#random())); // +-20% jitter
  }

  async #chat(messages: ChatMessage[], tpl: PromptTemplate, st: { attempts: number; mode: StructuredMode }, signal?: AbortSignal): Promise<ChatOk | Terminal> {
    let fellBack = false;
    for (let retry = 0; ; ) {
      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        temperature: this.#cfg.temperature,
        max_completion_tokens: this.#cfg.maxCompletionTokens,
        stream: false,
      };
      if (this.#cfg.reasoningEffort) body.reasoning_effort = this.#cfg.reasoningEffort;
      if (st.mode === "json_schema") body.response_format = { type: "json_schema", json_schema: { name: tpl.schema_name, strict: true, schema: tpl.json_schema } };
      else if (st.mode === "json_object") body.response_format = { type: "json_object" };
      const payload = JSON.stringify(body);

      // Egress guard: the exact outbound body must not contain any known/synthetic secret or high-precision token format.
      const leaks = scanForLeaks(payload, { knownSecrets: [this.#apiKey!] });
      if (leaks.length > 0) {
        return { kind: "terminal", result: { status: "unavailable", reason: "redaction_guard_tripped", detail: `outbound request blocked: secret-like content detected (${leaks.join(", ")})` } };
      }

      st.attempts++;
      let res: HttpResponse;
      try {
        res = await requestWithTimeout(
          this.#transport,
          {
            method: "POST",
            url: `${this.#cfg.baseUrl}${AIAND_API_SURFACE.chat_completions_path}`,
            headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
            body: payload,
          },
          this.#cfg.timeoutMs,
          signal,
        );
      } catch (e) {
        if (signal?.aborted) return { kind: "terminal", result: { status: "error", http_status: null, detail: CANCELLED } };
        // Policy refusals (incl. a blocked redirect) are never retried: nothing was or will be sent to another endpoint.
        if (e instanceof EndpointPolicyError) return { kind: "terminal", result: { status: "unavailable", reason: "endpoint_rejected", detail: e.message } };
        const isTimeout = e instanceof TimeoutError;
        if (retry < this.#cfg.maxRetries && (!isTimeout || this.#cfg.retryOnTimeout)) {
          await this.#sleep(this.#backoff(retry));
          retry++;
          continue;
        }
        return isTimeout
          ? { kind: "terminal", result: { status: "timeout", detail: `no response within ${this.#cfg.timeoutMs} ms (${st.attempts} attempts)` } }
          : { kind: "terminal", result: { status: "unavailable", reason: "transport_unreachable", detail: `could not reach ai& (${st.attempts} attempts)` } };
      }

      const s = res.status;
      if (s === 200) {
        try {
          const j = JSON.parse(res.body) as {
            model?: unknown;
            choices?: Array<{ message?: { content?: unknown; refusal?: unknown }; finish_reason?: unknown }>;
            usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown }; completion_tokens_details?: { reasoning_tokens?: unknown } };
          };
          const ch = j.choices?.[0];
          // Never parse reasoning_content / reasoning as the answer (verifier note): only message.content counts.
          return {
            kind: "ok",
            applied_reasoning_effort: res.headers["x-reasoning-effort"] ?? null,
            content: typeof ch?.message?.content === "string" ? ch.message.content : null,
            refusal: typeof ch?.message?.refusal === "string" && ch.message.refusal ? ch.message.refusal : null,
            finish_reason: typeof ch?.finish_reason === "string" ? ch.finish_reason : null,
            served_model: res.headers["x-model"] ?? (typeof j.model === "string" ? j.model : null),
            request_id: res.headers["x-request-id"] ?? null,
            usage: j.usage
              ? {
                  input_tokens: num(j.usage.prompt_tokens),
                  output_tokens: num(j.usage.completion_tokens),
                  reasoning_tokens: num(j.usage.completion_tokens_details?.reasoning_tokens),
                  cached_tokens: num(j.usage.prompt_tokens_details?.cached_tokens),
                }
              : null,
          };
        } catch {
          return { kind: "ok", applied_reasoning_effort: res.headers["x-reasoning-effort"] ?? null, content: null, refusal: null, finish_reason: null, served_model: null, request_id: res.headers["x-request-id"] ?? null, usage: null };
        }
      }

      if (s === 429) {
        const policy = res.headers["x-ratelimit-policy"] ?? null;
        const ra = parseRetryAfter(res.headers["retry-after"]);
        // Concurrency rejects carry no Retry-After and retrying immediately makes them worse (ai& rate-limit docs).
        if (policy !== null && CONCURRENCY_POLICIES.has(policy)) {
          return { kind: "terminal", result: { status: "rate_limited", retry_after_ms: null, policy, detail: "ai& concurrency limit reached; retry after in-flight requests finish" } };
        }
        const wait = Math.max(ra ?? 0, this.#backoff(retry));
        if (retry < this.#cfg.maxRetries && wait <= this.#cfg.maxRetryWaitMs) {
          await this.#sleep(wait);
          retry++;
          continue;
        }
        return { kind: "terminal", result: { status: "rate_limited", retry_after_ms: ra, policy, detail: `ai& rate limit (${policy ?? "unknown bucket"})` } };
      }

      if (s === 400 && st.mode === "json_schema" && !fellBack && /response_format|json_schema|schema|strict/i.test(res.body)) {
        // Documented fallback when a model rejects strict schemas: json_object + client-side validation.
        st.mode = "json_object";
        fellBack = true;
        continue;
      }
      if (s >= 500 || s === 499) {
        if (retry < this.#cfg.maxRetries) {
          await this.#sleep(this.#backoff(retry));
          retry++;
          continue;
        }
        if (s === 504) return { kind: "terminal", result: { status: "timeout", detail: `ai& timed out (504) after ${st.attempts} attempts` } };
        return { kind: "terminal", result: { status: "unavailable", reason: "provider_error", detail: `ai& server error ${s}: ${safeProviderMessage(res.body)}` } };
      }
      if (s === 401) return { kind: "terminal", result: { status: "unavailable", reason: "auth_failed", detail: "ai& rejected the API key (401)" } };
      if (s === 402) return { kind: "terminal", result: { status: "unavailable", reason: "insufficient_credits", detail: "ai& balance exhausted (402)" } };
      if (s === 403) return { kind: "terminal", result: { status: "unavailable", reason: "forbidden", detail: `ai& refused the request (403): ${safeProviderMessage(res.body)}` } };
      if (s === 404 && providerErrorCode(res.body) === "model_not_found") {
        return { kind: "terminal", result: { status: "unavailable", reason: "model_not_found", detail: `model ${this.model} not available to this key (404)` } };
      }
      return { kind: "terminal", result: { status: "error", http_status: s, detail: `ai& returned ${s}: ${safeProviderMessage(res.body)}` } };
    }
  }
}
