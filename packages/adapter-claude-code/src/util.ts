import { sha256Hex } from "@kw/schema";

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** JSON with object keys sorted recursively, for order-insensitive comparison and hashing. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (isObj(v)) {
    return (
      "{" +
      Object.keys(v)
        .sort()
        .filter((k) => v[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v) ?? "null";
}

export function shortHash(v: unknown): string {
  return sha256Hex(typeof v === "string" ? v : canonicalJson(v)).slice(0, 16);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Returns the value if it is an ISO-8601 timestamp the schema accepts, else null. */
export function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** Sortable numeric key for an ISO timestamp, keeping sub-millisecond digits (hook received_at has microseconds). */
export function timeKey(ts: string): number {
  const ms = Date.parse(ts);
  const frac = /\.(\d+)/.exec(ts)?.[1] ?? "";
  const subMs = frac.length > 3 ? Number("0." + frac.slice(3)) : 0;
  return ms + subMs;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Split JSONL text into lines (1-based numbering, blank lines skipped but counted). */
export function splitLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i]!.replace(/\r$/, "");
    if (t.trim() === "") continue;
    out.push({ line: i + 1, text: t });
  }
  return out;
}
