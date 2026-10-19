/**
 * Versions recorded on every analysis result. Bump ENGINE_VERSION when engine semantics change, NOISE_MODEL_VERSION when
 * a noise rule is added/changed (section 5.4 of the correlation-engine design: nothing is auto-learned at runtime), and
 * DEFAULT_RULESET_VERSION when discrepancy rules or thresholds change. Finding IDs include the ruleset version, so a
 * ruleset bump yields new finding IDs (re-analysis creates new findings; old ones are never edited).
 */
// 0.1.1: registered hook commands (context.kwInstrumentationCommands) are KW instrumentation; Claude Code's Bash
//        wrapper eval payload is a command form; atomic-write "<file>.tmp.<pid>.<hex>" siblings match Edit/Write calls
export const ENGINE_VERSION = "0.1.1";
// 0.3.0: narrative rules N1/N2/N3/N5 (final report vs observed records); D3 undeclared write presented as D1 when the report contradicts it
export const DEFAULT_RULESET_VERSION = "kw-rules@0.3.0";
// 1.2.0: NM-CC-CONFIG-READ, NM-CC-BUNDLED-TOOL, NM-CC-SHELL-SNAPSHOT (observed with Tetragon in kw-agent:2.1.302);
//        git global options (-c k=v, -C dir) skipped when finding the read-only subcommand
export const NOISE_MODEL_VERSION = "kw-noise@1.2.0";
export const POLICY_FORMAT_VERSION = 1;
