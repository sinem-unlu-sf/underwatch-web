#!/usr/bin/env node
// PLACEHOLDER hook forwarder for docker/agent smoke tests ONLY.
// The real forwarder (/opt/kw/kw-hook.mjs) is owned by another builder and is
// bind-mounted read-only at runtime; this file is mounted at the same path only
// when the real one is not supplied (scripts/agent-smoke.sh, KW_HOOK_FORWARDER).
//
// Contract used here: Claude Code passes the hook payload as JSON on stdin.
// We append one NDJSON line to $KW_HOOK_LOG (default /kw-hooks/hooks.ndjson).
// We write NOTHING to stdout (hook stdout can become model context / decisions)
// and always exit 0 so observation never changes agent behavior.
// Hook data is AGENT-REPORTED: the agent can write to the spool too.
import { appendFileSync } from 'node:fs';

const LOG = process.env.KW_HOOK_LOG || '/kw-hooks/hooks.ndjson';
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  let payload = null;
  let parse_error = null;
  try { payload = JSON.parse(buf); } catch (e) { parse_error = String(e && e.message); }
  const line = {
    kw_source: 'kw-hook.placeholder',
    received_at: new Date().toISOString(),
    hook_event_name: payload && typeof payload === 'object' ? payload.hook_event_name ?? null : null,
    payload,
    parse_error,
    raw_bytes: Buffer.byteLength(buf),
  };
  try { appendFileSync(LOG, JSON.stringify(line) + '\n', { mode: 0o600 }); } catch { /* never block the agent */ }
  process.exit(0);
});
