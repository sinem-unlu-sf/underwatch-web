import { z } from "zod";
import { PolicyVersionId, Severity, type PolicyVersion } from "@kw/schema";
import type { AnalysisContext } from "./context";
import { globMatchPath, globMatchText } from "./glob";
import { basename, lexicalNormalize, pathForms, type CanonicalPath } from "./paths";

/**
 * Underwatch policy (JSON). Deny-first, order-independent decisions:
 *   explicit deny  >  explicit allow  >  explicit default  >  not covered.
 * An allow can never carve an exception out of a deny. Deny rules match if ANY path form (requested or resolved)
 * matches; allow rules only if ALL forms match (mirrors Claude Code's documented symlink semantics; doc-sourced,
 * UNVERIFIED in our container). There are no principals in v1: every rule applies to every agent-tree action.
 *
 * Path patterns must say where they are anchored:
 *   "ws:<glob>"   workspace-relative          "./<glob>" or bare "<glob>"  also workspace-relative
 *   "home:<glob>" / "~/<glob>"  home-relative "tmp:<glob>" temp-root relative
 *   "abs:<glob>" / "/<glob>"    absolute path in the container's view
 * Command patterns: "program:<name>" matches the observed argv[0] basename or process name; anything else is a text
 * glob over the whitespace-normalized command line (`*` spans spaces), tried against the raw line, the line with
 * argv[0] reduced to its basename, and the script of `sh -c '<script>'`.
 * Network patterns: "host", "host:port", "*.suffix[:port]", "*". Case-insensitive, trailing dot ignored.
 */
export const PolicyActionKind = z.enum(["file_read", "file_write", "command", "network"]);
export type PolicyActionKind = z.infer<typeof PolicyActionKind>;

export const KwPolicyRule = z.object({
  id: z.string().min(1),
  effect: z.enum(["allow", "deny"]),
  action: PolicyActionKind,
  patterns: z.array(z.string().min(1)).min(1),
  /** Declared severity for violations of this rule (used by the severity rubric instead of the matrix). */
  severity: Severity.nullable().default(null),
  description: z.string().default(""),
});
export type KwPolicyRule = z.infer<typeof KwPolicyRule>;

export const Sensitivity = z.enum(["S0", "S1", "S2", "S3"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const KwPolicy = z.object({
  kw_policy: z.literal(1),
  policy_id: z.string().min(1),
  /** Immutable version id ("pol_..."), the same id Findings cite in policy_id. */
  version_id: PolicyVersionId,
  version: z.string().min(1),
  rules: z.array(KwPolicyRule),
  defaults: z
    .object({
      file_read: z.enum(["allow", "deny"]),
      file_write: z.enum(["allow", "deny"]),
      command: z.enum(["allow", "deny"]),
      network: z.enum(["allow", "deny"]),
    })
    .partial()
    .default({}),
  /** Resource sensitivity classes for the severity rubric (path patterns as above). */
  resource_classes: z
    .array(z.object({ id: z.string().min(1), sensitivity: Sensitivity, patterns: z.array(z.string().min(1)) }))
    .default([]),
});
export type KwPolicy = z.infer<typeof KwPolicy>;
export type KwPolicyInput = z.input<typeof KwPolicy>;

export interface PolicyCompileIssue {
  rule_id: string;
  message: string;
}

const ACTION_ALIASES: Record<string, PolicyActionKind> = {
  file_read: "file_read", read: "file_read", Read: "file_read", "file.read": "file_read", file_open: "file_read",
  file_write: "file_write", write: "file_write", Write: "file_write", Edit: "file_write", MultiEdit: "file_write",
  "file.write": "file_write", file_delete: "file_write", file_create: "file_write",
  command: "command", process_exec: "command", exec: "command", "proc.exec": "command", Bash: "command", bash: "command",
  network: "network", network_connect: "network", net: "network", "net.egress": "network", egress: "network",
  WebFetch: "network", dns_query: "network",
};

/** Accept a native KW policy or a @kw/schema PolicyVersion (rules {effect, action, resource_pattern}). */
export function normalizePolicy(input: KwPolicy | PolicyVersion | null): { policy: KwPolicy | null; issues: PolicyCompileIssue[] } {
  if (input === null) return { policy: null, issues: [] };
  if ("kw_policy" in input) return { policy: KwPolicy.parse(input), issues: [] };
  const issues: PolicyCompileIssue[] = [];
  const rules: KwPolicyRule[] = [];
  for (const r of input.rules) {
    const action = ACTION_ALIASES[r.action];
    if (!action) {
      issues.push({ rule_id: r.id, message: `action "${r.action}" is not KW-evaluable (file_read, file_write, command, network); rule ignored` });
      continue;
    }
    if (r.effect === "ask") {
      issues.push({ rule_id: r.id, message: `"ask" rules are Claude Code UI semantics and are not KW-evaluable; rule ignored` });
      continue;
    }
    // UNVERIFIED convention: fixtures write alternatives as "a|b" in the single resource_pattern string. Split for
    // file and network rules (a path/host cannot sensibly contain "|"). Command patterns are kept literal because "|"
    // is also a shell pipe; splitting "curl * | sh" would create a deny on "sh".
    let patterns = [r.resource_pattern];
    if (action !== "command" && r.resource_pattern.includes("|")) patterns = r.resource_pattern.split("|").map((x) => x.trim()).filter(Boolean);
    if (action === "command" && /\S\|\S/.test(r.resource_pattern)) {
      issues.push({ rule_id: r.id, message: `command pattern contains "|"; matched literally (shell pipe), not as alternation` });
    }
    rules.push({ id: r.id, effect: r.effect, action, patterns, severity: null, description: r.description });
  }
  return {
    policy: { kw_policy: 1, policy_id: input.policy_id, version_id: input.id, version: input.version, rules, defaults: {}, resource_classes: [] },
    issues,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Matching

function relTo(path: string, root: string | null): string | null {
  if (!root) return null;
  const r = root.replace(/\/$/, "");
  if (path === r) return "";
  return path.startsWith(r + "/") ? path.slice(r.length + 1) : null;
}

export function matchPathPattern(pattern: string, absPath: string, ctx: AnalysisContext, caseFold: boolean): boolean {
  let anchor: "ws" | "home" | "tmp" | "abs";
  let glob: string;
  if (pattern.startsWith("ws:")) [anchor, glob] = ["ws", pattern.slice(3)];
  else if (pattern.startsWith("home:")) [anchor, glob] = ["home", pattern.slice(5)];
  else if (pattern.startsWith("tmp:")) [anchor, glob] = ["tmp", pattern.slice(4)];
  else if (pattern.startsWith("abs:")) [anchor, glob] = ["abs", pattern.slice(4)];
  else if (pattern.startsWith("~/")) [anchor, glob] = ["home", pattern.slice(2)];
  else if (pattern.startsWith("/")) [anchor, glob] = ["abs", pattern];
  else if (pattern.startsWith("./")) [anchor, glob] = ["ws", pattern.slice(2)];
  else [anchor, glob] = ["ws", pattern];
  if (anchor === "abs") return globMatchPath(lexicalNormalize(glob), absPath, caseFold);
  if (anchor === "tmp") {
    return ctx.tempRoots.some((t) => {
      const r = relTo(absPath, t);
      return r !== null && globMatchPath(glob, r, caseFold);
    });
  }
  const r = relTo(absPath, anchor === "ws" ? ctx.workspaceRoot : ctx.homeDir);
  return r !== null && globMatchPath(glob, r, caseFold);
}

function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, "");
}

/** Split "host:port" (IPv6 in brackets supported). */
export function splitHostPort(s: string): { host: string; port: number | null } {
  const t = s.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
  if (v6) return { host: v6[1]!.toLowerCase(), port: v6[2] ? Number(v6[2]) : null };
  const m = /^(.*?)(?::(\d+))?$/.exec(t)!;
  return { host: normalizeHost(m[1] ?? t), port: m[2] ? Number(m[2]) : null };
}

export function matchHostPattern(pattern: string, host: string, port: number | null, mode: "deny" | "allow"): boolean {
  if (pattern.trim() === "*") return true;
  const p = splitHostPort(pattern);
  const h = normalizeHost(host);
  let hostOk: boolean;
  if (p.host.startsWith("*.")) {
    const suffix = p.host.slice(2);
    hostOk = h.endsWith("." + suffix);
  } else hostOk = globMatchText(p.host, h, true);
  if (!hostOk) return false;
  if (p.port === null) return true;
  if (port === null) return mode === "deny"; // unknown port: a deny cannot be excluded, an allow cannot be confirmed
  return p.port === port;
}

function normalizeCommand(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Claude Code's Bash tool runs `bash -c "source <snapshot> ... && eval '<command>' < /dev/null && pwd -P >| <cwd file>"` (observed with
 * Tetragon in kw-agent:2.1.302, 2026-10-17). Returns the `<command>` with the shell's '"'"' quote escaping undone, so
 * the observed process can be compared with the reported command text. Null when the script has no such eval.
 */
export function claudeCodeEvalPayload(script: string): string | null {
  const m = /(?:^|&&\s*)eval '((?:[^']|'"'"')*)'(?:\s*<\s*\/dev\/null)?(?:\s*&&\s*pwd -P >\| \S+)?\s*$/.exec(script.trim());
  return m ? m[1]!.replace(/'"'"'/g, "'") : null;
}

/** All textual forms of a command a pattern is tried against. */
export function commandForms(command: string | null, argv: string[] | null): string[] {
  const forms = new Set<string>();
  const add = (s: string | null | undefined) => {
    if (s && s.trim()) forms.add(normalizeCommand(s));
  };
  if (argv && argv.length > 0) {
    add(argv.join(" "));
    add([basename(argv[0]!), ...argv.slice(1)].join(" "));
    const ci = argv.indexOf("-c");
    if (ci >= 0 && argv[ci + 1] !== undefined && ["bash", "sh", "dash", "zsh"].includes(basename(argv[0]!))) {
      add(argv[ci + 1]);
      const payload = claudeCodeEvalPayload(argv[ci + 1]!);
      if (payload) add(payload);
    }
  }
  add(command);
  if (command) {
    const parts = normalizeCommand(command).split(" ");
    if (parts[0]?.includes("/")) add([basename(parts[0]), ...parts.slice(1)].join(" "));
  }
  return [...forms].sort();
}

export interface PolicyAction {
  kind: PolicyActionKind;
  path: CanonicalPath | null;
  command: string | null;
  argv: string[] | null;
  processName: string | null;
  host: string | null;
  port: number | null;
}

export interface PolicyEvaluation {
  decision: "allow" | "deny" | "not_covered";
  step: "explicit_deny" | "explicit_allow" | "default" | "none";
  decidingRuleId: string | null;
  matchedRuleIds: string[];
  declaredSeverity: Severity | null;
  /** canonical: matched on canonical path / observed argv / host. requested_only: path could not be resolved. */
  matchBasis: "canonical" | "requested_only" | "none";
}

function ruleMatches(rule: KwPolicyRule, a: PolicyAction, ctx: AnalysisContext): boolean {
  if (rule.action !== a.kind) return false;
  if (a.kind === "file_read" || a.kind === "file_write") {
    if (!a.path) return false;
    const forms = pathForms(a.path);
    if (forms.length === 0) return false;
    const hit = (f: string) => rule.patterns.some((p) => matchPathPattern(p, f, ctx, a.path!.caseFolded));
    return rule.effect === "deny" ? forms.some(hit) : forms.every(hit);
  }
  if (a.kind === "command") {
    const forms = commandForms(a.command, a.argv);
    const names = new Set<string>();
    if (a.argv?.[0]) names.add(basename(a.argv[0]));
    if (a.processName) names.add(basename(a.processName));
    return rule.patterns.some((p) =>
      p.startsWith("program:") ? names.has(p.slice(8)) : forms.some((f) => globMatchText(normalizeCommand(p), f)),
    );
  }
  if (!a.host) return false;
  return rule.patterns.some((p) => matchHostPattern(p, a.host!, a.port, rule.effect));
}

export function evaluatePolicy(policy: KwPolicy | null, a: PolicyAction, ctx: AnalysisContext): PolicyEvaluation {
  const none: PolicyEvaluation = { decision: "not_covered", step: "none", decidingRuleId: null, matchedRuleIds: [], declaredSeverity: null, matchBasis: "none" };
  if (!policy) return none;
  const matched = policy.rules.filter((r) => ruleMatches(r, a, ctx));
  // A deny that matches the requested path is certain to apply (deny matches either form). Without symlink resolution
  // only allow/default decisions are uncertain: the resolved path might match a deny that the requested path does not.
  // DEVIATION from the design's rubric, which grades every requested-path-only match as medium.
  const unresolved = (a.kind === "file_read" || a.kind === "file_write") && !!a.path && a.path.method === "lexical_only" && a.path.limitations.length > 0;
  const denies = matched.filter((r) => r.effect === "deny");
  const basis: PolicyEvaluation["matchBasis"] = unresolved && denies.length === 0 ? "requested_only" : "canonical";
  if (denies.length > 0) {
    const severities = denies.map((r) => r.severity).filter((s): s is Severity => s !== null);
    const order = ["info", "low", "medium", "high", "critical"];
    const declared = severities.length ? severities.sort((x, y) => order.indexOf(y) - order.indexOf(x))[0]! : null;
    return { decision: "deny", step: "explicit_deny", decidingRuleId: denies[0]!.id, matchedRuleIds: matched.map((r) => r.id), declaredSeverity: declared, matchBasis: basis };
  }
  const allow = matched.find((r) => r.effect === "allow");
  if (allow) return { decision: "allow", step: "explicit_allow", decidingRuleId: allow.id, matchedRuleIds: matched.map((r) => r.id), declaredSeverity: null, matchBasis: basis };
  const def = policy.defaults[a.kind];
  if (def) return { decision: def, step: "default", decidingRuleId: `default:${a.kind}`, matchedRuleIds: [], declaredSeverity: null, matchBasis: basis };
  return none;
}

/** Hosts explicitly allowed for network egress (used for network sensitivity N1). */
export function allowlistedHost(policy: KwPolicy | null, host: string, port: number | null): boolean {
  if (!policy) return false;
  return policy.rules.some((r) => r.action === "network" && r.effect === "allow" && r.patterns.some((p) => matchHostPattern(p, host, port, "allow")));
}

// ---------------------------------------------------------------------------------------------------------------
// Classification

/**
 * allowed              policy allows the action
 * violation_blocked    denied by policy AND evidence shows an enforcement/permission block (EACCES/EPERM, proxy deny,
 *                      KW enforcement record, Claude Code permission denial with no observed action)
 * violation_completed  denied by policy AND the observed record shows completion (at the stated level only)
 * violation_failed     denied by policy, the attempt failed for a non-permission reason (e.g. ENOENT). DEVIATION from the
 *                      four classes in the task brief: calling this "blocked" would overclaim enforcement and calling it
 *                      "undetermined" would discard a known outcome.
 * undetermined         denied by policy but the outcome is not established (missing return, collectors disagree,
 *                      telemetry unavailable). Never reported as safe.
 */
export type PolicyClassification = "allowed" | "violation_blocked" | "violation_completed" | "violation_failed" | "undetermined";

export interface PolicyDecisionRecord {
  id: string;
  subject: "observed_action" | "reported_intent";
  logical_observation_id: string | null;
  tool_use_id: string | null;
  event_ids: string[];
  action: PolicyActionKind;
  resource: string;
  decision: "allow" | "deny";
  step: PolicyEvaluation["step"];
  deciding_rule_id: string | null;
  matched_rule_ids: string[];
  classification: PolicyClassification;
  outcome: string;
  blocked_by: string | null;
  policy_version_id: string;
  reason: string;
}

export function classify(decision: "allow" | "deny", outcome: "completed" | "blocked" | "failed" | "cannot_determine"): PolicyClassification {
  if (decision === "allow") return "allowed";
  switch (outcome) {
    case "completed":
      return "violation_completed";
    case "blocked":
      return "violation_blocked";
    case "failed":
      return "violation_failed";
    default:
      return "undetermined";
  }
}
