/**
 * Secret detectors. Each detector returns candidate spans over the (zero-width-stripped) input; `redact()` merges them.
 *
 * Token formats below follow widely published conventions (gitleaks-style rules). They were NOT re-verified against
 * each vendor's current documentation in this session: UNVERIFIED: exact current token formats for GitHub, GitLab,
 * Slack, AWS, Anthropic and OpenAI. They are tested only against synthetic look-alike values in this package.
 */

export const DETECTOR_IDS = [
  "synthetic_secret",
  "known_secret",
  "private_key",
  "jwt",
  "aws_access_key",
  "aws_secret_key",
  "github_token",
  "gitlab_token",
  "anthropic_key",
  "openai_style_key",
  "slack_token",
  "url_credentials",
  "auth_header",
  "env_secret_value",
  "encoded_secret",
  "custom_pattern",
  "split_secret",
  "high_entropy",
] as const;
export type DetectorId = (typeof DETECTOR_IDS)[number];

/** How a detector decides. Used for merge priority and for the egress guard (which skips heuristics). */
export type DetectorConfidence = "exact" | "pattern" | "heuristic";

export interface Span {
  detector: DetectorId;
  start: number;
  end: number;
  /** Higher wins when spans overlap. */
  priority: number;
}

export interface SyntheticSecretRegistry {
  /** Variable names whose assigned values are always synthetic secrets (e.g. KW_SYNTHETIC_SECRET=...). Names themselves are never redacted. */
  names: readonly string[];
  /** Value shapes that are synthetic secrets wherever they appear. Must not use the `g` or `y` flags; they are added internally. */
  value_patterns: readonly RegExp[];
  /** Exact synthetic values. Encoded variants (base64, base64url, hex, URL-encoding, JSON-escaped, reversed) are matched too. */
  values: readonly string[];
}

/**
 * Synthetic secrets used by Underwatch demos, fixtures and spikes. The research spikes plant
 * `KW_SYNTHETIC_SECRET=kw-test-0000` (and `kw-test-0001` for a modified file), so both the name and the value shape are registered.
 */
export const DEFAULT_SYNTHETIC_REGISTRY: SyntheticSecretRegistry = {
  names: ["KW_SYNTHETIC_SECRET", "KW_SYNTHETIC_TOKEN", "KW_SYNTHETIC_API_KEY", "KW_CANARY_SECRET"],
  value_patterns: [/\bkw-test-\d{4}\b/, /\bkw-synthetic-[A-Za-z0-9_-]{4,}\b/, /\bKWSYNTH[A-Za-z0-9]{6,}\b/],
  values: [],
};

/** Operator-supplied extra pattern (see parseRedactionConfig). `re` must not use the g/y flags. */
export interface CustomPattern {
  name: string;
  re: RegExp;
  /** Capture group to redact (0 = whole match). */
  group: number;
}

export interface DetectorContext {
  registry: SyntheticSecretRegistry;
  knownSecrets: readonly string[];
  customPatterns: readonly CustomPattern[];
  entropyThreshold: number;
  hexEntropyThreshold: number;
  entropyMinLength: number;
}

export interface DetectorDef {
  id: DetectorId;
  confidence: DetectorConfidence;
  priority: number;
  find(text: string, ctx: DetectorContext): Span[];
}

// ---------------------------------------------------------------------------------------------------------------
// helpers

function flags(re: RegExp, extra: string): string {
  let f = re.flags.replace(/[gy]/g, "");
  for (const c of extra) if (!f.includes(c)) f += c;
  return f;
}

/** All matches of `re`, reporting the span of capture group `group` (0 = whole match). Requires the `d` flag for groups. */
function* matchSpans(text: string, re: RegExp, group = 0): Generator<{ start: number; end: number; m: RegExpExecArray }> {
  const g = new RegExp(re.source, flags(re, group > 0 ? "gd" : "g"));
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    if (m[0].length === 0) {
      g.lastIndex++;
      continue;
    }
    if (group === 0) {
      yield { start: m.index, end: m.index + m[0].length, m };
    } else {
      const idx = m.indices?.[group];
      if (idx) yield { start: idx[0], end: idx[1], m };
    }
  }
}

function spansFor(id: DetectorId, priority: number, text: string, re: RegExp, group = 0, accept?: (value: string, m: RegExpExecArray) => boolean): Span[] {
  const out: Span[] = [];
  for (const { start, end, m } of matchSpans(text, re, group)) {
    const value = text.slice(start, end);
    if (accept && !accept(value, m)) continue;
    out.push({ detector: id, start, end, priority });
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i]!, bytes[i + 1], bytes[i + 2]];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? "=" : B64[c & 63]!;
  }
  return out;
}

/** Encoded forms of a known secret that an agent could plausibly emit (base64 std/url, hex, URL-encoded, JSON-escaped, reversed). */
export function secretVariants(value: string): string[] {
  if (value.length === 0) return [];
  const bytes = utf8Bytes(value);
  const b64 = base64(bytes);
  const variants = new Set<string>([
    value,
    b64,
    b64.replace(/=+$/, ""),
    b64.replace(/\+/g, "-").replace(/\//g, "_"),
    b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    bytes.map((b) => b.toString(16).padStart(2, "0")).join(""),
    bytes.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase(),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
    [...value].reverse().join(""),
  ]);
  // Very short variants would create false positives inside unrelated text.
  return [...variants].filter((v) => v.length >= 4);
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Values that are references or placeholders, not secrets: ${VAR}, $VAR, {{x}}, <your-key>, ***, xxxx, empty. */
function isReferenceOrPlaceholder(v: string): boolean {
  const s = v.trim();
  if (s.length === 0) return true;
  if (/^\\?\$\{?[A-Za-z_][A-Za-z0-9_]*(?::?-[^}]*)?\}?$/.test(s)) return true;
  if (/^\$\(.*\)$/.test(s)) return true;
  if (/^\{\{.*\}\}$/.test(s) || /^<[^<>]*>$/.test(s)) return true;
  if (/^(.)\1+$/.test(s)) return true; // ***** / xxxxxx / 000000
  if (/^\[REDACTED[:\]\\]/.test(s)) return true;
  if (/^(null|none|nil|undefined|true|false|changeme|redacted|placeholder|example|your[-_].*|<redacted>)$/i.test(s)) return true;
  return false;
}

/** Looks like code rather than a literal: function call, attribute/index access, env lookup. */
function looksLikeCode(v: string): boolean {
  return /[()[\]]/.test(v) || /^(os\.|process\.env|env\.|getenv|self\.|this\.|config\.|settings\.)/.test(v);
}

/** `other_var`, `getToken`, `self.pw`, `api_key2`: code identifiers, not literals. Values with digits mixed in are not. */
function looksLikeIdentifierValue(v: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(v)) return false;
  if (!/[0-9]/.test(v) || v.includes(".")) return true;
  if (/^[A-Za-z_]+[0-9]{1,3}$/.test(v)) return true;
  return isWordyCompound(v);
}

const SECRETISH_KEY =
  /(secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|auth[_-]?key|signing[_-]?key|session[_-]?key|encryption[_-]?key|master[_-]?key)/i;

/** Identifier-ish words that contain a secret-ish fragment but name non-secret things. */
const SECRETISH_KEY_EXCLUDE =
  /(^|_)(max|min|num|count|len|length|type|kind|name|id|path|file|dir|url|uri|endpoint|header|prefix|limit|budget|usage|expires?|ttl|reset|hint|policy|field|label|prompt|required|enabled|changed|placeholder)(_|$)|tokens?_(count|limit|budget|usage)|tokens$|(input|output|completion|prompt|max)_tokens?/i;

export function isSecretishKey(key: string): boolean {
  return SECRETISH_KEY.test(key) && !SECRETISH_KEY_EXCLUDE.test(key);
}

function stripQuotes(v: string): { value: string; offset: number } {
  const m = /^(["'`])(.*)\1$/s.exec(v);
  return m ? { value: m[2]!, offset: 1 } : { value: v, offset: 0 };
}

// KW IDs (evt_<64hex>, evd_xxx, fnd_xxx ...) are never secrets.
const KW_ID = /^(run|pol|evt|evd|fnd|fsc|sg|ver|cor)_[A-Za-z0-9_-]+$/;
/**
 * Public, non-secret identifiers that are high-entropy by construction and matter for correlation: Claude Code / Anthropic
 * tool-use, message and request ids, OpenAI-style completion ids. Exempt from the entropy heuristic only (format
 * detectors still apply).
 */
const NON_SECRET_ID = /^(toolu|msg|req|chatcmpl|call|resp|srvtoolu|file|batch)[_-][A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function insideUrlPath(text: string, idx: number): boolean {
  let s = idx;
  while (s > 0 && !/[\s"'`<>()[\]]/.test(text[s - 1]!)) s--;
  const prefix = text.slice(s, idx);
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(prefix) && !prefix.includes("?") && !prefix.includes("#");
}

const WORDY_PART = /^(?:[a-z]+[0-9]*[a-z]*|[0-9]+|[A-Z][a-z]+[0-9]*|[A-Z]{1,5}[0-9]*)$/;
function isWordyCompound(tok: string): boolean {
  const parts = tok.split(/[-_/.]+/).filter(Boolean);
  return parts.length >= 2 && parts.every((p) => p.length <= 14 && WORDY_PART.test(p));
}


// Decoding helpers for the encoded_secret detector (no Buffer/atob: this package has no DOM or node types).
const B64_INDEX: Record<string, number> = Object.fromEntries([...B64].map((c, i) => [c, i]));

function bytesToLatin1(bytes: number[]): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function decodeBase64(tok: string): number[] | null {
  const t = tok.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]+$/.test(t) || t.length % 4 === 1) return null;
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const c of t) {
    buf = (buf << 6) | B64_INDEX[c]!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

/** Mostly printable ASCII (tabs/newlines allowed): decoded binary noise is not scanned. */
function looksPrintable(s: string): boolean {
  if (s.length < 8) return false;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x20 && c < 0x7f) || c === 9 || c === 10 || c === 13) ok++;
  }
  return ok / s.length >= 0.95;
}

export function decodeCandidates(tok: string): string[] {
  const out: string[] = [];
  const hex = tok.replace(/^0x/i, "");
  if (hex.length >= 32 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)) {
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    const s = bytesToLatin1(bytes);
    if (looksPrintable(s)) out.push(s);
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(tok) && tok.length >= 20) {
    const bytes = decodeBase64(tok);
    if (bytes) {
      const s = bytesToLatin1(bytes);
      if (looksPrintable(s)) out.push(s);
    }
  }
  if (/%[0-9A-Fa-f]{2}/.test(tok)) {
    try {
      out.push(decodeURIComponent(tok));
    } catch {
      /* malformed escape: not a candidate */
    }
  }
  return out;
}

/** Runs every non-heuristic detector except encoded_secret itself on a decoded candidate. */
function decodedContainsSecret(decoded: string, ctx: DetectorContext): boolean {
  for (const d of DETECTORS) {
    if (d.confidence === "heuristic" || d.id === "encoded_secret" || d.id === "split_secret") continue;
    if (d.find(decoded, ctx).length > 0) return true;
  }
  return false;
}


/** Absolute/relative filesystem path: starts with / ~/ ./ ../ (after optional ':' or '=' context) and has word segments. */
function looksLikeFsPath(tok: string, text: string, idx: number): boolean {
  if (!/^(?:\/|~\/|\.\.?\/)/.test(tok) && !(text[idx - 1] === "~" || text[idx - 1] === ".")) return false;
  const segs = tok.split("/").filter(Boolean);
  return segs.length >= 2 && segs.filter((x) => /^[A-Za-z][a-z]+$/.test(x)).length >= 1;
}

function isHighEntropyToken(tok: string, index: number, text: string, ctx: DetectorContext): boolean {
  if (tok.length < ctx.entropyMinLength) return false;
  if (KW_ID.test(tok) || NON_SECRET_ID.test(tok) || UUID.test(tok)) return false;
  const before = text.slice(Math.max(0, index - 8), index);
  if (/(sha1|sha256|sha384|sha512|md5)[-:]$/i.test(before) || /^(sha1|sha256|sha384|sha512|md5)-/i.test(tok)) return false; // integrity strings, content digests
  if (/^[A-Za-z]+[0-9]{1,3}$/.test(tok)) return false; // identifiers like fooBarBaz2 (random tokens rarely put every digit at the end)
  if (/^[0-9a-fA-F]+$/.test(tok)) {
    if (tok.length === 40 || tok.length === 64) return false; // git object ids, sha256 digests
    if (tok.length < 32) return false;
    return shannonEntropy(tok) >= ctx.hexEntropyThreshold;
  }
  // Inside a URL path (scheme://host/... before any '?'): page slugs and commit links, not credentials.
  if (insideUrlPath(text, index)) return false;
  // KEY=VALUE pairs and CLI flags are handled by the assignment detector; base64 only has '=' as trailing padding.
  if (/=[^=]/.test(tok) || tok.startsWith("--")) return false;
  // Path-like / compound identifiers made of word-ish parts (claude-agent-sdk-win32-x64) are not secret-shaped.
  if (isWordyCompound(tok)) return false;
  if (!/[0-9]/.test(tok) || !/[A-Za-z]/.test(tok)) return false;
  if (/^[A-Za-z]+(?:[_-][A-Za-z0-9]+)+$/.test(tok) && !/[A-Z].*[0-9]|[0-9].*[A-Z]/.test(tok)) return false; // snake/kebab identifiers
  return shannonEntropy(tok) >= ctx.entropyThreshold;
}

/** `Cookie: a=b; c=d` / `Set-Cookie: sid=...`: every cookie VALUE of 8+ characters is redacted (names are kept). */
function cookieValueSpans(text: string): Span[] {
  const out: Span[] = [];
  const header = /(?<![A-Za-z0-9-])(?:set-)?cookie["']?\s*:\s*([^\r\n"']*)/gi;
  let m: RegExpExecArray | null;
  while ((m = header.exec(text)) !== null) {
    const listStart = m.index + m[0].length - m[1]!.length;
    const pair = /(?:^|;)\s*([^=;\s]+)=([^;\s]*)/g;
    let p: RegExpExecArray | null;
    while ((p = pair.exec(m[1]!)) !== null) {
      const name = p[1]!;
      const value = p[2]!;
      if (/^(path|domain|expires|max-age|samesite|priority)$/i.test(name) || value.length < 8 || isReferenceOrPlaceholder(value)) continue;
      const vs = listStart + p.index + p[0].length - value.length;
      out.push({ detector: "auth_header", start: vs, end: vs + value.length, priority: P.structural });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// split_secret: secrets wrapped across lines (fold -w N, base64 -w 76, xxd / hexdump -C ASCII columns, xxd -p hex)

/** Detectors re-run on the line-joined view. Only precise, prefix/format-anchored ones (no key=value or heuristics). */
const SPLIT_INNER: readonly DetectorId[] = [
  "synthetic_secret",
  "known_secret",
  "jwt",
  "aws_access_key",
  "github_token",
  "gitlab_token",
  "anthropic_key",
  "openai_style_key",
  "slack_token",
  "encoded_secret",
  "custom_pattern",
];

interface LinePiece {
  /** Range in the original text that contributes to the joined view. */
  start: number;
  end: number;
  /** Hex column of a hexdump line (also redacted when the ASCII column holds part of a secret). */
  hex?: { start: number; end: number };
}

/** `00000010: 485f 544f 4b45 4e3d  H_TOKEN=` (xxd) or `00000010  48 5f 54 4f  |H_TO|` (hexdump -C). */
function parseDumpLine(line: string, base: number): LinePiece | null {
  const c = /^([0-9a-fA-F]{6,16})((?:\s+[0-9a-fA-F]{2}){1,16})\s+\|(.{1,16})\|\s*$/.exec(line);
  if (c) {
    const hexStart = base + c[1]!.length;
    const asciiStart = base + line.lastIndexOf("|", line.length - 2) + 1;
    return { start: asciiStart, end: asciiStart + c[3]!.length, hex: { start: hexStart, end: hexStart + c[2]!.length } };
  }
  const x = /^[0-9a-fA-F]{6,16}: /.exec(line);
  if (!x) return null;
  const rest = line.slice(x[0].length).replace(/\r$/, "");
  for (let k = Math.min(16, rest.length); k >= 1; k--) {
    const ascii = rest.slice(rest.length - k);
    const hexPart = rest.slice(0, rest.length - k);
    if (!/ $/.test(hexPart)) continue;
    const hex = hexPart.replace(/ /g, "");
    // n >= k: a raw control byte (e.g. a newline printed verbatim instead of '.') can shorten the ASCII column.
    if (hex.length % 2 !== 0 || hex.length < 2 * k || hex.length > 32 || !/^[0-9a-fA-F]+$/.test(hex)) continue;
    let ok = true;
    for (let i = 0; i < k && ok; i++) {
      const b = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
      if (b >= 0x20 && b < 0x7f && ascii[i] !== String.fromCharCode(b)) ok = false;
    }
    if (!ok) continue;
    const asciiStart = base + x[0].length + hexPart.length;
    return { start: asciiStart, end: asciiStart + k, hex: { start: base + x[0].length, end: base + x[0].length + hexPart.trimEnd().length } };
  }
  return null;
}

function splitSecretSpans(text: string, ctx: DetectorContext): Span[] {
  if (!text.includes("\n")) return [];
  const pieces: LinePiece[] = [];
  let base = 0;
  for (const line of text.split("\n")) {
    const dump = parseDumpLine(line, base);
    if (dump) pieces.push(dump);
    else {
      const lead = /^\s*/.exec(line)![0].length;
      const trail = /\s*$/.exec(line.slice(lead))![0].length;
      pieces.push({ start: base + lead, end: base + line.length - trail });
    }
    base += line.length + 1;
  }
  if (pieces.length < 2) return [];
  // Joined view + offset maps.
  const joinedStart: number[] = [];
  let joined = "";
  for (const p of pieces) {
    joinedStart.push(joined.length);
    joined += text.slice(p.start, p.end);
  }
  const lineOf = (j: number) => {
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (joinedStart[mid]! <= j) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const width = (i: number) => pieces[i]!.end - pieces[i]!.start;
  const out: Span[] = [];
  for (const d of DETECTORS) {
    if (!SPLIT_INNER.includes(d.id)) continue;
    for (const sp of d.find(joined, ctx)) {
      const li = lineOf(sp.start);
      const lj = lineOf(sp.end - 1);
      if (li === lj) continue; // a single-line match is found by the detector itself on the original text
      // Wrapped output has fixed-width lines: every line but the last has the same width. Two-line matches also need
      // the line before to share that width (or a hexdump line), so `env` output (one secret per line) is not glued.
      const w = width(li);
      if (w < 8) continue;
      let wrapped = true;
      for (let k = li; k < lj; k++) if (width(k) !== w) wrapped = false;
      // The last line may be wider when the match ran on into unrelated text; accept that only with 2+ full lines.
      if (width(lj) > w && lj - li < 2) wrapped = false;
      if (wrapped && lj - li === 1 && !pieces[li]!.hex && !(li > 0 && width(li - 1) === w)) wrapped = false;
      if (!wrapped) continue;
      for (let k = li; k <= lj; k++) {
        const p = pieces[k]!;
        const from = Math.max(sp.start, joinedStart[k]!) - joinedStart[k]!;
        const to = Math.min(sp.end, joinedStart[k]! + width(k)) - joinedStart[k]!;
        if (to > from) out.push({ detector: "split_secret", start: p.start + from, end: p.start + to, priority: P.specific });
        if (p.hex && p.hex.end > p.hex.start) out.push({ detector: "split_secret", start: p.hex.start, end: p.hex.end, priority: P.specific });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// detectors

const P = {
  exact: 100,
  privateKey: 95,
  specific: 80,
  anthropic: 82,
  structural: 70,
  assignment: 60,
  encoded: 75,
  heuristic: 10,
} as const;

export const DETECTORS: readonly DetectorDef[] = [
  {
    id: "synthetic_secret",
    confidence: "exact",
    priority: P.exact,
    find(text, ctx) {
      const out: Span[] = [];
      const reg = ctx.registry;
      if (reg.names.length > 0) {
        const names = reg.names.map(escapeRegex).join("|");
        // NAME=value / NAME: value / "NAME": "value" -> redact the value only.
        const re = new RegExp(`(?<![A-Za-z0-9_])(?:${names})["']?\\s*[=:]\\s*(["']?)([^\\s"'\`,;]+)\\1`);
        out.push(...spansFor("synthetic_secret", P.exact, text, re, 2, (v) => !isReferenceOrPlaceholder(v)));
      }
      for (const re of reg.value_patterns) out.push(...spansFor("synthetic_secret", P.exact, text, re));
      for (const v of reg.values) for (const variant of secretVariants(v)) out.push(...spansFor("synthetic_secret", P.exact, text, new RegExp(escapeRegex(variant))));
      return out;
    },
  },
  {
    id: "known_secret",
    confidence: "exact",
    priority: P.exact,
    find(text, ctx) {
      const out: Span[] = [];
      for (const v of ctx.knownSecrets) {
        if (v.length < 6) continue; // refuse to match trivially short "secrets" everywhere
        for (const variant of secretVariants(v)) out.push(...spansFor("known_secret", P.exact, text, new RegExp(escapeRegex(variant))));
      }
      return out;
    },
  },
  {
    id: "private_key",
    confidence: "pattern",
    priority: P.privateKey,
    find(text) {
      const out: Span[] = [];
      // Keep the BEGIN/END armor lines (structure); redact the body. Unterminated blocks are redacted to end of text.
      const re = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const bodyStart = m.index + m[0].length;
        const endMarker = `-----END ${m[1]}-----`;
        const endIdx = text.indexOf(endMarker, bodyStart);
        const bodyEnd = endIdx === -1 ? text.length : endIdx;
        // Preserve line breaks (raw or JSON-escaped at any depth) right after BEGIN and before END so structure survives.
        const body = text.slice(bodyStart, bodyEnd);
        const lead = /^(?:\s|\\+[nr])+/.exec(body)?.[0].length ?? 0;
        const trail = /(?:\s|\\+[nr])+$/.exec(body.slice(lead))?.[0].length ?? 0;
        const s = bodyStart + lead;
        const e = bodyEnd - trail;
        // Already redacted (e.g. the egress guard re-scanning a redacted, re-encoded payload): real key bodies never start with a marker.
        const alreadyRedacted = /^\[REDACTED(?::|\\+:)/.test(text.slice(s, e));
        if (e > s && !alreadyRedacted) out.push({ detector: "private_key", start: s, end: e, priority: P.privateKey });
        re.lastIndex = endIdx === -1 ? text.length : endIdx + endMarker.length;
      }
      return out;
    },
  },
  {
    id: "jwt",
    confidence: "pattern",
    priority: P.specific,
    find: (text) => spansFor("jwt", P.specific, text, /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/),
  },
  {
    id: "aws_access_key",
    confidence: "pattern",
    priority: P.specific,
    find: (text) => spansFor("aws_access_key", P.specific, text, /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/),
  },
  {
    id: "aws_secret_key",
    confidence: "pattern",
    priority: P.specific,
    find: (text) =>
      spansFor("aws_secret_key", P.specific, text, /(?:aws_?secret_?access_?key|aws_?secret_?key|secretAccessKey)["']?\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i, 1),
  },
  {
    id: "github_token",
    confidence: "pattern",
    priority: P.specific,
    find: (text) => [
      ...spansFor("github_token", P.specific, text, /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/),
      ...spansFor("github_token", P.specific, text, /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/),
    ],
  },
  {
    id: "gitlab_token",
    confidence: "pattern",
    priority: P.specific,
    find: (text) => spansFor("gitlab_token", P.specific, text, /\bgl(?:pat|ptt|dt|rt|cbt|imt|oas|soat|ft|agent)-[A-Za-z0-9_-]{20,}/),
  },
  {
    id: "anthropic_key",
    confidence: "pattern",
    priority: P.anthropic,
    find: (text) => spansFor("anthropic_key", P.anthropic, text, /\bsk-ant-[A-Za-z0-9_-]{20,}/),
  },
  {
    id: "openai_style_key",
    confidence: "pattern",
    priority: P.specific,
    // OpenAI-style `sk-` keys; ai& keys also start with `sk-` (ai& docs, /authentication/).
    find: (text) => spansFor("openai_style_key", P.specific, text, /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/),
  },
  {
    id: "slack_token",
    confidence: "pattern",
    priority: P.specific,
    find: (text) => [
      ...spansFor("slack_token", P.specific, text, /\bxox[abposr]-[A-Za-z0-9-]{10,}/),
      ...spansFor("slack_token", P.specific, text, /\bxapp-\d-[A-Za-z0-9-]{10,}/),
      ...spansFor("slack_token", P.specific, text, /https:\/\/hooks\.slack\.com\/services\/(T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+)/, 1),
    ],
  },
  {
    id: "url_credentials",
    confidence: "pattern",
    priority: P.structural,
    // scheme://user:password@host -> redact the password only.
    find: (text) => spansFor("url_credentials", P.structural, text, /(?<![a-zA-Z0-9+.-])[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@'"<>]+:([^@\s/'"<>]+)@/, 1, (v) => !isReferenceOrPlaceholder(v)),
  },
  {
    id: "auth_header",
    confidence: "pattern",
    priority: P.structural,
    find: (text) => [
      ...spansFor("auth_header", P.structural, text, /\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{8,})/i, 1, (v) => !isReferenceOrPlaceholder(v)),
      ...spansFor("auth_header", P.structural, text, /\bx-(?:api|auth)-key["']?\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})/i, 1, (v) => !isReferenceOrPlaceholder(v)),
      // Other well-known credential headers (GitLab PRIVATE-TOKEN, X-Token, X-Auth-Token, X-Vault-Token ...). A known
      // header context, so low-entropy values are redacted too.
      ...spansFor(
        "auth_header",
        P.structural,
        text,
        /(?<![A-Za-z0-9-])(?:private-token|x-(?:access-|auth-|api-|gitlab-|vault-|csrf-|xsrf-)?token|api-key|x-amz-security-token|x-goog-api-key)["']?\s*:\s*["']?([A-Za-z0-9._~+/=-]{6,})/i,
        1,
        (v) => !isReferenceOrPlaceholder(v),
      ),
      ...cookieValueSpans(text),
      ...spansFor("auth_header", P.structural, text, /(?:^|[\s"'])(?:-u|--user)\s+["']?[^\s:"']+:([^\s"'@]{4,})/, 1, (v) => !isReferenceOrPlaceholder(v) && !/^\d+$/.test(v)),
    ],
  },
  {
    id: "env_secret_value",
    confidence: "pattern",
    priority: P.assignment,
    find(text) {
      const out: Span[] = [];
      // 1. dotenv / shell assignment: NAME=value (no spaces around '='), e.g. `.env` lines, `export X=..`, `X=.. cmd`.
      const envRe = /(?<![A-Za-z0-9_.$-])([A-Za-z_][A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s"'`;&|]+)/gd;
      let m: RegExpExecArray | null;
      while ((m = envRe.exec(text)) !== null) {
        const key = m[1]!;
        if (!isSecretishKey(key)) continue;
        const { value, offset } = stripQuotes(m[2]!);
        if (isReferenceOrPlaceholder(value) || looksLikeCode(value)) continue;
        // lower-case keys (code like `token=other_var`, `password=self.pw`) need a literal-looking value. Only clearly
        // code-like identifiers are exempt; a random-looking value (digits mixed in, e.g. `access_token=Ab3x9Q...`,
        // `_authToken=npm_...`) is still a secret.
        if (key !== key.toUpperCase() && offset === 0 && looksLikeIdentifierValue(value)) continue;
        if (value.length < 4) continue;
        const vs = m.indices![2]![0] + offset;
        out.push({ detector: "env_secret_value", start: vs, end: vs + value.length, priority: P.assignment });
      }
      // 2. quoted literal assigned to a secret-ish key in JSON / YAML / code: "api_key": "....", password = 'xxx'
      // The lookbehind anchors the key at a word start: without it a long identifier run is rescanned from every offset (O(n^2)).
      const kvRe = /(["']?)(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]*[A-Za-z0-9])\1\s*(?::|=|:=|=>)\s*(["'])([^"'\r\n]{6,}?)\3/gd;
      while ((m = kvRe.exec(text)) !== null) {
        const key = m[2]!;
        if (!isSecretishKey(key)) continue;
        const value = m[4]!;
        if (isReferenceOrPlaceholder(value) || /\s/.test(value.trim()) && value.length > 60) continue;
        const [vs, ve] = m.indices![4]!;
        out.push({ detector: "env_secret_value", start: vs, end: ve, priority: P.assignment });
      }
      // 2b. URL query parameters that carry credentials under short names (?sig=, ?key=, ?code=, X-Amz-Signature=).
      const qRe = /[?&](?:sig|signature|key|apikey|code|auth|x-amz-signature|x-amz-credential|x-amz-security-token)=([^&#\s"'<>]{8,})/gid;
      while ((m = qRe.exec(text)) !== null) {
        const [vs, ve] = m.indices![1]!;
        if (!isReferenceOrPlaceholder(m[1]!)) out.push({ detector: "env_secret_value", start: vs, end: ve, priority: P.assignment });
      }
      // 3. YAML-ish unquoted: `  password: hunter22` on its own line.
      const yamlRe = /^[ \t-]*([A-Za-z0-9_.-]+):[ \t]+([^\s"'#{[][^\s#;,]{5,})[ \t]*$/gmd;
      while ((m = yamlRe.exec(text)) !== null) {
        const key = m[1]!;
        if (!isSecretishKey(key)) continue;
        const value = m[2]!;
        if (isReferenceOrPlaceholder(value) || looksLikeCode(value)) continue;
        const [vs, ve] = m.indices![2]!;
        out.push({ detector: "env_secret_value", start: vs, end: ve, priority: P.assignment });
      }
      return out;
    },
  },
  {
    id: "encoded_secret",
    confidence: "pattern",
    priority: P.encoded,
    find(text, ctx) {
      // base64 / base64url / hex / percent-encoded tokens whose DECODED form contains a secret (one decoding level).
      const out: Span[] = [];
      const re = /(?<![A-Za-z0-9+/_%=-])[A-Za-z0-9+/_%=-]{20,}(?![A-Za-z0-9+/_%=-])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const whole = m[0];
        // `name=<encoded>`: also try the value after the last non-padding '='.
        const eq = /^(.*[^=])=(?!=*$)/.exec(whole);
        const parts = eq ? [{ tok: whole, off: 0 }, { tok: whole.slice(eq[0].length), off: eq[0].length }] : [{ tok: whole, off: 0 }];
        for (const { tok, off } of parts) {
          if (tok.length < 20 || KW_ID.test(tok) || NON_SECRET_ID.test(tok) || UUID.test(tok)) continue;
          if (decodeCandidates(tok).some((decoded) => decodedContainsSecret(decoded, ctx))) {
            out.push({ detector: "encoded_secret", start: m.index + off, end: m.index + off + tok.length, priority: P.encoded });
            break;
          }
        }
      }
      return out;
    },
  },
  {
    id: "custom_pattern",
    confidence: "pattern",
    priority: P.specific,
    find(text, ctx) {
      const out: Span[] = [];
      for (const p of ctx.customPatterns) out.push(...spansFor("custom_pattern", P.specific, text, p.re, p.group, (v) => v.length > 0));
      return out;
    },
  },
  {
    id: "split_secret",
    confidence: "pattern",
    priority: P.specific,
    find: (text, ctx) => splitSecretSpans(text, ctx),
  },
  {
    id: "high_entropy",
    confidence: "heuristic",
    priority: P.heuristic,
    find(text, ctx) {
      const out: Span[] = [];
      const re = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]+(?![A-Za-z0-9+/_=-])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const tok = m[0];
        if (tok.length < ctx.entropyMinLength) continue;
        if (looksLikeFsPath(tok, text, m.index)) {
          // Judge each path segment on its own: a temp dir with a UUID or hash segment is not a secret, but a secret
          // used as a path segment still is (and only that segment is redacted, keeping the path's structure).
          let off = m.index;
          for (const seg of tok.split("/")) {
            if (isHighEntropyToken(seg, off, text, ctx)) out.push({ detector: "high_entropy", start: off, end: off + seg.length, priority: P.heuristic });
            off += seg.length + 1;
          }
          continue;
        }
        if (isHighEntropyToken(tok, m.index, text, ctx)) out.push({ detector: "high_entropy", start: m.index, end: m.index + tok.length, priority: P.heuristic });
      }
      return out;
    },
  },
];

export const DETECTOR_CONFIDENCE: Record<DetectorId, DetectorConfidence> = Object.fromEntries(DETECTORS.map((d) => [d.id, d.confidence])) as Record<
  DetectorId,
  DetectorConfidence
>;
