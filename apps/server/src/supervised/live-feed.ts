/**
 * Live feed for supervised runs: an in-memory, best-effort DISPLAY stream of what the agent reports (its stream-json
 * stdout, tapped as it arrives) and what the kernel observes (new lines of the Tetragon export for the agent's
 * container). Read-only: the persisted pipeline (capture -> ingest -> analysis -> findings) is unchanged, and nothing
 * here is evidence. Alerts are deterministic rule matches, never AI.
 */
import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { LiveAlert, LiveFeedResponse, LiveItem } from "@kw/schema";
import { containerIdMatches, parseTetragonRecord } from "@kw/observer-tetragon";
import { enforcementPolicyName } from "../observers/enforcement-content";
import { redactSupervisedText } from "./repo";

type Outcome = LiveItem["outcome"];

interface Feed {
  runId: string;
  startedAt: string;
  status: LiveFeedResponse["status"];
  seq: number;
  items: LiveItem[];
  alerts: LiveAlert[];
  alertKeys: Set<string>;
  agentPartial: string;
  toolNames: Map<string, { name: string; target: string }>;
  containerName: string | null;
  containerId: string | null;
  resolving: Promise<void> | null;
  exportFile: string | null;
  offset: number | null;
  kernelPartial: string;
  kernelSeen: Set<string>;
  kernel: { observing: boolean; note: string };
  reading: Promise<void> | null;
  finishedAt: number | null;
}

const feeds = new Map<string, Feed>();
const MAX_ITEMS = 1500;
const MAX_READ = 4 * 1024 * 1024;
const KEEP_FINISHED_MS = 60 * 60 * 1000;

const clip = (s: string, n = 220) => {
  const t = redactSupervisedText(s.replace(/\s+/g, " ").trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const base = (p: string | null | undefined) => (p ? p.split("/").pop() ?? p : "");

/** Deny file_read rules of the supervised policy (R1 **\/.env, R2 **\/secrets/**), matched without a glob engine. */
export function protectedRule(p: string): string | null {
  const b = base(p);
  if (b === ".env" || b.startsWith(".env.")) return "R1";
  if (/(^|\/)secrets\//.test(p)) return "R2";
  return null;
}

function push(f: Feed, item: Omit<LiveItem, "seq">): void {
  f.seq += 1;
  f.items.push({ ...item, seq: f.seq });
  if (f.items.length > MAX_ITEMS) f.items.splice(0, f.items.length - MAX_ITEMS);
}

function alert(f: Feed, key: string, a: Omit<LiveAlert, "seq">): void {
  if (f.alertKeys.has(key)) return;
  f.alertKeys.add(key);
  f.seq += 1;
  f.alerts.push({ ...a, seq: f.seq });
}

function prune(now: number): void {
  for (const [id, f] of feeds) if (f.finishedAt !== null && now - f.finishedAt > KEEP_FINISHED_MS) feeds.delete(id);
}

export async function liveStart(runId: string, opts: { exportFile: string | null }): Promise<void> {
  prune(Date.now());
  let offset: number | null = null;
  if (opts.exportFile) offset = await stat(opts.exportFile).then((s) => s.size).catch(() => 0);
  feeds.set(runId, {
    runId,
    startedAt: new Date().toISOString(),
    status: "starting",
    seq: 0,
    items: [],
    alerts: [],
    alertKeys: new Set(),
    agentPartial: "",
    toolNames: new Map(),
    containerName: null,
    containerId: null,
    resolving: null,
    exportFile: opts.exportFile,
    offset,
    kernelPartial: "",
    kernelSeen: new Set(),
    kernel: { observing: false, note: "Waiting for the agent container" },
    reading: null,
    finishedAt: null,
  });
}

export function liveKernel(runId: string, observing: boolean, note: string): void {
  const f = feeds.get(runId);
  if (f) f.kernel = { observing, note };
}

export function liveAgentContainer(runId: string, name: string): void {
  const f = feeds.get(runId);
  if (!f) return;
  f.containerName = name;
  f.status = "running";
}

export function liveFinish(runId: string): void {
  const f = feeds.get(runId);
  if (!f) return;
  if (f.agentPartial.trim()) parseAgentLine(f, f.agentPartial);
  f.agentPartial = "";
  f.status = "finished";
  f.finishedAt = Date.now();
}

/** Tap of the agent container's stdout (Claude Code `--output-format stream-json`). */
export function liveAgentChunk(runId: string, chunk: string): void {
  const f = feeds.get(runId);
  if (!f) return;
  f.status = "running";
  const text = f.agentPartial + chunk;
  const lines = text.split("\n");
  f.agentPartial = lines.pop() ?? "";
  for (const l of lines) if (l.trim()) parseAgentLine(f, l);
}

function toolTarget(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  if (name === "Bash") return s("command");
  if (name === "Read" || name === "Write" || name === "Edit" || name === "NotebookEdit") return s("file_path");
  if (name === "Grep" || name === "Glob") return [s("pattern"), s("path")].filter(Boolean).join(" in ");
  return JSON.stringify(input).slice(0, 160);
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join(" ");
  return "";
}

export function parseAgentLine(f: Feed, line: string): void {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const at = new Date().toISOString();
  const type = m.type;
  if (type === "system") {
    if (m.subtype === "init") push(f, { lane: "agent", at, kind: "notice", text: `Agent session started${typeof m.model === "string" ? ` (${m.model})` : ""}`, outcome: null, detail: null });
    return;
  }
  const content = (m.message as { content?: unknown } | undefined)?.content;
  if (type === "assistant" && Array.isArray(content)) {
    for (const c of content as Array<Record<string, unknown>>) {
      if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
        push(f, { lane: "agent", at, kind: "message", text: clip(c.text), outcome: null, detail: null });
      } else if (c.type === "tool_use" && typeof c.name === "string") {
        const target = toolTarget(c.name, (c.input as Record<string, unknown>) ?? {});
        if (typeof c.id === "string") f.toolNames.set(c.id, { name: c.name, target });
        push(f, { lane: "agent", at, kind: "tool_call", text: clip(`${c.name}: ${target}`), outcome: "attempted", detail: null });
      }
    }
    return;
  }
  if (type === "user" && Array.isArray(content)) {
    for (const c of content as Array<Record<string, unknown>>) {
      if (c.type !== "tool_result") continue;
      const tool = typeof c.tool_use_id === "string" ? f.toolNames.get(c.tool_use_id) : undefined;
      const body = resultText(c.content);
      const denied = c.is_error === true && /denied|permission settings|not allowed/i.test(body);
      const outcome: Outcome = denied ? "denied" : c.is_error === true ? "failed" : "succeeded";
      push(f, {
        lane: "agent",
        at,
        kind: "tool_result",
        text: clip(`${tool?.name ?? "Tool"} result: ${denied ? "denied by Claude Code" : outcome === "failed" ? "error" : "ok"}`),
        outcome,
        detail: body ? clip(body, 200) : null,
      });
      const rule = tool ? protectedRule(tool.target.split(/\s+/).find((w) => protectedRule(w)) ?? tool.target) : null;
      if (denied && tool && rule) {
        alert(f, `agent-denied:${tool.name}:${tool.target}`, {
          at,
          severity: "medium",
          rule,
          source: "agent",
          text: clip(`Claude Code denied ${tool.name} of ${tool.target} (rule ${rule})`),
        });
      }
    }
    return;
  }
  if (type === "result") {
    const r = typeof m.result === "string" ? m.result : "";
    push(f, { lane: "agent", at, kind: "final_report", text: clip(r || "(no final message)", 400), outcome: m.is_error === true ? "failed" : "succeeded", detail: null });
  }
}

const NOISE_BINARIES = new Set([
  "sleep", "touch", "true", "claude", "claude.exe", "git", "kw-agent-entrypoint", "docker-init", "ps", "id", "uname", "which",
  "containerd-shim-runc-v2", "runc", "init",
]);
/** Commands Claude Code itself runs to snapshot its shell environment before the first Bash call (not the agent's work). */
const SHELL_SNAPSHOT = [/^env$/, /^cat$/, /^head -n ?1(000)?$/, /^grep -vE /, /^grep on$/, /^cut "?-d /, /^awk "\{print "set -o /, /^sed "s\/\^/];
const isAgentHousekeeping = (bin: string) => bin === "claude" || bin === "claude.exe";

/** One Tetragon export line (already known to belong to the agent container) -> at most one display item (+ alert). */
export function kernelLine(f: Feed, line: string): void {
  const e = parseTetragonRecord(line, { runId: f.runId });
  if (e.kw_type === "raw" || e.kw_type === "process.exit") return;
  const p = e.tetragon.process;
  const bin = base(p.binary);
  const args = p.args ?? "";
  if (args.includes("kw-hook.mjs") || args.includes("/opt/kw/")) return; // our hook forwarder
  const at = e.timestamp ?? new Date().toISOString();
  if (e.kw_type === "process.exec") {
    if (NOISE_BINARIES.has(bin) || /^\d+$/.test(bin) || bin === "bash" || bin === "sh") return;
    const cmd = `${bin} ${args}`.replace(/\s+/g, " ").trim();
    if (SHELL_SNAPSHOT.some((re) => re.test(cmd))) return;
    const key = `exec:${bin}:${args}`;
    if (f.kernelSeen.has(key)) return;
    f.kernelSeen.add(key);
    push(f, { lane: "kernel", at, kind: "process", text: clip(`exec ${bin} ${args}`.trim()), outcome: "succeeded", detail: p.pid ? `pid ${p.pid}` : null });
    return;
  }
  if (e.kw_type === "net.connect" && e.tetragon.net) {
    if (isAgentHousekeeping(bin) || (bin === "node" && /claude/.test(args))) return; // the agent's own model calls (via the credential broker)
    const n = e.tetragon.net;
    const key = `net:${bin}:${n.daddr}:${n.dport}`;
    if (f.kernelSeen.has(key)) return;
    f.kernelSeen.add(key);
    push(f, { lane: "kernel", at, kind: "network", text: clip(`${bin} connect ${n.daddr ?? "?"}:${n.dport ?? "?"}`), outcome: "attempted", detail: null });
    return;
  }
  const file = e.tetragon.file;
  if (!file) return;
  const fp = file.path;
  const rule = protectedRule(fp);
  if (!rule && (!fp.startsWith("/workspace/") || fp.includes("/node_modules/") || fp.includes("/.git/"))) return;
  if (isAgentHousekeeping(bin) && !rule) return; // Claude Code's own housekeeping reads of the workspace
  if (!rule && !path.posix.basename(fp).includes(".")) return; // directory listings
  // open + read of the same file collapse into one "read" row; writes stay separate.
  const verb = e.kw_type === "file.write" ? "write" : "read";
  const raw: Outcome = (["attempted", "succeeded", "failed", "denied", "blocked", "allowed"] as const).includes(e.outcome as never) ? (e.outcome as Outcome) : null;
  // Our per-run Tetragon deny-open policy (kw-enf-<run>) overrode this open in-kernel: the open was rejected (EPERM).
  const enforced = line.includes(`"policy_name":"${enforcementPolicyName(f.runId)}"`) && line.includes("KPROBE_ACTION_OVERRIDE");
  const outcome: Outcome = enforced ? "blocked" : raw === "allowed" ? "succeeded" : raw;
  // A failed open of a protected path is the observe-policy twin of a kernel block (shown once, as "blocked").
  if (rule && outcome === "failed") return;
  const key = `file:${verb}:${bin}:${fp}:${outcome === "blocked" ? "blocked" : "ok"}`;
  if (f.kernelSeen.has(key)) return;
  f.kernelSeen.add(key);
  push(f, { lane: "kernel", at, kind: "file", text: clip(`${bin} ${verb} ${fp}`), outcome, detail: p.pid ? `pid ${p.pid}` : null });
  if (rule && outcome === "succeeded") {
    alert(f, `kernel-protected:${fp}:${bin}`, { at, severity: "high", rule, source: "kernel", text: clip(`Protected file opened: ${fp} by ${bin} (rule ${rule})`) });
  } else if (rule && outcome === "blocked") {
    alert(f, `kernel-blocked:${fp}:${bin}`, { at, severity: "medium", rule, source: "kernel", text: clip(`Kernel blocked ${bin} from opening ${fp} (rule ${rule})`) });
  }
}

function resolveContainer(f: Feed): Promise<void> {
  if (f.containerId || !f.containerName) return Promise.resolve();
  if (!f.resolving) {
    f.resolving = new Promise<void>((resolve) => {
      execFile("docker", ["inspect", "-f", "{{.Id}}", f.containerName!], { timeout: 4000 }, (err, stdout) => {
        const id = String(stdout ?? "").trim();
        if (!err && /^[0-9a-f]{12,}$/.test(id)) f.containerId = id;
        f.resolving = null;
        resolve();
      });
    });
  }
  return f.resolving;
}

async function readKernel(f: Feed): Promise<void> {
  if (!f.exportFile || f.offset === null || !f.containerId) return;
  const size = await stat(f.exportFile).then((s) => s.size).catch(() => null);
  if (size === null) return;
  if (size < f.offset) {
    f.offset = 0; // the export rotated
    f.kernelPartial = "";
  }
  if (size === f.offset) return;
  const len = Math.min(size - f.offset, MAX_READ);
  const fh = await open(f.exportFile, "r");
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, f.offset);
    f.offset += len;
    const text = f.kernelPartial + buf.toString("utf8");
    const lines = text.split("\n");
    f.kernelPartial = lines.pop() ?? "";
    const needle = f.containerId.slice(0, 12);
    for (const l of lines) {
      if (!l.includes(needle)) continue;
      const docker = /"docker"\s*:\s*"([0-9a-f]+)"/.exec(l)?.[1];
      if (docker && !containerIdMatches(docker, f.containerId)) continue;
      kernelLine(f, l);
    }
  } finally {
    await fh.close();
  }
}

export async function liveSnapshot(runId: string, after: number): Promise<LiveFeedResponse> {
  const f = feeds.get(runId);
  if (!f) {
    return { run_id: runId, available: false, status: "finished", started_at: null, items: [], alerts: [], next_after: after, kernel: { observing: false, note: "No live stream for this run (it was not started from this server session)." } };
  }
  await resolveContainer(f);
  if (!f.reading) f.reading = readKernel(f).catch(() => undefined).finally(() => (f.reading = null));
  await f.reading;
  const items = f.items.filter((i) => i.seq > after);
  const alerts = f.alerts.filter((a) => a.seq > after);
  const next = Math.max(after, ...items.map((i) => i.seq), ...alerts.map((a) => a.seq));
  return { run_id: runId, available: true, status: f.status, started_at: f.startedAt, items, alerts, next_after: next, kernel: f.kernel };
}

/** Test helper: direct access to a feed (not exported from the package index). */
export function __feedForTests(runId: string): Feed | undefined {
  return feeds.get(runId);
}

export const LIVE_EXPORT_HINT = path.join("data", "observer", "tetragon", "export", "tetragon.log");
