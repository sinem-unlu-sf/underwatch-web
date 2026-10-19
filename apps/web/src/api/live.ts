/**
 * Live feed of a supervised run (GET /api/runs/:id/live?after=<seq>). The contract now lives in the shared
 * @kw/schema package (LiveFeedResponse / apiPaths.runLive); this module re-exports the web-facing types and the
 * path helper so the Live page has a single import surface.
 */
import { apiPaths, type LiveFeedResponse, type LiveAlert, type LiveItem, type LiveLane, type LiveFeedStatus } from "@kw/schema";

export type { LiveFeedResponse, LiveAlert, LiveItem, LiveLane };
/** Alias: the Live page refers to the stream status as LiveStatus. */
export type LiveStatus = LiveFeedStatus;

export const livePath = (runId: string, after: number) => `${apiPaths.runLive(runId)}?after=${encodeURIComponent(String(after))}`;
