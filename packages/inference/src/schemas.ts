import { SafeguardType } from "@kw/schema";
import { z } from "zod";

export const EXPLANATION_SCHEMA_VERSION = "kw.explanation@1";
export const SAFEGUARD_PROPOSAL_SCHEMA_VERSION = "kw.safeguard-proposal@1";

const shortText = (max: number) => z.string().trim().min(1).max(max);
const evidenceIds = z.array(z.string().min(1).max(200)).max(20);

/** Model output for "explain finding". Validated locally even when the provider claims strict schema enforcement. */
export const Explanation = z.object({
  summary: shortText(2000),
  claims: z
    .array(
      z.object({
        text: shortText(1000),
        evidence_ids: evidenceIds,
      }),
    )
    .max(20),
  missing_evidence: z.array(shortText(600)).max(20),
  next_steps: z.array(shortText(400)).max(10),
  insufficient_evidence: z.boolean(),
});
export type Explanation = z.infer<typeof Explanation>;

/** Model output for "propose safeguard". A proposal is data for the FR-9 approval flow; it is never applied automatically. */
export const SafeguardProposal = z.object({
  type: SafeguardType,
  content: shortText(4000),
  mechanism: shortText(600),
  intended_prevention: shortText(1000),
  legitimate_workflow_impact: shortText(1000),
  evidence_ids: evidenceIds,
});
export type SafeguardProposal = z.infer<typeof SafeguardProposal>;

/**
 * Hand-written JSON Schemas sent as `response_format.json_schema.schema`. Kept to a conservative keyword subset
 * (type/properties/required/additionalProperties/items/enum), every key required, no `$comment`, because ai& does not
 * document which keywords strict mode supports (ai& docs /capabilities/structured-outputs/; verifier note on fact 38).
 * Length and count limits are enforced by the Zod schemas above, not by the provider.
 */
export const EXPLANATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, evidence_ids: { type: "array", items: { type: "string" } } },
        required: ["text", "evidence_ids"],
        additionalProperties: false,
      },
    },
    missing_evidence: { type: "array", items: { type: "string" } },
    next_steps: { type: "array", items: { type: "string" } },
    insufficient_evidence: { type: "boolean" },
  },
  required: ["summary", "claims", "missing_evidence", "next_steps", "insufficient_evidence"],
  additionalProperties: false,
} as const;

export const SAFEGUARD_PROPOSAL_JSON_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...SafeguardType.options] },
    content: { type: "string" },
    mechanism: { type: "string" },
    intended_prevention: { type: "string" },
    legitimate_workflow_impact: { type: "string" },
    evidence_ids: { type: "array", items: { type: "string" } },
  },
  required: ["type", "content", "mechanism", "intended_prevention", "legitimate_workflow_impact", "evidence_ids"],
  additionalProperties: false,
} as const;

/** Parse model text as JSON: tolerates a ```json fence and leading/trailing prose around a single object. */
export function parseJsonLoose(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  let lastErr = "empty output";
  for (const c of candidates) {
    if (!c) continue;
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: `not valid JSON: ${lastErr}` };
}

export function zodErrors(err: z.ZodError): string[] {
  return err.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}
