import { readFileSync } from "node:fs";
import { parseRunOutputs, type ParseContext, type ParseResult } from "../src/index";

export const CAPTURES = new URL("./fixtures/captures/", import.meta.url);
export const RUNS = ["run1", "run2", "run3"] as const;
export type RunName = (typeof RUNS)[number];

export function readCapture(run: RunName, file: string): string {
  return readFileSync(new URL(`${run}/${file}`, CAPTURES), "utf8");
}

export function captureInputs(run: RunName) {
  return {
    hookLog: { text: readCapture(run, "hooks.jsonl"), label: `${run}/hooks.jsonl` },
    transcript: { text: readCapture(run, "transcript.jsonl"), label: `${run}/transcript.jsonl` },
    streamJson: { text: readCapture(run, "stream.jsonl"), label: `${run}/stream.jsonl` },
  };
}

export function ctxFor(run: string, extra: Partial<ParseContext> = {}): ParseContext {
  return { run_id: `run_capture_${run}`, fallback_timestamp: "2026-10-17T01:00:00.000Z", is_fixture: true, ...extra };
}

export function parseCapture(run: RunName, extra: Partial<ParseContext> = {}): ParseResult {
  return parseRunOutputs(captureInputs(run), ctxFor(run, extra));
}

/** tool_use ids as the model emitted them, read straight from the raw stream-json capture. */
export function capturedToolUseIds(run: RunName): string[] {
  const ids: string[] = [];
  for (const line of readCapture(run, "stream.jsonl").split("\n")) {
    if (!line.trim()) continue;
    const d = JSON.parse(line) as { type?: string; message?: { content?: Array<{ type?: string; id?: string }> } };
    if (d.type !== "assistant") continue;
    for (const b of d.message?.content ?? []) if (b.type === "tool_use" && b.id) ids.push(b.id);
  }
  return ids;
}
