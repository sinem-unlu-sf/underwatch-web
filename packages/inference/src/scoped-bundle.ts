import { createRedactionContext, REDACTION_RULESET_VERSION, type RedactOptions } from "@kw/redaction";
import { BUNDLE_VERSION, DEFAULT_BUNDLE_LIMITS, ItemBuilder, canonicalJson, sha256, type BundleFieldValue, type BundleItem, type BundleLimits, type EvidenceBundle } from "./bundle";

/**
 * Ask Witness RUN / WORKSPACE scope bundles. The server picks the records deterministically (Underwatch's own
 * database only) and hands them here pre-shaped; this module applies the same redaction / sanitization / truncation /
 * size budget / hash seal as the finding bundle. Ids are validated and never redacted.
 */
export interface ScopedItemInput {
  evidence_id: string;
  kind: BundleItem["kind"];
  basis: BundleItem["basis"];
  source: string | null;
  timestamp: string | null;
  links?: readonly string[];
  /** Deterministic values (enums, numbers, ids, booleans). Strings here are still length-capped, not redacted. */
  fields?: Record<string, BundleFieldValue>;
  /** Untrusted free text (titles, summaries, resource paths): redacted, sanitized, truncated. */
  text?: Record<string, string | null | undefined>;
  /** Untrusted string lists (redacted per element, max 10). */
  lists?: Record<string, readonly string[] | null | undefined>;
  /** Untrusted captured text (evidence excerpt, raw summary). */
  content?: string | null;
}

export interface BuildScopedBundleInput {
  scope: { kind: "run" | "workspace"; id: string | null };
  items: readonly ScopedItemInput[];
  /** Hard cap on items (default 40). Items past the cap are counted in omitted.evidence. */
  maxItems?: number;
  limits?: Partial<BundleLimits>;
  redaction?: Omit<RedactOptions, "context">;
}

export const SCOPED_BUNDLE_MAX_ITEMS = 40;
const SCOPED_ID_RE = /^[A-Za-z0-9_.:#-]{1,160}$/;

export function buildScopedBundle(input: BuildScopedBundleInput): EvidenceBundle {
  const limits: BundleLimits = { ...DEFAULT_BUNDLE_LIMITS, maxTotalContentChars: 16000, maxStringChars: 1200, ...input.limits };
  const maxItems = input.maxItems ?? SCOPED_BUNDLE_MAX_ITEMS;
  const ctx = createRedactionContext();
  const ropts = input.redaction ?? {};
  const sanitization = { control_chars_removed: 0, invisible_chars_marked: 0 };
  const byDetector: Record<string, number> = {};
  const omitted = { events: 0, evidence: 0, invalid_ids: 0, not_provided: 0 };
  const items: BundleItem[] = [];
  const seen = new Set<string>();
  for (const it of input.items) {
    if (!SCOPED_ID_RE.test(it.evidence_id)) {
      omitted.invalid_ids++;
      continue;
    }
    if (seen.has(it.evidence_id)) continue;
    if (items.length >= maxItems) {
      if (it.kind === "event") omitted.events++;
      else omitted.evidence++;
      continue;
    }
    seen.add(it.evidence_id);
    const b = new ItemBuilder(ctx, ropts, limits, sanitization, byDetector);
    const fields: Record<string, BundleFieldValue> = {};
    // Defense in depth: "deterministic" string fields can still carry untrusted text (run labels, agent_type,
    // policy_version, source names supplied at ingest). Id-shaped values under *_id / *_ids keys stay verbatim (so
    // citations and links keep working); every other string is redacted + sanitized like free text.
    const idKey = (k: string) => /(^|_)ids?$/.test(k);
    const fieldStr = (k: string, s: string, max: number) => (idKey(k) && SCOPED_ID_RE.test(s) ? s.slice(0, max) : (b.text(s, max) ?? ""));
    for (const [k, v] of Object.entries(it.fields ?? {})) {
      fields[k] = typeof v === "string" ? fieldStr(k, v, 300) : Array.isArray(v) ? v.slice(0, 20).map((x) => fieldStr(k, String(x), 200)) : v;
    }
    for (const [k, v] of Object.entries(it.text ?? {})) fields[k] = b.text(v ?? null, 600);
    for (const [k, v] of Object.entries(it.lists ?? {})) fields[k] = b.list(v ?? []);
    const content = b.text(it.content ?? null);
    items.push({
      evidence_id: it.evidence_id,
      kind: it.kind,
      basis: it.basis,
      source: it.source,
      timestamp: it.timestamp,
      links: (it.links ?? []).filter((id) => SCOPED_ID_RE.test(id)).slice(0, 20),
      fields,
      content,
      content_omitted: content === null ? "not_captured" : null,
      truncated: b.truncated,
      redaction: b.finish(),
    });
  }
  let used = 0;
  for (const it of items) {
    if (it.content === null) continue;
    if (used + it.content.length > limits.maxTotalContentChars) {
      it.content = null;
      it.content_omitted = "size_budget";
      continue;
    }
    used += it.content.length;
  }
  const body: Omit<EvidenceBundle, "sha256"> = {
    bundle_version: BUNDLE_VERSION,
    scope: { kind: input.scope.kind, id: input.scope.id },
    finding_id: "",
    run_id: input.scope.kind === "run" ? (input.scope.id ?? "") : "",
    items,
    allowed_ids: items.map((i) => i.evidence_id),
    omitted,
    redaction_summary: {
      ruleset_version: REDACTION_RULESET_VERSION,
      items_redacted: items.filter((i) => i.redaction.status === "redacted").length,
      total_placeholders: items.reduce((n, i) => n + i.redaction.placeholder_count, 0),
      by_detector: byDetector,
    },
    sanitization,
    limits,
  };
  return { ...body, sha256: sha256(canonicalJson(body)) };
}
