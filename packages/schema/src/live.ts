/**
 * LIVE FEED of a supervised run (GET /api/runs/:id/live). In-memory, best-effort DISPLAY stream built while the run
 * is in progress: the agent lane parses Claude Code's stream-json as it arrives (agent-REPORTED), the kernel lane
 * tails the Tetragon export for the agent container (OBSERVED). Alerts are deterministic (policy rules, no AI).
 * Nothing here is persisted; the persisted pipeline (capture -> ingest -> analysis -> findings) is unchanged and is
 * the record of the run. `available: false` = no live feed for that run id (server restarted, run predates the feed).
 */
import { z } from "zod";

export const LiveFeedQuery = z.object({
  /** Return only items/alerts with seq > after. */
  after: z.coerce.number().int().nonnegative().default(0),
});
export type LiveFeedQuery = z.infer<typeof LiveFeedQuery>;
export type LiveFeedQueryInput = z.input<typeof LiveFeedQuery>;

export const LiveFeedStatus = z.enum(["starting", "running", "finished"]);
export type LiveFeedStatus = z.infer<typeof LiveFeedStatus>;

export const LiveLane = z.enum(["agent", "kernel"]);
export type LiveLane = z.infer<typeof LiveLane>;

export const LiveItemKind = z.enum(["tool_call", "tool_result", "message", "final_report", "process", "file", "network", "notice"]);
export type LiveItemKind = z.infer<typeof LiveItemKind>;

export const LiveOutcome = z.enum(["attempted", "succeeded", "failed", "denied", "blocked", "allowed"]);
export type LiveOutcome = z.infer<typeof LiveOutcome>;

export const LiveItem = z.object({
  seq: z.number().int().positive(),
  lane: LiveLane,
  at: z.string(),
  kind: LiveItemKind,
  text: z.string(),
  outcome: LiveOutcome.nullable(),
  detail: z.string().nullable(),
});
export type LiveItem = z.infer<typeof LiveItem>;

export const LiveAlert = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  severity: z.enum(["high", "medium"]),
  rule: z.string().nullable(),
  source: z.enum(["kernel", "agent"]),
  text: z.string(),
});
export type LiveAlert = z.infer<typeof LiveAlert>;

export const LiveFeedResponse = z.object({
  run_id: z.string(),
  available: z.boolean(),
  status: LiveFeedStatus,
  started_at: z.string().nullable(),
  items: z.array(LiveItem),
  alerts: z.array(LiveAlert),
  /** Highest seq included in this response (or `after` when nothing new). Pass it back as `after`. */
  next_after: z.number().int().nonnegative(),
  kernel: z.object({ observing: z.boolean(), note: z.string() }),
});
export type LiveFeedResponse = z.infer<typeof LiveFeedResponse>;
