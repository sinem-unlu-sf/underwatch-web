import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AIAND_API_SURFACE, AiAndProvider, type AiAndConfig, type AiAndDeps, DEFAULT_AIAND_CONFIG, type StructuredMode } from "./providers/aiand";
import { type EndpointCheck, tlsVerificationProblem, validateAiAndEndpoint } from "./endpoint-policy";
import { NullProvider } from "./providers/null";
import type { InferenceProvider } from "./types";

/** Parse a dotenv file into a map. Values are returned to the caller only; nothing is logged. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2]!;
    const q = /^(["'])(.*)\1$/.exec(v);
    if (q) v = q[2]!;
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

/** Nearest ancestor containing pnpm-workspace.yaml (the monorepo root), or null. */
export function findWorkspaceRoot(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export interface LoadedAiAndConfig {
  config: Partial<AiAndConfig> & { apiKey: string | null };
  /** Names/paths only. */
  key_source: string | null;
  env_file: string | null;
  env_file_exists: boolean;
  /**
   * Result of the HTTPS/host endpoint policy at load time (reason only, never the raw URL). When not ok, the provider
   * built from this config refuses every call with reason "endpoint_rejected" and sends nothing.
   */
  endpoint: EndpointCheck;
}

/**
 * Resolve ai& settings. Key: AIAND_API_KEY from the process env, else from the env file (KW_ENV_FILE, default
 * <workspace root>/.env.local). Optional overrides: AIAND_BASE_URL, AIAND_MODEL, AIAND_REASONING_EFFORT ("" or "omit"
 * to not send it), AIAND_STRUCTURED_OUTPUT (json_schema|json_object|prompt_only), AIAND_TIMEOUT_MS, KW_INFERENCE_CACHE_DIR.
 */
export function loadAiAndConfig(opts: { env?: NodeJS.ProcessEnv; envFile?: string | null; cwd?: string } = {}): LoadedAiAndConfig {
  // Endpoint policy inputs (NODE_ENV, KW_ALLOW_INSECURE_AIAND_HTTP, KW_AIAND_ALLOWED_HOSTS) come from the process env only,
  // never from the env file. AIAND_BASE_URL itself may come from either and is validated below.
  const env = opts.env ?? process.env;
  const root = findWorkspaceRoot(opts.cwd);
  const envFile = opts.envFile !== undefined ? opts.envFile : (env.KW_ENV_FILE ?? (root ? join(root, ".env.local") : null));
  let fileVars: Record<string, string> = {};
  let exists = false;
  if (envFile && existsSync(envFile)) {
    exists = true;
    try {
      fileVars = parseDotenv(readFileSync(envFile, "utf8"));
    } catch {
      fileVars = {};
    }
  }
  const get = (k: string): string | undefined => {
    const v = env[k] ?? fileVars[k];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };
  const fromEnv = env[AIAND_API_SURFACE.key_env_var]?.trim();
  const key = get(AIAND_API_SURFACE.key_env_var) ?? null;
  const keySource = key === null ? null : fromEnv ? `${AIAND_API_SURFACE.key_env_var} (process env)` : `${AIAND_API_SURFACE.key_env_var} in ${envFile}`;

  const model = get("AIAND_MODEL") ?? DEFAULT_AIAND_CONFIG.model;
  const effortRaw = env.AIAND_REASONING_EFFORT ?? fileVars.AIAND_REASONING_EFFORT;
  // The default effort ("none") is only known-valid for the default model; for an overridden model without an explicit
  // effort we send nothing (the upstream default applies, which ai& warns can be the most expensive level).
  const reasoningEffort =
    effortRaw !== undefined ? (effortRaw.trim() === "" || effortRaw.trim() === "omit" ? null : effortRaw.trim()) : model === DEFAULT_AIAND_CONFIG.model ? DEFAULT_AIAND_CONFIG.reasoningEffort : null;
  const mode = get("AIAND_STRUCTURED_OUTPUT");
  const timeout = Number(get("AIAND_TIMEOUT_MS"));
  const rawBaseUrl = get("AIAND_BASE_URL") ?? DEFAULT_AIAND_CONFIG.baseUrl;
  const checked = validateAiAndEndpoint(rawBaseUrl, env);
  const tls = checked.ok ? tlsVerificationProblem(process.env, env) : null;
  const endpoint: EndpointCheck = tls ? { ok: false, reason: tls } : checked;

  return {
    config: {
      apiKey: key,
      // canonical URL when valid; otherwise the raw value is passed on so the provider re-rejects it (and never stores it)
      baseUrl: endpoint.ok ? endpoint.url : rawBaseUrl,
      model,
      reasoningEffort,
      structuredOutput: mode === "json_object" || mode === "prompt_only" || mode === "json_schema" ? (mode as StructuredMode) : DEFAULT_AIAND_CONFIG.structuredOutput,
      timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_AIAND_CONFIG.timeoutMs,
      configuredVia: keySource,
      cacheDir: get("KW_INFERENCE_CACHE_DIR") ?? null,
    },
    key_source: keySource,
    env_file: envFile,
    env_file_exists: exists,
    endpoint,
  };
}

/** AiAndProvider when a key is configured, NullProvider ("ai& not configured") otherwise. */
export function createInferenceProvider(opts: { env?: NodeJS.ProcessEnv; envFile?: string | null; cwd?: string; deps?: AiAndDeps } = {}): InferenceProvider {
  const loaded = loadAiAndConfig(opts);
  if (!loaded.config.apiKey) return new NullProvider("ai& not configured");
  // The same env that was used for load-time validation drives the per-request re-validation (unless a test injects one).
  const policyEnv = opts.deps?.policyEnv ?? (opts.env ? () => opts.env! : undefined);
  return new AiAndProvider(loaded.config, { ...opts.deps, ...(policyEnv ? { policyEnv } : {}) });
}
