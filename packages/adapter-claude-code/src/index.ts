/**
 * @kw/adapter-claude-code — Claude Code agent adapter (agent-REPORTED evidence only).
 *
 * Everything this package parses is Claude Code's own account of a run (hooks, transcript, stream-json).
 * It never produces basis "observed" events. bin/kw-hook.mjs is the zero-dependency hook forwarder.
 */
export * from "./constants";
export * from "./types";
export { parseRunOutputs, extractTarget, transcriptPathsFromHookLog, REPORTED_LIMITATION } from "./parse";
export {
  SETTINGS_KEY_REGISTRY,
  DEFAULT_FILE_CHANGED_WATCH,
  MANAGED_SETTINGS_PATH_STATUS,
  ClaudeSettingsSchema,
  validateClaudeSettings,
  checkPermissionRule,
  compilePolicy,
  expandPattern,
  permissionsFromSafeguard,
  renderClaudeMdInstruction,
  applyClaudeMdInstruction,
  removeClaudeMdInstruction,
  renderHooks,
  forwarderHandler,
  renderClaudeSettings,
  type KeyStatus,
  type KeyInfo,
  type ClaudeSettings,
  type HookHandler,
  type KeyReportEntry,
  type SettingsValidation,
  type KwPolicy,
  type CompiledRule,
  type PolicyCompilation,
  type SafeguardPermissions,
  type EnforcementHook,
  type RenderSettingsOptions,
  type RenderedSettings,
} from "./settings";
export {
  ClaudeCodeAdapter,
  REPORTED_FIELD_CAPABILITIES,
  toSchemaEvents,
  type FieldAvailability,
  type FieldCapability,
  type PrepareWorkspaceOptions,
  type PrepareWorkspaceResult,
  type BuildCommandInput,
  type BuiltCommand,
} from "./adapter";
