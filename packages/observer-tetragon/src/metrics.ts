import { TETRAGON_CONTAINER, TETRAGON_METRICS_ADDR } from "./config";
import { docker } from "./docker";

/** Tetragon counters that indicate lost/dropped events (VM-wide, not per container). */
export const LOSS_METRICS = [
  "tetragon_observer_ringbuf_events_lost_total",
  "tetragon_observer_ringbuf_queue_events_lost_total",
  "tetragon_observer_ringbuf_errors_total",
  // Listener/export buffer overflow: events reached the agent but never the export file (~46% at 20k opens in the
  // isolation probes). Without this counter a burst looks loss-free.
  "tetragon_notify_overflowed_events_total",
  "tetragon_export_ratelimit_events_dropped_total",
  "tetragon_missed_prog_probes_total",
  "tetragon_missed_link_probes_total",
] as const;

export type LossSnapshot = Record<string, number> | null;

/** Scrape Tetragon's metrics through `docker exec` (kw-tetragon has no network). null = unreachable. */
export async function lossSnapshot(): Promise<LossSnapshot> {
  const r = await docker(["exec", TETRAGON_CONTAINER, "wget", "-qO-", "-T", "3", `http://${TETRAGON_METRICS_ADDR}/metrics`], { timeoutMs: 10_000 });
  if (r.code !== 0 || !r.stdout.includes("tetragon_")) return null;
  const out: Record<string, number> = {};
  for (const name of LOSS_METRICS) out[name] = 0;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("#")) continue;
    const m = /^([a-z_]+)(\{[^}]*\})?\s+([0-9.eE+-]+)$/.exec(line.trim());
    if (!m) continue;
    if ((LOSS_METRICS as readonly string[]).includes(m[1]!)) out[m[1]!] = (out[m[1]!] ?? 0) + Number(m[3]);
  }
  return out;
}

/** True when any loss counter rose over the capture window (VM-wide: may include other containers' events). */
export function isLossy(delta: Record<string, number> | null): boolean {
  return !!delta && Object.values(delta).some((v) => v !== 0);
}

export function lossDelta(a: LossSnapshot, b: LossSnapshot): Record<string, number> | null {
  if (!a || !b) return null;
  const out: Record<string, number> = {};
  for (const k of LOSS_METRICS) out[k] = (b[k] ?? 0) - (a[k] ?? 0);
  return out;
}
