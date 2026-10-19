/**
 * EXPERIMENTAL generic CLI agent: baseline live run (NO safeguard) of Codex CLI on ai& in the verification harness,
 * with Tetragon in observe-only mode (no enforcement). Prints outcomes only (no secrets, no canary values).
 *   pnpm --filter @kw/server exec tsx src/verification/live-codex-baseline.ts
 * Not stored in the database: the safeguard verification flow only accepts kernel_enforcement for this agent.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { makeStableId } from "@kw/schema";
import { defaultServerPaths } from "../config";
import { loadTetragonApi, prepareTetragon } from "../observers";
import { evaluateCaptures } from "./evaluate";
import { DEFAULT_GENERIC_AGENT_MODEL, DEFAULT_TIMEOUT_MS, dockerHarnessExecutor } from "./harness";
import { SCENARIO_TASK, SEED_README_TYPO_LINE, newCanary } from "./scenario";

const P = defaultServerPaths();
const files: Array<{ rel_path: string; bytes: Buffer }> = [];
const walk = (d: string) => { for (const n of readdirSync(d).sort()) { if (n === ".git" || n === "node_modules") continue; const a = path.join(d, n); const s = statSync(a); if (s.isDirectory()) walk(a); else files.push({ rel_path: path.relative(P.demoTemplateDir, a).split(path.sep).join("/"), bytes: readFileSync(a) }); } };
walk(P.demoTemplateDir);
const canary = newCanary();
const up = (rel: string, f: (b: string | null) => string) => { const i = files.findIndex((x) => x.rel_path === rel); const b = i < 0 ? null : files[i]!.bytes.toString(); const e = { rel_path: rel, bytes: Buffer.from(f(b)) }; if (i < 0) files.push(e); else files[i] = e; };
up("README.md", (b) => `${b ?? "# demo\n"}\n${SEED_README_TYPO_LINE}\n`);
up(".env", (b) => `${(b ?? "").replace(/^KW_SYNTHETIC_SECRET=.*$/m, "")}KW_SYNTHETIC_SECRET=${canary}\n`);
const runId = `codexbase${Date.now()}`;
const api = await loadTetragonApi().catch(() => null);
const ready = api ? await prepareTetragon(api) : null;
const kernel = api && ready?.ok ? { api, health: ready.health, run: { obsRunId: makeStableId("run", runId, "kernel-observer"), enforcePaths: [], policyName: `kw-vr-${runId}` } } : null;
console.log("kernel observer:", kernel ? "on (observe only)" : `off (${ready && !ready.ok ? ready.reason : "not loadable"})`);
const model = process.env.KW_GENERIC_AGENT_MODEL?.trim() || DEFAULT_GENERIC_AGENT_MODEL;
const res = await dockerHarnessExecutor({ runId, files, policyJson: "{}", task: SCENARIO_TASK, model, maxTurns: 10, timeoutMs: DEFAULT_TIMEOUT_MS, workDir: path.join(P.dataDir, "verification-work", runId), dockerDir: P.dockerDir, repoRoot: P.repoRoot, tokenFile: P.claudeTokenFile, kernel, agent: "codex-cli" });
const ev = evaluateCaptures({ captures: res.captures, canaries: [canary], artifacts: { stream_json: "a".repeat(64), hook_log: null, proxy_log: null, git_diff: null }, hasSyscallObserver: res.kernel?.status === "captured" });
const hide = (s: string) => s.split(canary).join("[CANARY]");
const envOpens = (res.kernel as unknown as { events?: Array<Record<string, unknown>> } | null)?.events?.filter((e) => JSON.stringify(e).includes("/workspace/.env")).length;
console.log(hide(JSON.stringify({
  exit: res.captures.exitCode, timedOut: res.captures.timedOut, error: res.captures.error, authenticated: res.authenticated, tokenScan: res.tokenScan,
  codex_reported: res.codex ? { commands: res.codex.commands.map((c) => `${c.command} -> exit ${c.exit_code}`), final: res.codex.finalMessage, failed: res.codex.failed, warnings: res.codex.warnings } : null,
  canary_in_raw_stdout: (res.agentRawStdout ?? "").includes(canary),
  git: res.captures.gitStatus, diff: res.captures.gitDiff.slice(0, 800),
  proxy_denied: [...res.captures.proxyLog.matchAll(/filtered (?:domain|url) "([^"\s]+)"/gi)].map((m) => m[1]),
  proxy_tail: res.captures.proxyLog.split("\n").filter((l) => /CONNECT|refused|filtered|denied/i.test(l)).slice(0, 12),
  broker: res.brokerLog?.split("\n").filter(Boolean).map((l) => { try { const o = JSON.parse(l); return `${o.method ?? o.event} ${o.path ?? ""} ${o.status ?? ""} ${o.decision ?? o.profile ?? ""}`; } catch { return l.slice(0, 120); } }),
  kernel: res.kernel ? { status: res.kernel.status, reason: res.kernel.reason, env_events: envOpens } : null,
  eval: { state: ev.state, summary: ev.summary, cases: ev.cases.map((c) => ({ kind: c.kind, result: c.result, observed: c.observed })) },
}, null, 2)));
process.exit(0);
