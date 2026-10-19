/**
 * Facts about Claude Code that this adapter depends on, with their evidence level.
 *
 * Evidence sources (all under scratchpad/research/claude-code/):
 *  - docs: evidence/docs/*.md, fetched 2026-10-17 01:05 UTC (code.claude.com docs for v2.1.302).
 *  - captures: probe-out/run{1,2,3}/ — real `claude -p --output-format stream-json --verbose` runs of
 *    Claude Code 2.1.302 on macOS with every hook event wired to a logger. Copied (sanitized) into
 *    test/fixtures/captures/.
 */

/** Claude Code version the parsers were written against (captures + docs). Other versions: UNVERIFIED. */
export const VERIFIED_CLAUDE_CODE_VERSION = "2.1.302";

/** Every hook event documented in hooks.md (2.1.302). */
export const DOCUMENTED_HOOK_EVENTS = [
  "SessionStart",
  "Setup",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PreToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "MessageDisplay",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "TeammateIdle",
  "InstructionsLoaded",
  "ConfigChange",
  "CwdChanged",
  "DirectoryAdded",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "PreCompact",
  "PostCompact",
  "PreModelSwitch",
  "PostModelSwitch",
  "Elicitation",
  "ElicitationResult",
  "SessionEnd",
] as const;
export type HookEventName = (typeof DOCUMENTED_HOOK_EVENTS)[number];

export function isDocumentedHookEvent(name: string): name is HookEventName {
  return (DOCUMENTED_HOOK_EVENTS as readonly string[]).includes(name);
}

/**
 * Hook events that actually fired in the 2.1.302 captures (probe-out run1..run3, all 33 events wired).
 * Any other event is doc-sourced only. Asserted by test/captures.test.ts.
 */
export const HOOK_EVENTS_OBSERVED_IN_CAPTURES = [
  "SessionStart",
  "InstructionsLoaded",
  "UserPromptSubmit",
  "MessageDisplay",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "FileChanged",
  "ConfigChange",
  "Stop",
  "SessionEnd",
] as const satisfies readonly HookEventName[];

/**
 * Events the forwarder is NOT wired to by default, because configuring any handler changes Claude Code's
 * behavior (docs: hooks.md). An observation hook must never change behavior.
 */
export const HOOK_EVENTS_EXCLUDED_BY_DEFAULT: Readonly<Partial<Record<HookEventName, string>>> = {
  WorktreeCreate: "A WorktreeCreate hook replaces Claude Code's default git worktree creation (hooks.md).",
  WorktreeRemove: "WorktreeRemove pairs with a WorktreeCreate hook that replaced worktree creation (hooks.md).",
};

export const DEFAULT_HOOK_EVENTS: readonly HookEventName[] = DOCUMENTED_HOOK_EVENTS.filter(
  (e) => !(e in HOOK_EVENTS_EXCLUDED_BY_DEFAULT),
);

/** Hook events whose payload carries tool_use_id (hooks.md + captures for Pre/Post/PostFailure). */
export const TOOL_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied"] as const;

/**
 * Built-in tool names from tools-reference.md (2.1.302), plus "Task", which the captured system/init
 * tool list reports. Rules naming other tools are accepted with a warning (MCP tools: "mcp__...").
 */
export const KNOWN_TOOL_NAMES = [
  "Agent", "Artifact", "AskUserQuestion", "Bash", "CronCreate", "CronDelete", "CronList", "Edit",
  "EndConversation", "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree", "Glob", "Grep",
  "ListAgents", "ListMcpResourcesTool", "LSP", "Monitor", "NotebookEdit", "PowerShell", "PushNotification",
  "Read", "ReadMcpResourceTool", "RemoteTrigger", "ReportFindings", "ScheduleWakeup", "SendFeedback",
  "SendMessage", "SendUserFile", "Skill", "SubagentHandback", "Task", "TaskCreate", "TaskGet", "TaskList",
  "TaskOutput", "TaskStop", "TaskUpdate", "TodoWrite", "ToolSearch", "WaitForMcpServers", "WebFetch",
  "WebSearch", "Workflow", "Write",
] as const;

/** Tools whose path rules Claude Code consults (permissions.md "Read and Edit"). */
export const PATH_RULE_TOOLS = ["Read", "Edit"] as const;
/** Tools that accept a path rule but whose path rules are never consulted (permissions.md). */
export const IGNORED_PATH_RULE_TOOLS = ["Write", "NotebookEdit", "Glob", "MultiEdit"] as const;

/** Linux managed-settings location (managed-settings.md, devcontainer.md). See MANAGED_SETTINGS_PATH_STATUS. */
export const LINUX_MANAGED_SETTINGS_PATH = "/etc/claude-code/managed-settings.json";

/**
 * Container paths agreed with the docker/ component (docker/compose.agent.yml, docker/agent/entrypoint.sh).
 * Override per run through ContainerLayout.
 */
export const DEFAULT_CONTAINER_LAYOUT = {
  workspaceDir: "/workspace",
  hookForwarderPath: "/opt/kw/kw-hook.mjs",
  hookLogPath: "/kw-hooks/hooks.ndjson",
  managedSettingsPath: LINUX_MANAGED_SETTINGS_PATH,
  /** Only used when settings are delivered with --settings instead of the managed tier. */
  runSettingsPath: "/opt/kw/run-settings.json",
  nodeBinary: "node",
} as const;
export type ContainerLayout = { -readonly [K in keyof typeof DEFAULT_CONTAINER_LAYOUT]: string };

/** Env var Claude Code reads for a `claude setup-token` long-lived token (authentication.md). */
export const OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** Where the operator saves the token on the host (user-approved decision). Never read by this package. */
export const DEFAULT_OAUTH_TOKEN_HOST_PATH = "~/.underwatch/claude-oauth-token";
