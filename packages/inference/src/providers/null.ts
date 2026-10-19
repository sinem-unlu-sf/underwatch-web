import type { AskWitnessModelOutput } from "@kw/schema";
import { ASK_WITNESS_PROMPT_VERSION, ASK_WITNESS_SCHEMA_VERSION, type AskWitnessCallOptions, type AskWitnessHistoryEntry } from "../askwitness";
import type { EvidenceBundle } from "../bundle";
import type { CheckedExplanation, CheckedSafeguardProposal } from "../citations";
import { EXPLAIN_FINDING_V1, PROPOSE_SAFEGUARD_V1, type PromptTemplate } from "../prompts";
import { type CallOptions, emptyMeta, type HealthInfo, type InferenceProvider, type InferenceResult, type TemplateValidator } from "../types";

/** Used when ai& is not configured. Always unavailable; never touches the network. */
export class NullProvider implements InferenceProvider {
  readonly id = "null";
  readonly model = "none";
  constructor(private readonly reason = "ai& not configured") {}

  #unavailable(prompt_version: string, schema_version: string) {
    return {
      status: "unavailable" as const,
      reason: "not_configured" as const,
      detail: this.reason,
      meta: emptyMeta({ provider: this.id, model: this.model, prompt_version, schema_version }),
    };
  }
  async explainFinding(bundle: EvidenceBundle): Promise<InferenceResult<CheckedExplanation>> {
    const r = this.#unavailable(EXPLAIN_FINDING_V1.prompt_version, EXPLAIN_FINDING_V1.schema_version);
    return { ...r, meta: { ...r.meta, bundle_sha256: bundle?.sha256 ?? null } };
  }
  async proposeSafeguard(bundle: EvidenceBundle): Promise<InferenceResult<CheckedSafeguardProposal>> {
    const r = this.#unavailable(PROPOSE_SAFEGUARD_V1.prompt_version, PROPOSE_SAFEGUARD_V1.schema_version);
    return { ...r, meta: { ...r.meta, bundle_sha256: bundle?.sha256 ?? null } };
  }
  async runTemplate<T>(tpl: PromptTemplate, bundle: EvidenceBundle, _validate: TemplateValidator<T>): Promise<InferenceResult<T>> {
    const r = this.#unavailable(tpl.prompt_version, tpl.schema_version);
    return { ...r, meta: { ...r.meta, bundle_sha256: bundle?.sha256 ?? null } };
  }
  async askWitness(_question: string, bundle: EvidenceBundle, _history: readonly AskWitnessHistoryEntry[] = [], _opts?: AskWitnessCallOptions): Promise<InferenceResult<AskWitnessModelOutput>> {
    const r = this.#unavailable(ASK_WITNESS_PROMPT_VERSION, ASK_WITNESS_SCHEMA_VERSION);
    return { ...r, meta: { ...r.meta, bundle_sha256: bundle?.sha256 ?? null } };
  }
  async health(): Promise<InferenceResult<HealthInfo>> {
    return this.#unavailable("health", "health");
  }
}
