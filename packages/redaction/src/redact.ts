import {
  type CustomPattern,
  DEFAULT_SYNTHETIC_REGISTRY,
  DETECTORS,
  DETECTOR_CONFIDENCE,
  type DetectorConfidence,
  type DetectorContext,
  type DetectorId,
  type Span,
  type SyntheticSecretRegistry,
} from "./detectors";

/** Bump whenever a detector, threshold or placeholder format changes; stored with every redacted view. */
export const REDACTION_RULESET_VERSION = "kw.redaction.rules@1";

export const DEFAULT_ENTROPY_THRESHOLD = 4.2;
export const DEFAULT_HEX_ENTROPY_THRESHOLD = 3.5;
export const DEFAULT_ENTROPY_MIN_LENGTH = 24;

export interface RedactOptions {
  /** Synthetic-secret registry. Defaults to DEFAULT_SYNTHETIC_REGISTRY; pass `extendRegistry()` to add entries. */
  registry?: SyntheticSecretRegistry;
  /** Exact values that must never appear (e.g. the configured ai& key, a run placeholder). Encoded variants are matched too. */
  knownSecrets?: readonly string[];
  /** Bits/char for the generic high-entropy detector (base64/base62 tokens). Lower = more aggressive. */
  entropyThreshold?: number;
  /** Bits/char for pure-hex tokens (max possible is 4.0). */
  hexEntropyThreshold?: number;
  /** Minimum token length for the high-entropy detector. */
  entropyMinLength?: number;
  /** Operator-supplied extra patterns (see parseRedactionConfig / redactionOptionsFromEnv). Reported as "custom_pattern". */
  customPatterns?: readonly CustomPattern[];
  /** Run only these detectors. */
  detectors?: readonly DetectorId[];
  /** Skip these detectors. */
  disable?: readonly DetectorId[];
  /**
   * Shared numbering state. Pass the same context to several redact() calls (e.g. every item of one evidence bundle)
   * so the same secret value always gets the same placeholder across items.
   */
  context?: RedactionContext;
}

export interface RedactionMatch {
  detector: DetectorId;
  /** Offsets into the ORIGINAL input text (UTF-16 code units). */
  start: number;
  end: number;
  placeholder: string;
}

export interface RedactResult {
  text: string;
  matches: RedactionMatch[];
  status: "clean" | "redacted";
}

/** Numbering state: per detector, distinct secret value -> ordinal. Values never leave this object. */
export class RedactionContext {
  readonly #ordinals = new Map<DetectorId, Map<string, number>>();

  placeholderFor(detector: DetectorId, value: string): string {
    let byValue = this.#ordinals.get(detector);
    if (!byValue) {
      byValue = new Map();
      this.#ordinals.set(detector, byValue);
    }
    let n = byValue.get(value);
    if (n === undefined) {
      n = byValue.size + 1;
      byValue.set(value, n);
    }
    return `[REDACTED:${detector}#${n}]`;
  }

  /** Count of distinct values per detector (no values exposed). */
  counts(): Partial<Record<DetectorId, number>> {
    const out: Partial<Record<DetectorId, number>> = {};
    for (const [d, m] of this.#ordinals) out[d] = m.size;
    return out;
  }

  toJSON(): unknown {
    return { counts: this.counts() };
  }
}

export function createRedactionContext(): RedactionContext {
  return new RedactionContext();
}

export function extendRegistry(extra: Partial<SyntheticSecretRegistry>, base: SyntheticSecretRegistry = DEFAULT_SYNTHETIC_REGISTRY): SyntheticSecretRegistry {
  return {
    names: [...base.names, ...(extra.names ?? [])],
    value_patterns: [...base.value_patterns, ...(extra.value_patterns ?? [])],
    values: [...base.values, ...(extra.values ?? [])],
  };
}

// Zero-width and invisible format characters an agent (or attacker) could use to split a secret.
const INVISIBLE = /[​-‍⁠﻿­]/g;

/** Strip invisible characters, remembering where each kept char came from in the original. */
function stripInvisible(text: string): { text: string; map: number[] } {
  if (!INVISIBLE.test(text)) {
    INVISIBLE.lastIndex = 0;
    return { text, map: [] };
  }
  INVISIBLE.lastIndex = 0;
  let out = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/[​-‍⁠﻿­]/.test(c)) continue;
    out += c;
    map.push(i);
  }
  map.push(text.length);
  return { text: out, map };
}

function detectorContext(opts: RedactOptions): DetectorContext {
  return {
    registry: opts.registry ?? DEFAULT_SYNTHETIC_REGISTRY,
    knownSecrets: opts.knownSecrets ?? [],
    customPatterns: opts.customPatterns ?? [],
    entropyThreshold: opts.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD,
    hexEntropyThreshold: opts.hexEntropyThreshold ?? DEFAULT_HEX_ENTROPY_THRESHOLD,
    entropyMinLength: opts.entropyMinLength ?? DEFAULT_ENTROPY_MIN_LENGTH,
  };
}

/** Merge overlapping/adjacent-overlapping spans. The merged span takes the detector of the highest-priority member. */
function mergeSpans(input: Span[]): Span[] {
  // A heuristic span that overlaps a precise span is dropped, so it cannot widen the precise span (e.g. swallow the
  // escaped "\n" before a PEM body).
  const precise = input.filter((s) => DETECTOR_CONFIDENCE[s.detector] !== "heuristic");
  const spans = input.filter((s) => DETECTOR_CONFIDENCE[s.detector] !== "heuristic" ? true : !precise.some((p) => s.start < p.end && p.start < s.end));
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end || b.priority - a.priority);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      if (s.priority > last.priority) {
        last.priority = s.priority;
        last.detector = s.detector;
      }
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

function selectedDetectors(opts: RedactOptions) {
  return DETECTORS.filter((d) => (!opts.detectors || opts.detectors.includes(d.id)) && !(opts.disable ?? []).includes(d.id));
}

/** Find secret spans without rewriting. Offsets refer to the original text. */
export function findSecrets(text: string, opts: RedactOptions = {}): Array<{ detector: DetectorId; start: number; end: number; confidence: DetectorConfidence }> {
  const { text: scan, map } = stripInvisible(text);
  const ctx = detectorContext(opts);
  const spans: Span[] = [];
  for (const d of selectedDetectors(opts)) spans.push(...d.find(scan, ctx));
  const toOrig = (i: number) => (map.length ? map[i]! : i);
  return mergeSpans(spans).map((s) => ({
    detector: s.detector,
    start: toOrig(s.start),
    // map the exclusive end via the last included char so trailing invisible chars outside the secret are kept
    end: s.end > s.start ? toOrig(s.end - 1) + 1 : toOrig(s.end),
    confidence: DETECTOR_CONFIDENCE[s.detector],
  }));
}

/** Pre-existing marker text in the input is escaped so a planted fake marker cannot pass for a real redaction. */
function escapeMarkers(segment: string): string {
  return segment.replace(/\[REDACTED:/g, "[REDACTED\\:");
}

/**
 * Redact secrets from `text`, replacing each secret span with a deterministic placeholder `[REDACTED:<detector>#<n>]`.
 * Everything outside the spans (keys, quotes, punctuation, newlines) is preserved, so line and JSON structure survive.
 * Never throws for string input.
 */
export function redact(text: string, opts: RedactOptions = {}): RedactResult {
  const ctx = opts.context ?? new RedactionContext();
  const found = findSecrets(text, opts);
  const matches: RedactionMatch[] = [];
  let out = "";
  let cursor = 0;
  for (const f of found) {
    const value = text.slice(f.start, f.end).replace(INVISIBLE, "");
    const placeholder = ctx.placeholderFor(f.detector, value);
    out += escapeMarkers(text.slice(cursor, f.start)) + placeholder;
    cursor = f.end;
    matches.push({ detector: f.detector, start: f.start, end: f.end, placeholder });
  }
  out += escapeMarkers(text.slice(cursor));
  return { text: out, matches, status: matches.length > 0 ? "redacted" : "clean" };
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface RedactDeepResult<T> {
  value: T;
  matches: Array<RedactionMatch & { path: string }>;
  status: "clean" | "redacted";
}

/**
 * Redact every string leaf of a JSON-like value. Keys are preserved; strings under `skipKeys` (e.g. ID fields) are
 * left untouched only if they also satisfy `isSafeId` (default: KW ID shape), otherwise they are scanned like content.
 */
export function redactDeep<T extends JsonValue>(
  value: T,
  opts: RedactOptions & { skipKeys?: readonly string[]; isSafeId?: (s: string) => boolean } = {},
): RedactDeepResult<T> {
  const ctx = opts.context ?? new RedactionContext();
  const skip = new Set(opts.skipKeys ?? []);
  const isSafeId = opts.isSafeId ?? ((s: string) => /^(run|pol|evt|evd|fnd|fsc|sg|ver|cor)_[A-Za-z0-9_-]+$/.test(s));
  const matches: Array<RedactionMatch & { path: string }> = [];
  const walk = (v: JsonValue, path: string, key: string | null): JsonValue => {
    if (typeof v === "string") {
      if (key !== null && skip.has(key) && isSafeId(v)) return v;
      const r = redact(v, { ...opts, context: ctx });
      for (const m of r.matches) matches.push({ ...m, path });
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, key));
    if (v !== null && typeof v === "object") {
      const o: { [k: string]: JsonValue } = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x, path ? `${path}.${k}` : k, k);
      return o;
    }
    return v;
  };
  const out = walk(value, "", null) as T;
  return { value: out, matches, status: matches.length ? "redacted" : "clean" };
}

/**
 * Egress check for an exact outbound payload: runs exact + pattern detectors (no entropy heuristic, which would trip on
 * hashes and placeholders). Returns the detectors that fired; never returns the matched values.
 */
export function scanForLeaks(payload: string, opts: Omit<RedactOptions, "detectors" | "context"> = {}): DetectorId[] {
  const hits = findSecrets(payload, { ...opts, disable: [...(opts.disable ?? []), "high_entropy"] });
  return [...new Set(hits.map((h) => h.detector))];
}

/** Map a redaction result onto the schema's Evidence.redaction_status vocabulary. */
export function toEvidenceRedactionStatus(r: { status: "clean" | "redacted" }): "no_secrets_detected" | "redacted" {
  return r.status === "clean" ? "no_secrets_detected" : "redacted";
}

// ---------------------------------------------------------------------------------------------------------------
// Fail-closed redaction for storage boundaries

/** Stored INSTEAD of the original text when redaction itself fails. The original is never kept. */
export const REDACTION_FAILED_PLACEHOLDER = "[REDACTION_FAILED]";

/** Per-record outcome. "failed" means the stored value is REDACTION_FAILED_PLACEHOLDER. */
export type SafeRedactStatus = "clean" | "redacted" | "failed";

export interface SafeRedactResult {
  text: string;
  status: SafeRedactStatus;
  /** Detectors that fired (never the matched values). */
  detectors: DetectorId[];
}

export interface SafeRedactOptions extends RedactOptions {
  /**
   * Return the input unchanged when nothing was found (default false). Use for a SECOND pass over text that may already
   * carry placeholders from an earlier pass, so marker escaping does not mangle them; a first pass over raw input should
   * leave this off so planted fake markers are escaped.
   */
  keepCleanTextVerbatim?: boolean;
  /** Called on failure with a description that never contains the input text. */
  onFailure?: (info: { error: string }) => void;
  /**
   * Inputs longer than this (UTF-16 units) are cut at a whitespace boundary, the head is redacted and the tail is
   * WITHHELD (replaced by a marker, never stored). Bounds the synchronous cost of one call. Default 1,000,000.
   */
  maxLength?: number;
}

export const DEFAULT_SAFE_REDACT_MAX_LENGTH = 1_000_000;

/** Appended in place of the withheld tail of an over-long input. */
export function withheldTailMarker(chars: number): string {
  return `[REDACTION_WITHHELD: ${chars} more characters not stored]`;
}

/**
 * Redact for persistence: never throws and FAILS CLOSED. If any detector throws (or the input is not a string), the
 * result is REDACTION_FAILED_PLACEHOLDER with status "failed"; the original text is never returned.
 */
export function safeRedact(text: string, opts: SafeRedactOptions = {}): SafeRedactResult {
  try {
    if (typeof text !== "string") throw new TypeError(`expected string, got ${typeof text}`);
    const max = opts.maxLength ?? DEFAULT_SAFE_REDACT_MAX_LENGTH;
    if (text.length > max) {
      // Cut at the last whitespace in the final 4 KB so the kept head does not end inside a token.
      const ws = text.slice(Math.max(0, max - 4096), max).search(/\s[^\s]*$/);
      const cut = ws === -1 ? max : Math.max(0, max - 4096) + ws;
      const r = redact(text.slice(0, cut), opts);
      const detectors = [...new Set(r.matches.map((m) => m.detector))].sort();
      return { text: r.text + withheldTailMarker(text.length - cut), status: "redacted", detectors };
    }
    const r = redact(text, opts);
    const detectors = [...new Set(r.matches.map((m) => m.detector))].sort();
    if (r.status === "clean") return { text: opts.keepCleanTextVerbatim ? text : r.text, status: "clean", detectors };
    return { text: r.text, status: "redacted", detectors };
  } catch (err) {
    // Only the error class name: a message could quote the input.
    const name = err instanceof Error ? err.name : typeof err;
    try {
      opts.onFailure?.({ error: name });
    } catch {
      /* a failing logger must not turn a fail-closed redaction into a leak */
    }
    return { text: REDACTION_FAILED_PLACEHOLDER, status: "failed", detectors: [] };
  }
}

/** The redactor used when a caller does not supply one: real detectors, fail-closed. */
export function defaultRedactor(opts: SafeRedactOptions = {}): (text: string) => string {
  return (text: string) => safeRedact(text, opts).text;
}

// ---------------------------------------------------------------------------------------------------------------
// Operator configuration (extra patterns / known secrets), I/O injected so this package stays pure.

export class RedactionConfigError extends Error {
  override name = "RedactionConfigError";
}

/** Env var naming a JSON file of extra patterns. */
export const REDACTION_PATTERNS_FILE_ENV = "KW_REDACTION_PATTERNS_FILE";
/** Env vars whose VALUES are always redacted (exact + encoded variants) wherever they appear. */
export const DEFAULT_KNOWN_SECRET_ENV = ["AIAND_API_KEY", "NEO4J_PASSWORD", "CLAUDE_CODE_OAUTH_TOKEN", "KW_API_TOKEN", "ANTHROPIC_API_KEY"] as const;

export interface RedactionConfig {
  customPatterns: CustomPattern[];
  /** Extra env var names whose values are known secrets. */
  knownSecretEnv: string[];
}

/**
 * Parse a pattern file:
 * `{"patterns":[{"name":"acme_token","regex":"acme_[A-Za-z0-9]{32}","flags":"i","group":0}],"known_secret_env":["ACME_TOKEN"]}`
 * or a bare array of regex strings. Invalid files throw RedactionConfigError (fail loud, never silently unredacted).
 */
export function parseRedactionConfig(jsonText: string, source = "redaction config"): RedactionConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new RedactionConfigError(`${source}: not valid JSON`);
  }
  const obj = Array.isArray(raw) ? { patterns: raw } : raw;
  if (typeof obj !== "object" || obj === null) throw new RedactionConfigError(`${source}: expected an object or an array`);
  const o = obj as { patterns?: unknown; known_secret_env?: unknown };
  const patterns = o.patterns ?? [];
  if (!Array.isArray(patterns)) throw new RedactionConfigError(`${source}: "patterns" must be an array`);
  const customPatterns = patterns.map((p, i): CustomPattern => {
    const spec = typeof p === "string" ? { regex: p } : (p as { name?: unknown; regex?: unknown; flags?: unknown; group?: unknown });
    if (typeof spec !== "object" || spec === null || typeof spec.regex !== "string" || spec.regex.length === 0)
      throw new RedactionConfigError(`${source}: patterns[${i}] needs a non-empty "regex" string`);
    const flags = typeof spec.flags === "string" ? spec.flags : "";
    if (!/^[imsu]*$/.test(flags)) throw new RedactionConfigError(`${source}: patterns[${i}] flags may only use i, m, s, u`);
    let re: RegExp;
    try {
      re = new RegExp(spec.regex, flags);
    } catch {
      throw new RedactionConfigError(`${source}: patterns[${i}] is not a valid regular expression`);
    }
    if (re.test("")) throw new RedactionConfigError(`${source}: patterns[${i}] matches the empty string`);
    const group = typeof spec.group === "number" && Number.isInteger(spec.group) && spec.group >= 0 ? spec.group : 0;
    return { name: typeof spec.name === "string" ? spec.name : `pattern_${i}`, re, group };
  });
  const env = o.known_secret_env ?? [];
  if (!Array.isArray(env) || env.some((e) => typeof e !== "string")) throw new RedactionConfigError(`${source}: "known_secret_env" must be an array of strings`);
  return { customPatterns, knownSecretEnv: env as string[] };
}

/**
 * Redaction options for a process: known secrets from DEFAULT_KNOWN_SECRET_ENV (+ the config's known_secret_env) and
 * the extra patterns from $KW_REDACTION_PATTERNS_FILE. `readFile` is injected (fs.readFileSync(path, "utf8")).
 */
export function redactionOptionsFromEnv(env: Record<string, string | undefined>, readFile?: (path: string) => string): RedactOptions {
  let config: RedactionConfig = { customPatterns: [], knownSecretEnv: [] };
  const file = env[REDACTION_PATTERNS_FILE_ENV]?.trim();
  if (file) {
    if (!readFile) throw new RedactionConfigError(`${REDACTION_PATTERNS_FILE_ENV} is set but no file reader was supplied`);
    let text: string;
    try {
      text = readFile(file);
    } catch {
      throw new RedactionConfigError(`${REDACTION_PATTERNS_FILE_ENV}: cannot read ${file}`);
    }
    config = parseRedactionConfig(text, file);
  }
  const names = [...new Set([...DEFAULT_KNOWN_SECRET_ENV, ...config.knownSecretEnv])];
  const knownSecrets = names.flatMap((k) => {
    const v = env[k]?.trim();
    return v && v.length >= 8 ? [v] : [];
  });
  return { knownSecrets, customPatterns: config.customPatterns };
}
