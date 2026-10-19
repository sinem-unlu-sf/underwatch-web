import { sha256Hex } from "@kw/schema";

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order, no whitespace, `undefined` properties omitted.
 * Equivalent to RFC 8785 (JCS) for the value domain the engine emits (strings, finite integers, booleans, null,
 * arrays, plain objects). Non-integer or non-finite numbers are rejected so output never depends on float formatting.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(`canonicalJson: only finite integers are allowed, got ${String(value)}`);
      }
      return String(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",") + "]";
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Deterministic string comparison (code unit order, locale independent). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function uniqSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(cmpStr);
}
