/**
 * Supervised-run policy overlays (permission_rule safeguards). Written ONLY under <dataDir>/policies/, never into a
 * user repository or the host's Claude Code settings. Append-only: one file per safeguard version, never rewritten.
 * The verification harness merges applied overlays into its per-run managed-settings.json.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ApiHttpError } from "../errors";

export interface PermissionRuleContent {
  deny: string[];
  ask: string[];
}

/** Claude Code permission rule string, e.g. Read(./.env), Edit(./secrets/**), Bash(curl:*). */
const RULE = /^(Read|Edit|Write|Bash|WebFetch|Glob|Grep)(\([^()\n]{1,200}\))?$/;

/** Parses and validates permission_rule content. Only deny/ask lists are accepted: a safeguard can never broaden permissions. */
export function parsePermissionRuleContent(content: string): PermissionRuleContent {
  let j: unknown;
  try {
    j = JSON.parse(content);
  } catch {
    throw new ApiHttpError("validation_error", 'permission_rule content must be JSON: {"permissions": {"deny": ["Read(./.env)"]}}');
  }
  const perms = (j as { permissions?: unknown })?.permissions;
  if (!perms || typeof perms !== "object" || Array.isArray(perms)) throw new ApiHttpError("validation_error", "permission_rule content needs a permissions object.");
  const keys = Object.keys(perms);
  const extra = keys.filter((k) => k !== "deny" && k !== "ask");
  if (extra.length) throw new ApiHttpError("validation_error", `Only permissions.deny and permissions.ask are allowed in a safeguard (found: ${extra.join(", ")}).`);
  if (Object.keys(j as object).length !== 1) throw new ApiHttpError("validation_error", "Only the permissions key is allowed in a safeguard.");
  const out: PermissionRuleContent = { deny: [], ask: [] };
  for (const k of ["deny", "ask"] as const) {
    const v = (perms as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !RULE.test(s))) {
      throw new ApiHttpError("validation_error", `permissions.${k} must be a list of Claude Code rules like "Read(./.env)".`);
    }
    out[k] = v as string[];
  }
  if (out.deny.length + out.ask.length === 0) throw new ApiHttpError("validation_error", "permission_rule content must contain at least one deny or ask rule.");
  return out;
}

export function policiesDir(dataDir: string): string {
  return path.join(dataDir, "policies");
}

export interface OverlayWrite {
  /** Path relative to the data dir (never absolute in API output). */
  rel_path: string;
  sha256: string;
  created: boolean;
}

/** Writes overlays/<safeguard>/v<n>.json exclusively. An existing file with identical content is accepted (idempotent). */
export function writePolicyOverlay(
  dataDir: string,
  input: { safeguard_id: string; version_id: string; version: number; rules: PermissionRuleContent; at: string },
): OverlayWrite {
  const dir = path.join(policiesDir(dataDir), "overlays", input.safeguard_id);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `v${input.version}.json`);
  const body = `${JSON.stringify(
    {
      kind: "underwatch.supervised-run-policy-overlay",
      applies_to: "Underwatch supervised/verification runs only (merged into the read-only managed-settings.json per run)",
      safeguard_id: input.safeguard_id,
      version_id: input.version_id,
      permissions: { deny: input.rules.deny, ask: input.rules.ask },
    },
    null,
    2,
  )}\n`;
  const sha = createHash("sha256").update(body).digest("hex");
  const rel = path.relative(dataDir, file);
  if (existsSync(file)) {
    const existing = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (existing !== sha) throw new ApiHttpError("conflict", `Policy overlay ${rel} already exists with different content; overlays are append-only.`);
    return { rel_path: rel, sha256: sha, created: false };
  }
  writeFileSync(file, body, { flag: "wx", mode: 0o644 });
  return { rel_path: rel, sha256: sha, created: true };
}
