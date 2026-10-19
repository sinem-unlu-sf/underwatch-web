/**
 * Claude Code settings generator: Underwatch policy -> Claude Code settings JSON.
 *
 * Produces two documents from the same policy:
 *  - managed: for /etc/claude-code/managed-settings.json, bind-mounted READ-ONLY into the agent container
 *    (docker/compose.agent.yml mounts KW_POLICY_DIR at /etc/claude-code:ro). Highest settings precedence;
 *    the agent cannot edit it. allowManagedHooksOnly / allowManagedPermissionRulesOnly make it the only
 *    source of hooks and permission rules, so edits to the repo's .claude/settings.json (which the agent
 *    performed in capture run3) cannot remove KW hooks or deny rules.
 *  - run: the same permissions + hooks for `claude --settings <file>` (flagSettings). Verified mechanism in
 *    capture run2 (debug.log: "Adding 6 allow rule(s) to destination 'flagSettings'"). Use for local runs
 *    without the managed tier. Never put it in the workspace: the agent can write there.
 *
 * Every key the generator can emit is listed in SETTINGS_KEY_REGISTRY with its evidence level.
 */
import { z } from "zod";
import type { PolicyRule, Safeguard } from "@kw/schema";
import {
  DEFAULT_CONTAINER_LAYOUT,
  DEFAULT_HOOK_EVENTS,
  IGNORED_PATH_RULE_TOOLS,
  KNOWN_TOOL_NAMES,
  isDocumentedHookEvent,
  type ContainerLayout,
  type HookEventName,
} from "./constants";

// ------------------------------------------------------------------------------------------------
// Key registry
// ------------------------------------------------------------------------------------------------

export type KeyStatus =
  /** Exercised in the Linux agent container (kw-agent:2.1.302) by this package; see test/fixtures/container. */
  | "verified_container"
  /** Exercised in the 2.1.302 captures (research/claude-code/probe-out). */
  | "verified_capture"
  /** Documented in the fetched docs but not exercised by us. */
  | "documented"
  /** Neither; an inference. Avoided by the generator. */
  | "assumed";

export interface KeyInfo {
  status: KeyStatus;
  evidence: string;
  /** Settings sources that may set the key (settings-reference.md "Scope"). */
  scope: "any" | "managed";
}

/** Paths use "." for objects, "<Event>" for any hook event and "[]" for array items. */
export const SETTINGS_KEY_REGISTRY: Readonly<Record<string, KeyInfo>> = {
  permissions: { status: "verified_capture", evidence: "probe run1-3 settings.json / kw-cli-settings.json", scope: "any" },
  "permissions.allow": {
    status: "verified_capture",
    evidence: "run2 debug.log: 6 allow rules added to flagSettings; run2 Write result permissionDecision reasonType \"rule\"",
    scope: "any",
  },
  "permissions.deny": {
    status: "verified_capture",
    evidence: "run1: Read(secrets/**) denied the Read tool and `cat secrets/token.txt` (non_execution_kind permission-rule)",
    scope: "any",
  },
  "permissions.ask": { status: "documented", evidence: "settings-reference.md permissions.ask", scope: "any" },
  "permissions.disableBypassPermissionsMode": {
    status: "documented",
    evidence: "managed-settings.md example; settings-reference.md (value \"disable\")",
    scope: "any",
  },
  hooks: {
    status: "verified_capture",
    evidence:
      "run1-3: every documented event wired; 13 events fired (HOOK_EVENTS_OBSERVED_IN_CAPTURES). Also from managed settings in the agent container (test/fixtures/container)",
    scope: "any",
  },
  "hooks.<Event>[].matcher": {
    status: "verified_capture",
    evidence: "run1 PreToolUse matcher \"Read\" ran the deny hook; run2 FileChanged matcher watched notes.txt",
    scope: "any",
  },
  "hooks.<Event>[].hooks[].type": { status: "verified_capture", evidence: "type \"command\" in run1-3", scope: "any" },
  "hooks.<Event>[].hooks[].command": { status: "verified_capture", evidence: "exec form command \"python3\" in run1-3", scope: "any" },
  "hooks.<Event>[].hooks[].args": { status: "verified_capture", evidence: "exec form args in run1-3", scope: "any" },
  "hooks.<Event>[].hooks[].timeout": { status: "verified_capture", evidence: "timeout 20 in run1-3", scope: "any" },
  "hooks.<Event>[].hooks[].if": { status: "documented", evidence: "hooks.md Common fields", scope: "any" },
  "hooks.<Event>[].hooks[].onFailure": { status: "documented", evidence: "hooks.md Command hook fields (>= 2.1.295)", scope: "any" },
  allowManagedHooksOnly: {
    status: "verified_container",
    evidence:
      "kw-agent:2.1.302, generated managed-settings.json at /etc/claude-code (ro): a SessionStart hook in the workspace .claude/settings.json ran without this key and did not run with it (test/fixtures/container)",
    scope: "managed",
  },
  allowManagedPermissionRulesOnly: { status: "documented", evidence: "settings-reference.md, managed-settings.md example", scope: "managed" },
  disableAllHooks: { status: "documented", evidence: "settings-reference.md", scope: "any" },
  sandbox: {
    status: "verified_capture",
    evidence: "run2 on macOS (Seatbelt). In the Linux agent container bubblewrap cannot create namespaces (container-spike), so it is not emitted by default",
    scope: "any",
  },
  "sandbox.enabled": { status: "verified_capture", evidence: "run2 (macOS only)", scope: "any" },
  "sandbox.failIfUnavailable": { status: "verified_capture", evidence: "run2 (macOS only)", scope: "any" },
  "sandbox.allowUnsandboxedCommands": { status: "verified_capture", evidence: "run2 (macOS only)", scope: "any" },
  "sandbox.filesystem": { status: "verified_capture", evidence: "run2 (macOS only)", scope: "any" },
  "sandbox.filesystem.denyRead": { status: "verified_capture", evidence: "run2: cat .env -> Operation not permitted (macOS only)", scope: "any" },
  env: { status: "documented", evidence: "settings-reference.md env", scope: "any" },
};

/**
 * Status of the Linux managed-settings location (managed-settings.md, devcontainer.md). Confirmed in the
 * agent container: with the generated file as the ONLY settings source, its hooks fired
 * (SessionStart, UserPromptSubmit, MessageDisplay, SessionEnd) in an unauthenticated `claude -p` run.
 * Permission rules from it were not exercised (no tool calls without auth): UNVERIFIED in-container.
 */
export const MANAGED_SETTINGS_PATH_STATUS = {
  path: "/etc/claude-code/managed-settings.json",
  status: "verified_container" as KeyStatus,
  evidence:
    "kw-agent:2.1.302 (linux/arm64), file bind-mounted read-only, no other settings source: managed hooks ran (test/fixtures/container/hooks-lockdown.ndjson). Deny/allow rules from it: UNVERIFIED in-container.",
};

// ------------------------------------------------------------------------------------------------
// Settings shape (only the keys the generator emits; validation rejects anything else)
// ------------------------------------------------------------------------------------------------

const HookHandler = z.strictObject({
  type: z.literal("command"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeout: z.number().int().positive().optional(),
  if: z.string().min(1).optional(),
  onFailure: z.enum(["continue", "block"]).optional(),
});
const MatcherGroup = z.strictObject({ matcher: z.string().optional(), hooks: z.array(HookHandler).min(1) });
const Permissions = z.strictObject({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
  disableBypassPermissionsMode: z.literal("disable").optional(),
});
const Sandbox = z.strictObject({
  enabled: z.boolean().optional(),
  failIfUnavailable: z.boolean().optional(),
  allowUnsandboxedCommands: z.boolean().optional(),
  filesystem: z.strictObject({ denyRead: z.array(z.string()).optional() }).optional(),
});
export const ClaudeSettingsSchema = z.strictObject({
  permissions: Permissions.optional(),
  hooks: z.record(z.string(), z.array(MatcherGroup)).optional(),
  allowManagedHooksOnly: z.boolean().optional(),
  allowManagedPermissionRulesOnly: z.boolean().optional(),
  disableAllHooks: z.boolean().optional(),
  sandbox: Sandbox.optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;
export type HookHandler = z.infer<typeof HookHandler>;

export interface KeyReportEntry {
  path: string;
  status: KeyStatus;
  evidence: string;
}

export interface SettingsValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  keys: KeyReportEntry[];
}

/** Validate a settings object against the documented keys this package knows, and list each key's evidence. */
export function validateClaudeSettings(settings: unknown, variant: "managed" | "run" = "run"): SettingsValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = ClaudeSettingsSchema.safeParse(settings);
  if (!parsed.success) for (const i of parsed.error.issues) errors.push(`${i.path.join(".") || "(root)"}: ${i.message}`);
  const keys = new Map<string, KeyReportEntry>();
  const visit = (v: unknown, path: string, regPath: string): void => {
    if (path) {
      const info = SETTINGS_KEY_REGISTRY[regPath];
      if (!info) errors.push(`${path}: key not in SETTINGS_KEY_REGISTRY`);
      else {
        keys.set(regPath, { path: regPath, status: info.status, evidence: info.evidence });
        if (info.scope === "managed" && variant !== "managed") warnings.push(`${path}: only honored in managed settings`);
      }
    }
    if (regPath === "hooks" && v && typeof v === "object") {
      for (const [ev, groups] of Object.entries(v)) {
        if (!isDocumentedHookEvent(ev)) errors.push(`hooks.${ev}: not a documented hook event`);
        if (!Array.isArray(groups)) continue;
        groups.forEach((g, gi) => {
          if (!g || typeof g !== "object") return;
          for (const [k, gv] of Object.entries(g)) {
            if (k === "hooks" && Array.isArray(gv)) {
              gv.forEach((h, hi) => {
                if (h && typeof h === "object")
                  for (const hk of Object.keys(h)) visit(undefined, `hooks.${ev}[${gi}].hooks[${hi}].${hk}`, `hooks.<Event>[].hooks[].${hk}`);
              });
            } else if (k !== "hooks") visit(undefined, `hooks.${ev}[${gi}].${k}`, `hooks.<Event>[].${k}`);
          }
        });
      }
      return;
    }
    if (regPath === "env") return;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, cv] of Object.entries(v)) visit(cv, path ? `${path}.${k}` : k, regPath ? `${regPath}.${k}` : k);
    }
  };
  visit(settings, "", "");
  const rawPerms =
    settings && typeof settings === "object" ? (settings as { permissions?: unknown }).permissions : undefined;
  for (const list of ["allow", "deny", "ask"] as const) {
    const rules = rawPerms && typeof rawPerms === "object" ? (rawPerms as Record<string, unknown>)[list] : undefined;
    for (const rule of Array.isArray(rules) ? rules.filter((x): x is string => typeof x === "string") : []) {
      const c = checkPermissionRule(rule);
      if (c.error) errors.push(`permissions.${list}: ${c.error}`);
      if (c.warning) warnings.push(`permissions.${list}: ${c.warning}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, keys: [...keys.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

const RULE_RE = /^(mcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_*-]+)?|[A-Z][A-Za-z0-9]*)(?:\((.+)\))?$/s;

/** Syntax check of one permission rule (permissions.md "Permission rule syntax"). */
export function checkPermissionRule(rule: string): { error?: string; warning?: string } {
  const m = RULE_RE.exec(rule);
  if (!m) return { error: `"${rule}" is not Tool or Tool(specifier)` };
  const tool = m[1]!;
  const spec = m[2];
  if (spec !== undefined && (IGNORED_PATH_RULE_TOOLS as readonly string[]).includes(tool) && tool !== "Glob") {
    return { error: `"${rule}": Claude Code never consults path rules for ${tool}; use Edit(...) (permissions.md)` };
  }
  if (spec !== undefined && tool === "Glob") return { error: `"${rule}": use Read(...) instead of Glob(...) (permissions.md)` };
  if (!tool.startsWith("mcp__") && !(KNOWN_TOOL_NAMES as readonly string[]).includes(tool))
    return { warning: `"${rule}": ${tool} is not a tool listed in tools-reference.md` };
  if ((tool === "Read" || tool === "Edit") && spec && /^\/[^/]/.test(spec))
    return {
      warning: `"${rule}": a single leading "/" anchors at the settings file's location, not the filesystem root; use "//" for absolute paths`,
    };
  return {};
}

// ------------------------------------------------------------------------------------------------
// Policy compilation
// ------------------------------------------------------------------------------------------------

export interface KwPolicy {
  id?: string;
  version?: string;
  rules: PolicyRule[];
}

export interface CompiledRule {
  rule_id: string;
  effect: "allow" | "deny" | "ask";
  claude_rules: string[];
  notes: string[];
}

export interface PolicyCompilation {
  allow: string[];
  deny: string[];
  ask: string[];
  compiled: CompiledRule[];
  /** Rules that could not be expressed as Claude Code permission rules. Never dropped silently. */
  not_compiled: Array<{ rule_id: string; reason: string }>;
}

/** Split "a|b" at top level (not inside braces/parentheses), then expand {x,y} alternatives. */
export function expandPattern(pattern: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of pattern) {
    if (ch === "{" || ch === "(") depth++;
    if (ch === "}" || ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "|" && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const out: string[] = [];
  const expand = (s: string): string[] => {
    const m = /\{([^{}]*)\}/.exec(s);
    if (!m) return [s];
    return m[1]!.split(",").flatMap((alt) => expand(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length)));
  };
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) out.push(...expand(p));
  return [...new Set(out)];
}

function pathSpec(p: string): string {
  // KW policies write absolute paths with one leading "/"; Claude Code needs "//" for filesystem-absolute.
  if (p.startsWith("/") && !p.startsWith("//")) return "/" + p;
  return p;
}

const FILE_READ_ACTIONS = new Set(["file_read", "file_open", "Read"]);
const FILE_WRITE_ACTIONS = new Set(["file_write", "file_create", "file_delete", "file_rename", "Edit", "Write", "NotebookEdit"]);
const SHELL_ACTIONS = new Set(["Bash", "process_exec", "command", "shell"]);
const NET_ACTIONS = new Set(["network_connect", "network", "WebFetch", "dns_query"]);

/** Compile KW policy rules to Claude Code permission rules. Pure. */
export function compilePolicy(policy: KwPolicy): PolicyCompilation {
  const res: PolicyCompilation = { allow: [], deny: [], ask: [], compiled: [], not_compiled: [] };
  const tentative: CompiledRule[] = [];
  for (const rule of policy.rules) {
    const pats = expandPattern(rule.resource_pattern);
    const notes: string[] = [];
    let tool: string | null = null;
    let make: (p: string) => string | null = () => null;
    const isAll = (p: string) => p === "*" || p === "**" || p === "**/*";
    if (FILE_READ_ACTIONS.has(rule.action)) {
      tool = "Read";
      make = (p) => (isAll(p) ? "Read" : `Read(${pathSpec(p)})`);
      notes.push("Read rules cover Claude's file tools and recognized Bash file commands (cat, head, ...), not arbitrary subprocesses such as python (permissions.md; capture run2/run3).");
    } else if (FILE_WRITE_ACTIONS.has(rule.action)) {
      tool = "Edit";
      make = (p) => (isAll(p) ? "Edit" : `Edit(${pathSpec(p)})`);
      if (rule.action === "Write" || rule.action === "NotebookEdit")
        notes.push(`${rule.action} path rules are never consulted; compiled to Edit(...) (permissions.md).`);
    } else if (SHELL_ACTIONS.has(rule.action)) {
      tool = "Bash";
      make = (p) => (isAll(p) ? "Bash" : `Bash(${p})`);
      notes.push("Bash rules match the command text Claude submits; they do not constrain what the command does once running.");
    } else if (NET_ACTIONS.has(rule.action)) {
      tool = "WebFetch";
      make = (p) => {
        if (isAll(p)) return "WebFetch";
        const host = p.replace(/^[a-z]+:\/\//i, "").replace(/[:/].*$/, "");
        return host ? `WebFetch(domain:${host})` : null;
      };
      notes.push("Covers only Claude's WebFetch tool. Egress from Bash and other processes is governed by the egress proxy, not by Claude Code.");
    } else if ((KNOWN_TOOL_NAMES as readonly string[]).includes(rule.action) || rule.action.startsWith("mcp__")) {
      tool = rule.action;
      make = (p) => (isAll(p) ? rule.action : `${rule.action}(${p})`);
    }
    if (!tool) {
      res.not_compiled.push({ rule_id: rule.id, reason: `action "${rule.action}" has no Claude Code permission-rule equivalent` });
      continue;
    }
    const claude = [...new Set(pats.map(make).filter((x): x is string => !!x))];
    if (claude.length === 0) {
      res.not_compiled.push({ rule_id: rule.id, reason: `resource pattern "${rule.resource_pattern}" produced no rule` });
      continue;
    }
    tentative.push({ rule_id: rule.id, effect: rule.effect, claude_rules: claude, notes });
  }
  // Claude Code evaluates deny before allow, so a catch-all deny would also block every allow of the same
  // tool. A KW default-deny is realized instead by not allowing: unapproved calls are denied in -p mode
  // (capture run1: "This command requires approval").
  const toolOf = (r: string) => r.replace(/\(.*$/s, "");
  for (const c of tentative) {
    if (c.effect === "deny") {
      const bare = c.claude_rules.filter((r) => !r.includes("("));
      const shadow = bare.filter((b) => tentative.some((o) => o.effect === "allow" && o.claude_rules.some((r) => toolOf(r) === b)));
      if (shadow.length) {
        c.claude_rules = c.claude_rules.filter((r) => !shadow.includes(r));
        c.notes.push(
          `Catch-all deny ${shadow.join(", ")} not emitted: Claude Code applies deny before allow, so it would also block this policy's allow rules. Calls not allowed are denied in headless mode anyway.`,
        );
        if (c.claude_rules.length === 0) {
          res.not_compiled.push({ rule_id: c.rule_id, reason: c.notes[c.notes.length - 1]! });
          continue;
        }
      }
    }
    res.compiled.push(c);
    for (const r of c.claude_rules) if (!res[c.effect].includes(r)) res[c.effect].push(r);
  }
  return res;
}

// ------------------------------------------------------------------------------------------------
// Safeguards
// ------------------------------------------------------------------------------------------------

export interface SafeguardPermissions {
  allow: string[];
  deny: string[];
  ask: string[];
  errors: string[];
}

/**
 * Permission rules carried by an approved permission_rule safeguard. Accepted content forms:
 *  - JSON {"permissions": {"deny": [...], "allow": [...], "ask": [...]}} or {"deny": [...]}
 *  - one rule per line; the list (allow/ask/deny) is read from application_mechanism, default deny.
 */
export function permissionsFromSafeguard(sg: Pick<Safeguard, "id" | "type" | "content" | "application_mechanism">): SafeguardPermissions {
  const out: SafeguardPermissions = { allow: [], deny: [], ask: [], errors: [] };
  if (sg.type !== "permission_rule") {
    out.errors.push(`${sg.id}: not a permission_rule safeguard`);
    return out;
  }
  type Lists = Partial<Record<"allow" | "deny" | "ask", unknown>>;
  let lists: Lists | null = null;
  try {
    const v: unknown = JSON.parse(sg.content);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      lists = (o.permissions && typeof o.permissions === "object" ? o.permissions : o) as Lists;
    }
  } catch {
    /* not JSON: one rule per line */
  }
  if (!lists) {
    const mech = sg.application_mechanism.toLowerCase();
    const list = mech.includes("permissions.allow") ? "allow" : mech.includes("permissions.ask") ? "ask" : "deny";
    lists = { [list]: sg.content.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#")) };
  }
  for (const list of ["allow", "deny", "ask"] as const) {
    const v = lists[list];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      out.errors.push(`${sg.id}: permissions.${list} must be an array of strings`);
      continue;
    }
    for (const rule of v) {
      const c = checkPermissionRule(rule);
      if (c.error) out.errors.push(`${sg.id}: ${c.error}`);
      else out[list].push(rule);
    }
  }
  return out;
}

const MARK = "kw-safeguard";

/**
 * CLAUDE.md block for an approved claude_md_instruction safeguard. The block is delimited by HTML comment
 * markers so it can be replaced or removed idempotently. A CLAUDE.md instruction influences the model; it
 * is not an enforcement control, and the agent can edit CLAUDE.md (capture run2 appended to it).
 */
export function renderClaudeMdInstruction(input: {
  safeguard_id: string;
  title: string;
  content: string;
  finding_id?: string | null;
}): string {
  if (!/^[A-Za-z0-9_-]+$/.test(input.safeguard_id)) throw new Error("safeguard_id must match [A-Za-z0-9_-]+");
  const clean = (s: string) => s.replace(/<!--\s*\/?\s*kw-safeguard[^>]*-->/gi, "").replace(/\r\n/g, "\n").trim();
  const title = clean(input.title).replace(/\n+/g, " ");
  const body = clean(input.content);
  if (!body) throw new Error("CLAUDE.md instruction content is empty");
  const origin = input.finding_id ? ` for finding ${input.finding_id}` : "";
  return [
    `<!-- ${MARK}:begin id=${input.safeguard_id} -->`,
    `## ${title}`,
    "",
    body,
    "",
    `<!-- Added by Underwatch${origin} after developer approval (safeguard ${input.safeguard_id}). Guidance for the agent, not an enforced control. -->`,
    `<!-- ${MARK}:end id=${input.safeguard_id} -->`,
    "",
  ].join("\n");
}

function blockRe(id: string): RegExp {
  const e = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\n?<!-- ${MARK}:begin id=${e} -->[\\s\\S]*?<!-- ${MARK}:end id=${e} -->\\n?`, "g");
}

/** Insert or replace the block for `safeguard_id` in an existing CLAUDE.md. Idempotent. */
export function applyClaudeMdInstruction(existing: string, block: string, safeguard_id: string): string {
  const re = blockRe(safeguard_id);
  if (re.test(existing)) return existing.replace(blockRe(safeguard_id), "\n" + block);
  const sep = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block;
}

/** Remove the block for `safeguard_id`. Returns the text unchanged if absent. */
export function removeClaudeMdInstruction(existing: string, safeguard_id: string): string {
  return existing.replace(blockRe(safeguard_id), "\n").replace(/\n{3,}$/, "\n\n");
}

// ------------------------------------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------------------------------------

/**
 * Instruction and secret files whose changes Claude Code's own watcher should report (FileChanged watches
 * literal filenames in the working directory only). Instruction files can steer the agent (memory.md).
 */
export const DEFAULT_FILE_CHANGED_WATCH = [".env", "CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".mcp.json"];

export interface EnforcementHook {
  event: HookEventName;
  matcher?: string;
  handler: HookHandler;
}

export interface RenderSettingsOptions {
  layout?: Partial<ContainerLayout>;
  /** Events wired to the forwarder. Default: every documented event except those whose hook changes behavior. */
  events?: readonly HookEventName[];
  /** Seconds. The forwarder exits in milliseconds; this bounds a stuck node start. Default 10. */
  hookTimeoutSec?: number;
  /** Literal filenames (working directory) for the FileChanged watch list. Default DEFAULT_FILE_CHANGED_WATCH. */
  fileChangedWatch?: string[];
  /** Separate enforcement hooks (e.g. a PreToolUse deny hook). Added after the forwarder. */
  enforcementHooks?: EnforcementHook[];
  /** Extra rules, e.g. from approved permission_rule safeguards. */
  extraPermissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  /** Managed variant only: make managed settings the only source of hooks and permission rules. Default true. */
  lockdown?: boolean;
  /**
   * Opt-in sandbox block. Not emitted by default: bubblewrap cannot create namespaces in the unprivileged
   * agent container (research/claude-code/container-spike/spike-output.txt). Verified on macOS only.
   */
  sandbox?: z.infer<typeof Sandbox>;
}

export interface RenderedSettings {
  managed: ClaudeSettings;
  run: ClaudeSettings;
  compilation: PolicyCompilation;
  validation: { managed: SettingsValidation; run: SettingsValidation };
  notes: string[];
}

export function forwarderHandler(layout: ContainerLayout, event: HookEventName, timeout: number): HookHandler {
  return { type: "command", command: layout.nodeBinary, args: [layout.hookForwarderPath, event], timeout };
}

export function renderHooks(opts: RenderSettingsOptions = {}): NonNullable<ClaudeSettings["hooks"]> {
  const layout: ContainerLayout = { ...DEFAULT_CONTAINER_LAYOUT, ...opts.layout };
  const timeout = opts.hookTimeoutSec ?? 10;
  const hooks: NonNullable<ClaudeSettings["hooks"]> = {};
  for (const ev of opts.events ?? DEFAULT_HOOK_EVENTS) {
    const group: { matcher?: string; hooks: HookHandler[] } = { hooks: [forwarderHandler(layout, ev, timeout)] };
    if (ev === "FileChanged") {
      const watch = (opts.fileChangedWatch ?? DEFAULT_FILE_CHANGED_WATCH).filter((f) => f && !f.includes("|"));
      if (watch.length === 0) continue; // the watcher only starts when a filename is named (hooks.md)
      group.matcher = watch.join("|");
    }
    hooks[ev] = [group];
  }
  for (const eh of opts.enforcementHooks ?? []) {
    const g: { matcher?: string; hooks: HookHandler[] } = { hooks: [eh.handler] };
    if (eh.matcher !== undefined) g.matcher = eh.matcher;
    (hooks[eh.event] ??= []).push(g);
  }
  return hooks;
}

/** Render managed + run settings for a policy. Pure; write the results with prepareWorkspace or yourself. */
export function renderClaudeSettings(policy: KwPolicy, opts: RenderSettingsOptions = {}): RenderedSettings {
  const compilation = compilePolicy(policy);
  const extra = opts.extraPermissions ?? {};
  const merge = (a: string[], b: string[] | undefined) => [...new Set([...a, ...(b ?? [])])];
  const permissions = {
    allow: merge(compilation.allow, extra.allow),
    deny: merge(compilation.deny, extra.deny),
    ask: merge(compilation.ask, extra.ask),
  };
  const hooks = renderHooks(opts);
  const notes: string[] = [];
  const lockdown = opts.lockdown ?? true;

  const managed: ClaudeSettings = {
    permissions: { ...permissions, disableBypassPermissionsMode: "disable" },
    hooks,
  };
  if (lockdown) {
    managed.allowManagedHooksOnly = true;
    managed.allowManagedPermissionRulesOnly = true;
    notes.push(
      "Managed variant sets allowManagedHooksOnly and allowManagedPermissionRulesOnly (documented): repo, user and --settings hooks/rules are ignored, so all rules must live in the managed file.",
    );
  }
  const run: ClaudeSettings = { permissions, hooks };
  if (opts.sandbox) {
    managed.sandbox = opts.sandbox;
    run.sandbox = opts.sandbox;
    notes.push("Sandbox block emitted on request; verified on macOS only, known to fail in the unprivileged Linux agent container.");
  }
  if (permissions.allow.length === 0)
    notes.push("No allow rules: in -p mode every call that needs approval is denied (capture run1).");
  notes.push(
    "Pass --permission-mode explicitly; without it the built-in starting mode can be auto (headless.md).",
    "Project .claude/settings.json allow rules are ignored in -p mode for an untrusted workspace (capture run1 stderr; permissions.md); deny rules and hooks there still apply.",
  );
  return {
    managed,
    run,
    compilation,
    validation: { managed: validateClaudeSettings(managed, "managed"), run: validateClaudeSettings(run, "run") },
    notes,
  };
}
