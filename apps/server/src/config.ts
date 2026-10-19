import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
export const FIXTURE_RUNS_DIR = path.join(REPO_ROOT, "fixtures", "runs");
export const DEFAULT_DB_PATH = path.join(REPO_ROOT, "data", "kw.db");
/** Server-side secrets file (AIAND_API_KEY etc.). Read by the server only; never served. */
export const ENV_LOCAL_PATH = path.join(REPO_ROOT, ".env.local");

/** Filesystem locations used by the Ask Witness addendum. Overridable for tests via ServerPaths. */
export interface ServerPaths {
  repoRoot: string;
  dataDir: string;
  /** Disposable demo workspaces are created here (data/workspaces/<name>). */
  workspacesDir: string;
  /** Content-addressed blobs (file before/after, verification artifacts): data/evidence/blobs/<aa>/<sha256>. */
  blobsDir: string;
  /** Template copied into the demo workspace (synthetic secrets only). */
  demoTemplateDir: string;
  /** docker/ directory (agent image, egress proxy, compose file) for the verification harness. */
  dockerDir: string;
  /** Claude OAuth token file for the verification harness (read by the harness only, never logged). */
  claudeTokenFile: string;
}

export function defaultServerPaths(env: NodeJS.ProcessEnv = process.env): ServerPaths {
  const dataDir = path.resolve(env.KW_DATA_DIR?.trim() || path.join(REPO_ROOT, "data"));
  return {
    repoRoot: REPO_ROOT,
    dataDir,
    workspacesDir: path.join(dataDir, "workspaces"),
    blobsDir: path.join(dataDir, "evidence", "blobs"),
    demoTemplateDir: path.join(REPO_ROOT, "fixtures", "demo-repo-template"),
    dockerDir: path.join(REPO_ROOT, "docker"),
    claudeTokenFile: env.KW_CLAUDE_TOKEN_FILE?.trim() || defaultClaudeTokenFile(env.HOME ?? ""),
  };
}

/** ~/.underwatch/claude-oauth-token; falls back to the pre-rename ~/.kernel-witness/ location when only that exists. */
function defaultClaudeTokenFile(home: string): string {
  const current = path.join(home, ".underwatch", "claude-oauth-token");
  const legacy = path.join(home, ".kernel-witness", "claude-oauth-token");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export const SERVICE_VERSION = "0.1.0";
export const HOST = "127.0.0.1";
export const ALLOWED_ORIGINS = ["http://127.0.0.1:4601", "http://localhost:4601"];

/** Actor recorded for finding status changes made through the UI/API. */
export const UI_ACTOR = "developer";

/** Default proposal shown on the settings page; nothing enforces it yet. */
export const DEFAULT_RAW_EVIDENCE_RETENTION_DAYS = 30;

export interface DbLocation {
  path: string;
  configuredVia: string;
}

export function resolveDbLocation(env: NodeJS.ProcessEnv = process.env): DbLocation {
  const override = env.KW_DB_PATH?.trim();
  if (override) return { path: override === ":memory:" ? override : path.resolve(override), configuredVia: "KW_DB_PATH" };
  return { path: DEFAULT_DB_PATH, configuredVia: "default (data/kw.db)" };
}

export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.PORT ?? 4600);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT: ${env.PORT}`);
  return port;
}
