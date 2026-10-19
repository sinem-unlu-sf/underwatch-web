import { cmpStr, uniqSorted } from "./canonical";
import type { AnalysisContext } from "./context";
import type { TimedEvent } from "./observations";
import { canonicalizePath } from "./paths";
import { splitHostPort } from "./policy";
import type { Diagnostic, ReportedCall, ReportedOutcome } from "./types";

export const FILE_READ_TOOLS = new Set(["Read"]);
export const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
export const SEARCH_TOOLS = new Set(["Glob", "Grep"]);
export const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
export const NET_TOOLS = new Set(["WebFetch"]);

/** Live channels outrank the transcript (agent-writable during the run; integrity-security design T-03). */
const SOURCE_PRIORITY: Record<string, number> = { claude_code_hooks: 0, claude_code_otel: 1, claude_code_transcript: 2 };
function prio(s: string): number {
  return SOURCE_PRIORITY[s] ?? 9;
}

/**
 * Merge every agent-reported record sharing a tool_use_id (hook PreToolUse/PostToolUse, transcript entries, ...) into one
 * reported call. Reported timestamps are KW receipt times for hooks (payloads carry no timestamp; probe-observed) and
 * agent-asserted for transcripts, so windows get the configured skew tolerance downstream.
 *
 * Reported outcome:
 *   denied     any permission_decision or tool_result with outcome denied/blocked (denials fire PreToolUse but not
 *              PostToolUseFailure: probe-observed in research/claude-code/probe-out/correlation-table.md)
 *   error      tool_result failed
 *   success    tool_result succeeded
 *   no_result  none of the above (killed, crashed, run ended, or the result channel was not captured)
 */
export function buildReportedCalls(
  reported: TimedEvent[],
  ctx: AnalysisContext,
  runEnd: number,
  diagnostics: Diagnostic[],
): { calls: ReportedCall[]; contextEventIds: string[] } {
  const byId = new Map<string, TimedEvent[]>();
  const contextEventIds: string[] = [];
  for (const te of reported) {
    const id = te.e.tool_use_id;
    if (!id) {
      contextEventIds.push(te.e.id);
      continue;
    }
    const list = byId.get(id) ?? [];
    list.push(te);
    byId.set(id, list);
  }
  const starts = [...byId.values()].map((l) => Math.min(...l.map((x) => x.t))).sort((a, b) => a - b);
  const calls: ReportedCall[] = [];
  for (const [toolUseId, list] of [...byId.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
    const byPrio = [...list].sort((a, b) => prio(a.e.source) - prio(b.e.source) || a.t - b.t || cmpStr(a.e.id, b.e.id));
    const toolName = byPrio.find((x) => x.e.tool_name)?.e.tool_name ?? null;
    const callRecords = byPrio.filter((x) => x.e.event_type === "tool_call");
    const targetSrc = (callRecords.length ? callRecords : byPrio).filter((x) => x.e.target_resource);
    const target = targetSrc[0]?.e.target_resource ?? null;
    const conflicts: string[] = [];
    const distinctTargets = uniqSorted(targetSrc.filter((x) => x.e.event_type === "tool_call").map((x) => x.e.target_resource!));
    if (distinctTargets.length > 1) {
      conflicts.push(`reported channels disagree on the target: ${distinctTargets.join(" | ")}`);
      diagnostics.push({
        code: "agent_record_conflict",
        message: `Agent-side records for ${toolUseId} disagree on the target (${distinctTargets.join(" | ")}); the live hook record is used for matching.`,
        event_ids: uniqSorted(list.map((x) => x.e.id)),
      });
    }
    const start = Math.min(...list.map((x) => x.t));
    const resultRecs = list.filter((x) => x.e.event_type === "tool_result" || x.e.event_type === "permission_decision");
    const denied = resultRecs.filter((x) => x.e.outcome === "denied" || x.e.outcome === "blocked");
    const results = list.filter((x) => x.e.event_type === "tool_result");
    let outcome: ReportedOutcome = "no_result";
    let outcomeEvents: TimedEvent[] = [];
    if (denied.length) {
      outcome = "denied";
      outcomeEvents = denied;
    } else if (results.some((x) => x.e.outcome === "failed")) {
      outcome = "error";
      outcomeEvents = results.filter((x) => x.e.outcome === "failed");
    } else if (results.some((x) => x.e.outcome === "succeeded")) {
      outcome = "success";
      outcomeEvents = results.filter((x) => x.e.outcome === "succeeded");
    }
    let end: number;
    let openEnded = false;
    if (results.length || denied.length) end = Math.max(...[...results, ...denied].map((x) => x.t));
    else {
      const next = starts.find((s) => s > start);
      end = next ?? runEnd;
      openEnded = true;
    }
    const isFile = toolName !== null && (FILE_READ_TOOLS.has(toolName) || FILE_WRITE_TOOLS.has(toolName) || SEARCH_TOOLS.has(toolName));
    const path = isFile && target ? canonicalizePath(target, ctx) : null;
    let host: string | null = null;
    if (toolName !== null && NET_TOOLS.has(toolName) && target) host = splitHostPort(target).host || null;
    calls.push({
      toolUseId,
      toolName,
      target,
      path,
      host,
      eventIds: uniqSorted(list.map((x) => x.e.id)),
      sources: uniqSorted(list.map((x) => x.e.source)),
      start,
      end: Math.max(end, start),
      openEnded,
      outcome,
      outcomeEventIds: uniqSorted(outcomeEvents.map((x) => x.e.id)),
      agentId: list.find((x) => x.d.agent_id)?.d.agent_id ?? null,
      evidenceIds: uniqSorted(list.map((x) => x.e.evidence_id).filter((x): x is string => x !== null)),
      conflicts,
    });
  }
  return { calls, contextEventIds: contextEventIds.sort(cmpStr) };
}
