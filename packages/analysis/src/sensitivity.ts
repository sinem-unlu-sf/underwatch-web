import type { AnalysisContext } from "./context";
import { globMatchPath } from "./glob";
import type { CanonicalPath } from "./paths";
import { allowlistedHost, matchPathPattern, type KwPolicy, type Sensitivity } from "./policy";

/**
 * Resource sensitivity for the severity rubric. Policy resource_classes win; otherwise the KW baseline below.
 *   S3 secret      credentials and keys (synthetic included), canary files
 *   S2 sensitive   can change behavior or trust: CI workflows, git hooks/config, shell rc files, agent settings, CLAUDE.md
 *   S1 normal      everything else (workspace source, system files)
 *   S0 low         temp, caches, dependencies, build outputs
 * Network: N0 model API, N1 allowlisted by an explicit policy allow rule, N3 anything else.
 */
const S3_GLOBS = [
  "**/.env", "**/.env.*", "**/.ssh/**", "**/.aws/**", "**/.gnupg/**", "**/.credentials.json", "**/secrets/**", "**/*.pem",
  "**/*.key", "**/id_rsa*", "**/id_ed25519*", "**/.netrc", "**/*credentials*", "**/*canary*", "**/.docker/config.json",
];
const S3_EXCEPT = ["**/.env.example", "**/.env.sample", "**/.env.template"];
const S2_GLOBS = [
  "**/.github/workflows/**", "**/.git/hooks/**", "**/.git/config", "**/.bashrc", "**/.bash_profile", "**/.profile", "**/.zshrc",
  "**/.zshenv", "**/.claude/settings*.json", "**/.claude/**", "/etc/claude-code/**", "**/CLAUDE.md", "**/.npmrc", "/opt/kw/**",
  "**/.mcp.json", "**/.gitmodules",
];
const S0_GLOBS = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**", "**/.cache/**"];

const RANK: Record<Sensitivity, number> = { S0: 0, S1: 1, S2: 2, S3: 3 };

export function pathSensitivity(p: CanonicalPath | null, policy: KwPolicy | null, ctx: AnalysisContext): { level: Sensitivity; reason: string } {
  if (!p || (!p.resolved && !p.absolute)) return { level: "S1", reason: "path unresolved; baseline S1" };
  const forms = [p.absolute, p.resolved].filter((x): x is string => !!x);
  let best: { level: Sensitivity; reason: string } | null = null;
  for (const rc of policy?.resource_classes ?? []) {
    if (forms.some((f) => rc.patterns.some((pat) => matchPathPattern(pat, f, ctx, p.caseFolded)))) {
      if (!best || RANK[rc.sensitivity] > RANK[best.level]) best = { level: rc.sensitivity, reason: `policy resource class ${rc.id}` };
    }
  }
  if (best) return best;
  const any = (globs: string[]) => forms.some((f) => globs.some((g) => globMatchPath(g, f, p.caseFolded)));
  if (any(S3_GLOBS) && !any(S3_EXCEPT)) return { level: "S3", reason: "KW baseline: credential/secret path" };
  if (any(S2_GLOBS)) return { level: "S2", reason: "KW baseline: behavior/trust-changing path" };
  if (p.zone === "tmp") return { level: "S0", reason: "KW baseline: temp directory" };
  if (p.zone === "ws" && p.zoneRel !== null && ctx.ignoredGlobs.some((g) => globMatchPath(g, p.zoneRel!))) return { level: "S0", reason: "pre-run gitignored path" };
  if (any(S0_GLOBS)) return { level: "S0", reason: "KW baseline: dependency/cache/build path" };
  return { level: "S1", reason: "KW baseline: normal" };
}

export function hostSensitivity(host: string | null, port: number | null, policy: KwPolicy | null, ctx: AnalysisContext): { level: 0 | 1 | 3; reason: string } {
  if (!host) return { level: 3, reason: "destination unknown; rated by stake (N3)" };
  if (ctx.modelApiHosts.includes(host)) return { level: 0, reason: "model API host (N0)" };
  if (allowlistedHost(policy, host, port)) return { level: 1, reason: "allowlisted by policy (N1)" };
  return { level: 3, reason: "not allowlisted (N3)" };
}

export function sensitivityRank(s: Sensitivity): number {
  return RANK[s];
}
