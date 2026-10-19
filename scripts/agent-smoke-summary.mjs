#!/usr/bin/env node
// Builds run.json for scripts/agent-smoke.sh from the host-side evidence dir.
// Pure parsing of files the host captured; never reads secrets. Fields that cannot be
// established from evidence are null with a reason, never invented.
//
//   node scripts/agent-smoke-summary.mjs <evidenceDir> <mode> <agentExit> <tokenScan> <name>
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SYNTHETIC_SECRET = 'kw-test-0000';

/** Parse preflight.txt ("P<n> <key>: <value>") into pass/fail checks. */
export function parsePreflight(text) {
  const line = (id) => text.split('\n').find((l) => l.startsWith(`${id} `)) ?? null;
  const val = (id) => {
    const l = line(id);
    if (l === null) return null;
    const i = l.indexOf(': ');
    return i < 0 ? '' : l.slice(i + 2).trim();
  };
  const exitOf = (v) => {
    const m = v && /exit=(\d+)/.exec(v);
    return m ? Number(m[1]) : null;
  };
  const connectOf = (v) => {
    const m = v && /connect=(\d{3})/.exec(v);
    return m ? m[1] : null;
  };
  const mk = (id, pass, observed) => ({ pass: observed === null ? null : pass, observed, ...(observed === null ? { reason: `${id} line missing from preflight.txt` } : {}) });

  const ver = val('P1');
  const p3 = val('P3');
  const p4 = val('P4');
  const p5 = val('P5');
  const p7 = val('P7');
  const p8 = val('P8');
  const p9 = val('P9');
  const p10 = val('P10');
  const p11 = val('P11');
  const p12 = val('P12');
  const p13 = val('P13');
  const p14 = val('P14');
  const p15 = val('P15');
  const p16 = val('P16');
  const httpOf = (v) => {
    const m = v && /http=(\d{3})/.exec(v);
    return m ? m[1] : null;
  };
  const mounts = (() => {
    const i = text.indexOf('P6 mounts:');
    if (i < 0) return null;
    return text.slice(i).split('\n').slice(1).filter((l) => l.startsWith('    ')).map((l) => l.trim());
  })();
  const roMount = (mp) => (mounts ? mounts.some((m) => m.startsWith(`${mp} `) && /(^|,)ro(,|$)/.test(m.split(' ')[1] ?? '')) : null);

  return {
    claude_version: mk('P1', ver !== null && /^\d+\.\d+\.\d+ \(Claude Code\)$/.test(ver), ver),
    policy_file_not_writable: mk('P3', p3 === 'denied', p3),
    policy_dropin_dir_not_writable: mk('P4', p4 === 'denied', p4),
    hook_forwarder_not_writable: mk('P5', p5 === 'denied', p5),
    policy_mount_read_only: { pass: roMount('/etc/claude-code'), observed: mounts },
    // Credential broker remediation: the agent has NO direct route to the Claude API.
    proxy_denies_api_direct: mk('P7', connectOf(p7) === '403', p7),
    proxy_denies_non_allowlisted: mk('P8', connectOf(p8) === '403', p8),
    proxy_denies_non_443_connect: mk('P9', connectOf(p9) === '403', p9),
    no_direct_https_without_proxy: mk('P10', exitOf(p10) !== null && exitOf(p10) !== 0, p10),
    no_direct_tcp: mk('P11', exitOf(p11) !== null && exitOf(p11) !== 0, p11),
    no_external_dns: mk('P12', exitOf(p12) !== null && exitOf(p12) !== 0, p12),
    broker_denies_non_allowlisted_path: mk('P13', httpOf(p13) === '403', p13),
    broker_denies_bad_run_credential: mk('P14', httpOf(p14) === '401', p14),
    broker_is_not_a_forward_proxy: mk('P15', p15 !== null && httpOf(p15) !== '200' && /connect=(000|4\d\d|5\d\d)|exit=[1-9]/.test(p15), p15),
    agent_env_has_only_placeholder_credential: mk('P16', p16 === 'oauth=placeholder api_key=unset auth_token=unset base_url=http://kw-llm-broker:8080', p16),
  };
}

/** Parse conformance.txt (repo settings must not override the managed tier). */
export function parseConformance(text) {
  const val = (id) => {
    const l = text.split('\n').find((x) => x.startsWith(`${id} `));
    if (!l) return null;
    const i = l.indexOf(': ');
    return i < 0 ? '' : l.slice(i + 2).trim();
  };
  const mk = (id, ok, v) => (v === null ? { pass: null, observed: null, reason: `${id} line missing from conformance.txt` } : { pass: ok(v), observed: v });
  return {
    managed_hooks_fire_despite_repo_disableAllHooks: mk('C1', (v) => /hook_started=([1-9]\d*)/.test(v), val('C1')),
    repo_hooks_blocked: mk('C2', (v) => v === 'absent', val('C2')),
    local_hooks_blocked: mk('C3', (v) => v === 'absent', val('C3')),
    repo_bypass_mode_not_applied: mk('C4', (v) => v !== 'unknown' && v !== 'bypassPermissions', val('C4')),
  };
}

/** Summarize tinyproxy (LogLevel Info) output captured via `docker logs --timestamps`. */
export function parseProxyLog(text) {
  const requests = [];
  const established = [];
  const refused = [];
  for (const l of text.split('\n')) {
    let m;
    if ((m = /Request \(file descriptor \d+\): (\S+) (\S+) HTTP/.exec(l))) requests.push(`${m[1]} ${m[2]}`);
    else if ((m = /Established connection to host "([^"]+)"/.exec(l))) established.push(m[1]);
    else if ((m = /Proxying refused on filtered domain "([^"]+)"/.exec(l))) refused.push({ host: m[1], reason: 'domain_not_allowlisted' });
    else if ((m = /Refused CONNECT method on port (\d+)/.exec(l))) refused.push({ port: Number(m[1]), reason: 'connect_port_not_allowed' });
  }
  return { requests, established, refused };
}

/** Count stream-json events by type/subtype; tolerate non-JSON lines. */
export function parseStream(text) {
  const byType = {};
  let nonJson = 0;
  let init = null;
  let result = null;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let o;
    try { o = JSON.parse(l); } catch { nonJson++; continue; }
    const k = o.subtype ? `${o.type}:${o.subtype}` : String(o.type);
    byType[k] = (byType[k] ?? 0) + 1;
    if (o.type === 'system' && o.subtype === 'init') init = { session_id: o.session_id ?? null, model: o.model ?? null, cwd: o.cwd ?? null, permissionMode: o.permissionMode ?? null, claude_code_version: o.claude_code_version ?? null };
    if (o.type === 'result') result = { subtype: o.subtype ?? null, is_error: o.is_error ?? null, num_turns: o.num_turns ?? null, terminal_reason: o.terminal_reason ?? null, total_cost_usd: o.total_cost_usd ?? null, permission_denials: Array.isArray(o.permission_denials) ? o.permission_denials.length : null };
  }
  return { byType, nonJson, init, result };
}

/**
 * Split the host-captured proxy log into the preflight-probe phase and the agent-run
 * phase using the byte offset the host recorded just before starting the agent
 * (egress-proxy.phases.txt: "agent_run_start_byte=<n>"). Without a valid offset the
 * agent-run view is null with a reason (never guessed from the combined log).
 */
export function splitProxyPhases(logBuf, phasesText) {
  const m = /agent_run_start_byte=(\d+)/.exec(phasesText || '');
  const all = parseProxyLog(logBuf.toString('utf8'));
  if (!m || Number(m[1]) > logBuf.length) {
    return { all, preflight: null, agent_run: null, reason: m ? 'agent_run_start_byte beyond end of egress-proxy.log' : 'egress-proxy.phases.txt missing or malformed' };
  }
  const off = Number(m[1]);
  return {
    all,
    preflight: parseProxyLog(logBuf.subarray(0, off).toString('utf8')),
    agent_run: parseProxyLog(logBuf.subarray(off).toString('utf8')),
    agent_run_start_byte: off,
  };
}

/** workspace_changed from the host snapshots; null with a reason when they are unusable. */
export function workspaceChange(before, after, diffText) {
  if (!before.trim()) return { changed: null, reason: 'workspace-before.sha256 missing or empty' };
  if (!after.trim()) return { changed: null, reason: 'workspace-after.sha256 missing or empty' };
  return { changed: before !== after, diff_lines: diffText.split('\n').filter((l) => /^[<>] /.test(l)).length };
}

/** Summarize the broker's metadata-only JSON log lines (docker/llm-broker/broker.mjs). */
export function parseBrokerLog(text) {
  const byDecision = {};
  const requests = [];
  let listening = false;
  for (const l of text.split('\n')) {
    const i = l.indexOf('{');
    if (i < 0) continue;
    let o;
    try { o = JSON.parse(l.slice(i)); } catch { continue; }
    if (o.kw !== 'llm-broker') continue;
    if (o.event === 'listening') { listening = true; continue; }
    if (!o.decision) continue;
    byDecision[o.decision] = (byDecision[o.decision] ?? 0) + 1;
    requests.push(`${o.method} ${o.path} ${o.status} ${o.decision}`);
  }
  return { listening, by_decision: byDecision, requests };
}

export function parseHooks(text) {
  const events = {};
  let lines = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    lines++;
    try {
      const o = JSON.parse(l);
      const e = o.hook_event_name ?? o.payload?.hook_event_name ?? 'unknown';
      events[e] = (events[e] ?? 0) + 1;
    } catch { events['<non-json>'] = (events['<non-json>'] ?? 0) + 1; }
  }
  return { lines, events };
}

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (s.isFile()) out.push(p);
  }
  return out;
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

export function summarize(dir, mode, agentExit, tokenScan, name) {
  const checks = { ...parsePreflight(read(join(dir, 'preflight.txt'))), ...parseConformance(read(join(dir, 'conformance.txt'))) };
  const stream = parseStream(read(join(dir, 'agent-stdout.stream.jsonl')));
  const hooks = parseHooks(read(join(dir, 'hooks.agent-reported.ndjson')));
  const proxyPath = join(dir, 'egress-proxy.log');
  const egress = splitProxyPhases(existsSync(proxyPath) ? readFileSync(proxyPath) : Buffer.alloc(0), read(join(dir, 'egress-proxy.phases.txt')));
  const proxy = egress.agent_run ?? egress.all;
  const brokerLog = read(join(dir, 'llm-broker.log'));
  const brokerAgentRun = (() => {
    const m = /agent_run_start_byte=(\d+)/.exec(read(join(dir, 'llm-broker.phases.txt')));
    return m ? parseBrokerLog(Buffer.from(brokerLog, 'utf8').subarray(Number(m[1])).toString('utf8')) : null;
  })();
  const ws = workspaceChange(read(join(dir, 'workspace-before.sha256')), read(join(dir, 'workspace-after.sha256')), read(join(dir, 'workspace-diff.txt')));
  const secretHits = walk(dir)
    .filter((p) => !p.includes(`${join(dir, 'inputs')}`) && !p.endsWith('.tar'))
    .filter((p) => read(p).includes(SYNTHETIC_SECRET))
    .map((p) => relative(dir, p));
  const preflightOk = Object.values(checks).every((c) => c.pass === true);
  const pipelineOk = stream.init !== null && (stream.byType['system:hook_started'] ?? 0) > 0 && hooks.lines > 0;
  const authOk = mode === 'authenticated' ? Number(agentExit) === 0 && stream.result !== null && stream.result.is_error === false : null;
  return {
    name,
    mode,
    authenticated_run: mode === 'authenticated' ? 'attempted' : mode === 'token-file-malformed' ? 'not attempted: token file is not a bare token (re-run claude setup-token)' : 'authenticated run pending user setup-token',
    agent_exit: Number(agentExit),
    token_scan: tokenScan,
    images: read(join(dir, 'images.txt')).trim().split('\n').filter(Boolean),
    networks: read(join(dir, 'networks.txt')).trim().split('\n').filter(Boolean),
    checks,
    stream: { by_type: stream.byType, non_json_lines: stream.nonJson, init: stream.init, result: stream.result },
    hooks,
    // agent_run = proxy lines after the host-recorded offset (agent phase only);
    // preflight = host-initiated probe traffic (incl. the deliberate example.com / :22 denials).
    egress,
    // The agent's only route to the Claude API; it holds the real credential, the agent holds a per-run placeholder.
    credential_broker: { all: parseBrokerLog(brokerLog), agent_run: brokerAgentRun },
    synthetic_secret_present_in: secretHits,
    workspace_changed: ws.changed,
    workspace_change: ws,
    counts: { stream_events: Object.values(stream.byType).reduce((a, b) => a + b, 0), hook_lines: hooks.lines, proxy_scope: egress.agent_run ? 'agent_run' : 'all_phases (no phase offset)', proxy_requests: proxy.requests.length, proxy_established: proxy.established.length, proxy_refused: proxy.refused.length },
    provenance: {
      authoritative_host_captured: ['egress-proxy.log', 'egress-proxy.phases.txt', 'llm-broker.log', 'llm-broker.phases.txt', 'inspect-agent.json', 'inspect-broker.json', 'container-diff.txt', 'workspace-before.sha256', 'workspace-after.sha256', 'workspace-after.tar', 'agent-stdout.stream.jsonl (host-captured bytes; content is agent-reported)'],
      host_probe_observed: ['preflight.txt (host-chosen probe script run in the agent image before the agent starts)', 'conformance.txt / conformance.stream.jsonl (claude with probe repo settings, no network, no credentials)'],
      agent_reported: ['hooks.agent-reported.ndjson (agent can write the spool)', 'transcript.agent-reported.jsonl', 'agent-stdout.stream.jsonl content (incl. --include-hook-events lifecycle events)'],
    },
    ok: preflightOk && pipelineOk && tokenScan !== 'LEAK' && authOk !== false,
    ok_breakdown: { preflight: preflightOk, pipeline: pipelineOk, auth_run: authOk, token_scan: tokenScan },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dir, mode, agentExit, tokenScan, name] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(summarize(dir, mode, agentExit, tokenScan, name), null, 2) + '\n');
}
