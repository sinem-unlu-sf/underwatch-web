/**
 * EXPERIMENTAL generic CLI agent (Codex CLI) - translate `codex exec --json` JSONL (agent stdout, captured by the host)
 * into the Claude stream-json shape that evaluate.ts/parseStreamJson already understands, so evaluateCaptures() runs
 * unchanged. Every translated record is AGENT-REPORTED (the agent's own stdout), never an OS observation.
 *
 * Codex 0.163.0 event shapes (observed in a probe on 2026-10-17):
 *   {"type":"thread.started","thread_id":...}
 *   {"type":"item.started"|"item.completed","item":{"id","type":"command_execution","command","aggregated_output","exit_code","status"}}
 *   {"type":"item.completed","item":{"id","type":"agent_message","text"}}
 *   {"type":"item.completed","item":{"id","type":"error","message"}}      (config/metadata warnings)
 *   {"type":"turn.completed","usage":{...}} | {"type":"turn.failed",...} | {"type":"error",...}
 * file_change items are documented but were not exercised in the probe; they map to an "Edit" tool_use.
 */
export interface CodexTranslation {
  /** Claude-stream-json-shaped NDJSON for evaluateCaptures(). */
  streamJson: string;
  finalMessage: string | null;
  commands: Array<{ id: string; command: string; exit_code: number | null; status: string }>;
  warnings: string[];
  failed: boolean;
  parseErrors: number;
}

export function translateCodexJsonl(raw: string, meta: { model: string; codexVersion: string }): CodexTranslation {
  const out: string[] = [];
  const commands: CodexTranslation["commands"] = [];
  const warnings: string[] = [];
  let finalMessage: string | null = null;
  let failed = false;
  let turns = 0;
  let parseErrors = 0;
  let hardError = false;
  const push = (o: unknown) => out.push(JSON.stringify(o));
  push({ type: "system", subtype: "init", model: meta.model, claude_code_version: null, permissionMode: "codex:danger-full-access(container-sandboxed)", kw_agent: `codex-cli ${meta.codexVersion}`, kw_translated: true });
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let m: any;
    try { m = JSON.parse(line); } catch { parseErrors++; continue; }
    if (m.type === "turn.completed") turns++;
    // [FACT-CHECK 2026-10-17] Codex 0.163.0 emits top-level {"type":"error","message":"Reconnecting... n/5 (...)"} for
    // every retry (401/429/5xx/unreachable) before it either recovers or emits turn.failed. A retry is not a failure:
    // only turn.failed, or a non-retry top-level error with no completed turn, marks the run failed.
    if (m.type === "turn.failed" || m.type === "error") {
      const msg = String(m.error?.message ?? m.message ?? m.type);
      warnings.push(msg.slice(0, 300));
      if (m.type === "turn.failed") failed = true;
      else if (!/^Reconnecting\.\.\./.test(msg)) hardError = true;
    }
    if (m.type !== "item.completed" || !m.item) continue;
    const it = m.item;
    if (it.type === "command_execution" && typeof it.command === "string") {
      commands.push({ id: it.id, command: it.command, exit_code: it.exit_code ?? null, status: String(it.status ?? "") });
      push({ type: "assistant", message: { content: [{ type: "tool_use", id: `codex_${it.id}`, name: "Bash", input: { command: it.command } }] } });
      push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `codex_${it.id}`, content: String(it.aggregated_output ?? ""), is_error: it.status === "failed" || (typeof it.exit_code === "number" && it.exit_code !== 0) }] } });
    } else if (it.type === "file_change") {
      const paths = Array.isArray(it.changes) ? it.changes.map((c: any) => c?.path).filter(Boolean) : [];
      push({ type: "assistant", message: { content: [{ type: "tool_use", id: `codex_${it.id}`, name: "Edit", input: { file_path: paths.join(", "), codex_item: "file_change" } }] } });
      push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `codex_${it.id}`, content: String(it.status ?? ""), is_error: it.status === "failed" }] } });
    } else if (it.type === "agent_message" && typeof it.text === "string") {
      finalMessage = it.text;
      push({ type: "assistant", message: { content: [{ type: "text", text: it.text }] } });
    } else if (it.type === "error" && typeof it.message === "string") {
      warnings.push(it.message.slice(0, 300));
    }
  }
  if (hardError && turns === 0) failed = true;
  push({ type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed, result: finalMessage ?? "", num_turns: turns, permission_denials: [] });
  return { streamJson: out.join("\n") + "\n", finalMessage, commands, warnings, failed, parseErrors };
}
