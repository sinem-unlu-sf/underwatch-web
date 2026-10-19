import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface GraphConfig {
  uri: string;
  user: string;
  /** Never logged, never included in errors or status output. */
  password: string;
  database: string;
  /** Where the values came from, safe to display ("env", or the .env.neo4j path). */
  configuredVia: string;
}

export type GraphConfigResult = { ok: true; config: GraphConfig } | { ok: false; missing: string[]; searched: string[] };

export const ENV_FILE_NAME = ".env.neo4j";

/** Minimal KEY=VALUE parser (no interpolation). Quotes around the value are stripped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2] ?? "";
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/** Walk up from `start` looking for .env.neo4j (stops at the filesystem root). */
export function findEnvFile(start: string): { found: string | null; searched: string[] } {
  const searched: string[] = [];
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, ENV_FILE_NAME);
    searched.push(candidate);
    if (existsSync(candidate)) return { found: candidate, searched };
    const parent = dirname(dir);
    if (parent === dir) return { found: null, searched };
    dir = parent;
  }
}

/**
 * Resolution order per key: process env (NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, NEO4J_DATABASE) wins, then the file
 * named by KW_NEO4J_ENV_FILE, else the nearest .env.neo4j walking up from `cwd`. NEO4J_DATABASE defaults to "neo4j".
 */
export function loadGraphConfig(opts: { env?: NodeJS.ProcessEnv; cwd?: string; envFile?: string } = {}): GraphConfigResult {
  const env = opts.env ?? process.env;
  let fileVals: Record<string, string> = {};
  let filePath: string | null = null;
  let searched: string[] = [];
  const explicit = opts.envFile ?? env.KW_NEO4J_ENV_FILE;
  if (explicit) {
    searched = [explicit];
    if (existsSync(explicit)) filePath = explicit;
  } else {
    const r = findEnvFile(opts.cwd ?? process.cwd());
    filePath = r.found;
    searched = r.searched;
  }
  if (filePath) fileVals = parseEnvFile(readFileSync(filePath, "utf8"));

  const pick = (k: string) => (env[k] && env[k] !== "" ? { v: env[k]!, from: "env" } : fileVals[k] ? { v: fileVals[k]!, from: filePath! } : null);
  const uri = pick("NEO4J_URI");
  const user = pick("NEO4J_USER");
  const password = pick("NEO4J_PASSWORD");
  const database = pick("NEO4J_DATABASE");
  const missing = [!uri && "NEO4J_URI", !user && "NEO4J_USER", !password && "NEO4J_PASSWORD"].filter((x): x is string => !!x);
  if (!uri || !user || !password) return { ok: false, missing, searched };
  const sources = new Set([uri.from, user.from, password.from]);
  return {
    ok: true,
    config: {
      uri: uri.v,
      user: user.v,
      password: password.v,
      database: database?.v ?? "neo4j",
      configuredVia: [...sources].join(" + "),
    },
  };
}
