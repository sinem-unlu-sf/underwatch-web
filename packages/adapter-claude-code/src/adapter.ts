import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  CollectionStatus,
  Event,
  EventType,
  type ComponentStatus,
  type CoverageCategory,
  type Safeguard,
} from "@kw/schema";
import {
  DEFAULT_CONTAINER_LAYOUT,
  DEFAULT_OAUTH_TOKEN_HOST_PATH,
  OAUTH_TOKEN_ENV,
  VERIFIED_CLAUDE_CODE_VERSION,
  type ContainerLayout,
} from "./constants";
import { parseRunOutputs } from "./parse";
import {
  applyClaudeMdInstruction,
  permissionsFromSafeguard,
  renderClaudeMdInstruction,
  renderClaudeSettings,
  type KwPolicy,
  type RenderSettingsOptions,
  type RenderedSettings,
} from "./settings";
import type { ParseContext, ParseResult, ReportedEvent, RunOutputs } from "./types";

export type FieldAvailability = "available" | "partial" | "unavailable";

export interface FieldCapability {
  field: string;
  availability: FieldAvailability;
  channels: Array<"hook_log" | "stream_json" | "transcript">;
  evidence: string;
}

/**
 * Which reported-event fields Claude Code 2.1.302 actually supplies, from the captures
 * (test/fixtures/captures) and docs. Hand-maintained: the tool_use_id / denial-coverage rows are exercised by
 * test/captures.test.ts, the other rows are not asserted by any test.
 */
export const REPORTED_FIELD_CAPABILITIES: readonly FieldCapability[] = [
  { field: "tool_use_id", availability: "available", channels: ["hook_log", "stream_json", "transcript"], evidence: "PreToolUse/PostToolUse/PostToolUseFailure payload tool_use_id; stream/transcript tool_use.id and tool_result.tool_use_id (run1-3)" },
  { field: "tool_name", availability: "available", channels: ["hook_log", "stream_json", "transcript"], evidence: "payload tool_name; tool_use.name (run1-3)" },
  { field: "target_resource", availability: "partial", channels: ["hook_log", "stream_json", "transcript"], evidence: "derived from tool_input (file_path, command, url, pattern) for known tools; null for other tools" },
  { field: "outcome (succeeded/failed)", availability: "available", channels: ["hook_log", "stream_json", "transcript"], evidence: "tool_result is_error; PostToolUse vs PostToolUseFailure (run2)" },
  { field: "permission decision (allowed / hook deny / rule deny / approval unavailable)", availability: "available", channels: ["stream_json", "transcript"], evidence: "stream tool_result_meta[].permission_decision + non_execution_kind; transcript permissionDecision + toolDenialKind (run1). UNDOCUMENTED fields: UNVERIFIED as stable API" },
  { field: "permission denial list", availability: "available", channels: ["stream_json"], evidence: "system/permission_denied and result.permission_denials (run1; headless.md)" },
  { field: "hook coverage of denied calls", availability: "partial", channels: ["hook_log"], evidence: "run1: Read denied by a deny rule fired no PreToolUse hook at all; only stream/transcript record it" },
  { field: "duration_ms", availability: "partial", channels: ["hook_log"], evidence: "PostToolUse/PostToolUseFailure duration_ms only" },
  { field: "timestamp", availability: "partial", channels: ["hook_log", "stream_json", "transcript"], evidence: "assistant/user records carry timestamp; system/result records do not (neighbor or hook received_at used). All are agent-container clocks" },
  { field: "process_id / parent_process_id / process_name", availability: "unavailable", channels: [], evidence: "No Claude Code record carries process identity; kw-hook records its own pid/ppid only" },
  { field: "agent_id (subagent)", availability: "partial", channels: ["hook_log", "stream_json"], evidence: "hooks.md agent_id; stream parent_tool_use_id. Not exercised in captures (no subagents): UNVERIFIED" },
  { field: "final report text", availability: "available", channels: ["stream_json", "hook_log"], evidence: "result.result; Stop last_assistant_message (run1-3)" },
  { field: "reported file changes", availability: "partial", channels: ["stream_json", "transcript", "hook_log"], evidence: "Write/Edit tool_use_result (type, filePath, structuredPatch); FileChanged hook for watched literal filenames only (run2)" },
  { field: "child processes / files touched by Bash", availability: "unavailable", channels: [], evidence: "Bash results report output only; independent observation required" },
];

export interface PrepareWorkspaceOptions extends RenderSettingsOptions {
  /**
   * Host directory for settings files that will be mounted READ-ONLY into the agent container
   * (e.g. the per-run KW_POLICY_DIR mounted at /etc/claude-code). Must be outside the workspace.
   * When omitted, nothing but CLAUDE.md is written and the settings are only returned.
   */
  configDir?: string;
  /** Also write run-settings.json (for --settings) into configDir. Default false. */
  writeRunSettings?: boolean;
}

export interface PrepareWorkspaceResult {
  settings: RenderedSettings;
  claudeMdPath: string | null;
  managedSettingsPath: string | null;
  runSettingsPath: string | null;
  applied: Array<{ safeguard_id: string; type: Safeguard["type"]; mechanism: string }>;
  skipped: Array<{ safeguard_id: string; reason: string }>;
}

export interface BuildCommandInput {
  task: string;
  model: string;
  maxTurns: number;
  /** Default "default" (the mode in every capture). "dontAsk" is documented but not exercised: UNVERIFIED. */
  permissionMode?: "default" | "dontAsk" | "acceptEdits" | "plan";
  /** Pre-assign the session id (--session-id, documented). Must be a UUID. */
  sessionId?: string;
  /** "managed" (default): settings come from /etc/claude-code. "flag": pass --settings <layout.runSettingsPath>. */
  settingsDelivery?: "managed" | "flag";
  layout?: Partial<ContainerLayout>;
}

export interface BuiltCommand {
  command: string;
  args: string[];
  cwd: string;
  /** Non-secret environment for the agent process. */
  env: Record<string, string>;
  /**
   * Secret env vars for the agent container. ALWAYS EMPTY: the real Claude credential must never enter
   * the agent container (its env is readable by the agent's Bash tool, hooks, children and `docker inspect`).
   * Kept as an explicitly empty field so older runners that iterate it inject nothing.
   */
  secretEnv: [];
  /**
   * How the agent authenticates: through the per-run credential broker (docker/llm-broker). The runner
   * mounts `realTokenHostSource` read-only into the BROKER container only, and gives the agent only
   * `baseUrlEnv` (= the broker URL) and `clientTokenEnv` (= a random per-run placeholder the broker accepts).
   * The adapter never reads secret values.
   */
  credential: {
    mode: "broker";
    clientTokenEnv: string;
    baseUrlEnv: "ANTHROPIC_BASE_URL";
    realTokenHostSource: string;
    realTokenDeliverTo: "llm-broker";
  };
  /** Where stdout (stream-json) must be captured by the host. */
  stdout: "stream-json";
  notes: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude Code adapter. Produces only basis "reported" events (agent-side records). */
export class ClaudeCodeAdapter {
  readonly id = "claude-code";
  readonly verifiedVersion = VERIFIED_CLAUDE_CODE_VERSION;
  private readonly layout: ContainerLayout;
  private readonly tokenHostPath: string;

  constructor(opts: { layout?: Partial<ContainerLayout>; tokenHostPath?: string } = {}) {
    this.layout = { ...DEFAULT_CONTAINER_LAYOUT, ...opts.layout };
    this.tokenHostPath = opts.tokenHostPath ?? DEFAULT_OAUTH_TOKEN_HOST_PATH;
  }

  /** Checks only that the token file exists (stat; never reads it). */
  async status(): Promise<ComponentStatus> {
    const p = this.tokenHostPath.replace(/^~(?=\/)/, homedir());
    let present = false;
    try {
      present = (await stat(p)).isFile();
    } catch {
      present = false;
    }
    return {
      id: this.id,
      name: "Claude Code adapter",
      status: present ? "configured" : "not_configured",
      detail: present
        ? `Parsers and settings generator for Claude Code ${VERIFIED_CLAUDE_CODE_VERSION}; agent token file present (not read).`
        : `Agent token file ${this.tokenHostPath} not found. Run \`claude setup-token\` and save the token there.`,
      configured_via: present ? this.tokenHostPath : null,
    };
  }

  /** Coverage categories this adapter genuinely reports (see REPORTED_FIELD_CAPABILITIES for field detail). */
  async capabilities(): Promise<CoverageCategory[]> {
    return ["tool_calls", "permission_decisions", "agent_reported_actions"];
  }

  reportedFieldCapabilities(): readonly FieldCapability[] {
    return REPORTED_FIELD_CAPABILITIES;
  }

  renderSettings(policy: KwPolicy, opts: RenderSettingsOptions = {}): RenderedSettings {
    return renderClaudeSettings(policy, { ...opts, layout: { ...this.layout, ...opts.layout } });
  }

  /**
   * Prepare a workspace for a run:
   *  - approved claude_md_instruction safeguards -> CLAUDE.md blocks in the workspace (agent-visible guidance);
   *  - approved permission_rule safeguards -> folded into the generated settings;
   *  - settings written to opts.configDir (outside the workspace, to be mounted read-only).
   * Safeguards that are not approved, or whose type has no supported mechanism here, are skipped and listed.
   */
  async prepareWorkspace(
    dir: string,
    policy: KwPolicy,
    safeguards: readonly Safeguard[],
    opts: PrepareWorkspaceOptions = {},
  ): Promise<PrepareWorkspaceResult> {
    const ws = await realpathLenient(resolve(dir));
    if (opts.configDir) {
      // Compare real paths so a symlinked workspace or configDir cannot place settings inside the workspace.
      const rel = relative(ws, await realpathLenient(resolve(opts.configDir)));
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
        throw new Error("configDir must be outside the agent workspace: the agent can write to the workspace");
    }
    const applied: PrepareWorkspaceResult["applied"] = [];
    const skipped: PrepareWorkspaceResult["skipped"] = [];
    const extra = { allow: [] as string[], deny: [] as string[], ask: [] as string[] };
    const mdBlocks: Array<{ id: string; block: string }> = [];
    for (const sg of [...safeguards].sort((a, b) => a.id.localeCompare(b.id))) {
      if (sg.approval_status !== "approved") {
        skipped.push({ safeguard_id: sg.id, reason: `approval_status is "${sg.approval_status}"; only approved safeguards are applied` });
        continue;
      }
      if (sg.type === "claude_md_instruction") {
        mdBlocks.push({
          id: sg.id,
          block: renderClaudeMdInstruction({ safeguard_id: sg.id, title: sg.title, content: sg.content, finding_id: sg.finding_id }),
        });
        applied.push({ safeguard_id: sg.id, type: sg.type, mechanism: "CLAUDE.md block in the workspace" });
      } else if (sg.type === "permission_rule") {
        const p = permissionsFromSafeguard(sg);
        if (p.errors.length) {
          skipped.push({ safeguard_id: sg.id, reason: p.errors.join("; ") });
          continue;
        }
        extra.allow.push(...p.allow);
        extra.deny.push(...p.deny);
        extra.ask.push(...p.ask);
        applied.push({ safeguard_id: sg.id, type: sg.type, mechanism: "permissions in managed settings (read-only mount)" });
      } else {
        skipped.push({ safeguard_id: sg.id, reason: `type "${sg.type}" is not applied by the adapter (no supported mechanism here)` });
      }
    }
    const settings = this.renderSettings(policy, { ...opts, extraPermissions: mergeExtra(opts.extraPermissions, extra) });
    if (!settings.validation.managed.ok) throw new Error("generated managed settings failed validation: " + settings.validation.managed.errors.join("; "));

    let claudeMdPath: string | null = null;
    if (mdBlocks.length) {
      claudeMdPath = join(ws, "CLAUDE.md");
      // The workspace is agent/repo-controlled and this runs on the host: never follow a planted symlink
      // (e.g. CLAUDE.md -> ~/.bashrc) or write through a non-regular file.
      let text = "";
      let st: Awaited<ReturnType<typeof lstat>> | null = null;
      try {
        st = await lstat(claudeMdPath);
      } catch {
        st = null;
      }
      if (st && !st.isFile())
        throw new Error(`${claudeMdPath} is not a regular file (symlink or other); refusing to read or write it`);
      if (st) text = await readFile(claudeMdPath, "utf8");
      for (const { id, block } of mdBlocks) text = applyClaudeMdInstruction(text, block, id);
      await writeFile(claudeMdPath, text);
    }
    let managedSettingsPath: string | null = null;
    let runSettingsPath: string | null = null;
    if (opts.configDir) {
      await mkdir(opts.configDir, { recursive: true });
      managedSettingsPath = join(opts.configDir, "managed-settings.json");
      await writeFile(managedSettingsPath, JSON.stringify(settings.managed, null, 2) + "\n", { mode: 0o644 });
      if (opts.writeRunSettings) {
        runSettingsPath = join(opts.configDir, "run-settings.json");
        await writeFile(runSettingsPath, JSON.stringify(settings.run, null, 2) + "\n", { mode: 0o644 });
      }
    }
    return { settings, claudeMdPath, managedSettingsPath, runSettingsPath, applied, skipped };
  }

  /** Headless command line for the agent container. Does not read or embed any secret. */
  buildCommand(input: BuildCommandInput): BuiltCommand {
    const layout = { ...this.layout, ...input.layout };
    if (!input.task.trim()) throw new Error("task must be non-empty");
    // The prompt is a positional argument after -p; text starting with "-" would be parsed as CLI options.
    if (/^\s*-/.test(input.task)) throw new Error('task must not start with "-" (it would be parsed as a command-line option)');
    if (!/^[A-Za-z0-9._:\-[\]]+$/.test(input.model)) throw new Error("model must be an alias or model id");
    if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1) throw new Error("maxTurns must be a positive integer");
    if (input.sessionId !== undefined && !UUID_RE.test(input.sessionId)) throw new Error("sessionId must be a UUID");
    const args = [
      "-p",
      input.task,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      input.model,
      "--max-turns",
      String(input.maxTurns),
      "--permission-mode",
      input.permissionMode ?? "default",
      "--strict-mcp-config",
    ];
    if (input.sessionId) args.push("--session-id", input.sessionId);
    const notes = [
      "stream-json on stdout is the agent's own account; capture it on the host (outside the container).",
      "--permission-mode is explicit because the built-in starting mode can be auto (headless.md).",
    ];
    if ((input.settingsDelivery ?? "managed") === "flag") {
      args.push("--settings", layout.runSettingsPath);
      notes.push("--settings delivery: mount run-settings.json read-only; flagSettings is verified (capture run2).");
    } else {
      notes.push(`Managed delivery: mount the generated managed-settings.json read-only at ${layout.managedSettingsPath}.`);
    }
    if (input.sessionId) notes.push("--session-id is documented (cli-reference.md); not confirmed in the recorded probe invocations: UNVERIFIED.");
    if (input.permissionMode === "dontAsk") notes.push("dontAsk is documented but not exercised in captures: UNVERIFIED.");
    if (/^(haiku|sonnet|opus|fable)$/i.test(input.model))
      notes.push(`"${input.model}" is an alias; it resolved to different models minutes apart in the captures (run1 vs run2). Pin a full model id for comparable runs.`);
    return {
      command: "claude",
      args,
      cwd: layout.workspaceDir,
      env: {
        KW_HOOK_LOG: layout.hookLogPath,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        // Auto memory is agent-writable and loaded by later sessions (memory.md; fact-check claude-code-47).
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      },
      secretEnv: [],
      credential: {
        mode: "broker",
        clientTokenEnv: OAUTH_TOKEN_ENV,
        baseUrlEnv: "ANTHROPIC_BASE_URL",
        realTokenHostSource: this.tokenHostPath,
        realTokenDeliverTo: "llm-broker",
      },
      stdout: "stream-json",
      notes,
    };
  }

  /** Parse the run's agent-side outputs (file contents) into reported events and evidence. Pure. */
  parseRunOutputs(outputs: RunOutputs, ctx: ParseContext): ParseResult {
    return parseRunOutputs(outputs, ctx);
  }
}

/** realpath of p, or of its nearest existing ancestor joined with the rest (p may not exist yet). */
async function realpathLenient(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return join(await realpathLenient(parent), basename(p));
  }
}

function mergeExtra(
  a: RenderSettingsOptions["extraPermissions"],
  b: { allow: string[]; deny: string[]; ask: string[] },
): { allow: string[]; deny: string[]; ask: string[] } {
  return {
    allow: [...(a?.allow ?? []), ...b.allow],
    deny: [...(a?.deny ?? []), ...b.deny],
    ask: [...(a?.ask ?? []), ...b.ask],
  };
}

/**
 * Convert to shared-schema Events. Events whose type or collection status the schema lacks
 * (LOCAL_EVENT_TYPES, "unparsed") are returned separately instead of being coerced.
 */
export function toSchemaEvents(events: readonly ReportedEvent[]): { events: Event[]; not_representable: ReportedEvent[] } {
  const out: Event[] = [];
  const rest: ReportedEvent[] = [];
  for (const e of events) {
    const t = EventType.safeParse(e.event_type);
    const c = CollectionStatus.safeParse(e.collection_status);
    if (!t.success || !c.success) {
      rest.push(e);
      continue;
    }
    const { detail: _detail, ...base } = e;
    out.push(Event.parse({ ...base, event_type: t.data, collection_status: c.data }));
  }
  return { events: out, not_representable: rest };
}
