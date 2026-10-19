#!/usr/bin/env node
// Underwatch LLM credential broker (TRUSTED zone).
//
// A narrowly scoped reverse proxy that sits on the agent's internal-only network and
// is the agent's ONLY route to the Claude API. The real Claude credential lives only
// here (read once from a file bind-mounted into THIS container); the agent container
// gets ANTHROPIC_BASE_URL=http://<broker>:8080 plus a per-run placeholder credential
// that is worthless anywhere except at this broker for the lifetime of one run.
//
// Per request:
//   - only POST /v1/messages and POST /v1/messages/count_tokens (query "" or
//     "beta=true") are forwarded; every other method/path/query -> 403
//   - the client must present the per-run placeholder (Authorization: Bearer or
//     x-api-key); anything else -> 401
//   - ALL incoming credentials/cookies/forwarding headers are dropped; only
//     content-type, accept, user-agent, anthropic-*, x-claude-code-*, x-stainless-*,
//     x-app are forwarded; the real credential is injected as Authorization: Bearer;
//     the OAuth capability is ensured in anthropic-beta (Claude Code docs,
//     llm-gateway-protocol "Request headers")
//   - upstream is fixed (https://api.anthropic.com) with Node's default TLS
//     verification; accept-encoding is not forwarded so responses stay identity-encoded
//     and the outbound redaction filter below sees plaintext
//   - the JSON body is parsed and inspected: requests that ask Anthropic to reach the
//     outside world (server tools web_search/web_fetch/code_execution/computer,
//     mcp_servers, container, and image/document URL sources at any depth) -> 403, since
//     they would be an egress channel around the sandbox (opt out:
//     KW_BROKER_ALLOW_SERVER_TOOLS=1); non-JSON -> 400. This is a denylist of the
//     documented egress features, not a proof that no other feature fetches URLs.
//     The RE-SERIALIZED parsed object is forwarded (not the original bytes), so the
//     upstream sees exactly what was inspected (no duplicate-key parser differential)
//   - responses: set-cookie and hop-by-hop headers dropped, any header whose value
//     contains the credential dropped, the body streamed through a redaction filter that
//     matches the raw credential and every JSON \u-escaped spelling of it (defence in
//     depth: the upstream is not expected to echo the credential; other encodings such
//     as base64 are not detected)
//   - logs: one JSON line per request with metadata only (method, path, status,
//     decision, sizes, duration); never headers, bodies or query strings
//
// No dependencies (node:http/https only). Test hooks: createBroker() is exported; the
// upstream may be overridden ONLY together with KW_BROKER_TEST_INSECURE_UPSTREAM=1
// when it is not https (unit tests use a local mock upstream).
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const OAUTH_BETA = 'oauth-2025-04-20';
export const ALLOWED = new Map([
  ['/v1/messages', new Set(['POST'])],
  ['/v1/messages/count_tokens', new Set(['POST'])],
]);
const ALLOWED_QUERIES = new Set(['', '?beta=true']);
const FORWARD_REQ_EXACT = new Set(['content-type', 'accept', 'user-agent', 'x-app']);
// Anthropic-executed tools reach arbitrary URLs from Anthropic's side (web fetch/search, code
// execution, MCP connector): an egress channel around the sandbox. Refused unless opted in.
// The second group is the OpenAI Responses API (openai-responses profile): hosted tools the provider runs server-side.
const SERVER_TOOL_RE = /^(web_search|web_fetch|code_execution|bash_code_execution|text_editor_code_execution|computer|mcp_toolset)|^(mcp|code_interpreter|file_search|image_generation)$/;
// Keys whose values are opaque data to Anthropic (never fetched): tool_use inputs echoed from earlier
// turns and client tool JSON schemas. Skipped by the URL-source walk to avoid false positives.
const OPAQUE_KEYS = new Set(['input', 'input_schema']);
/**
 * Returns a reason string when the request body asks Anthropic to reach the outside world, else null.
 * Covers: server tools (web_search/web_fetch/code_execution/computer/mcp_toolset), mcp_servers,
 * container, and URL content sources (`{type:"url", url}` for image/document blocks) at ANY depth,
 * including tool_result.content and system, because Anthropic fetches those URLs server-side.
 * This is a denylist of the documented Messages API egress features; an undocumented or future
 * feature that makes Anthropic fetch a URL would not be caught (see README / report).
 */
export function serverSideEgressReason(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.mcp_servers !== undefined && !(Array.isArray(body.mcp_servers) && body.mcp_servers.length === 0)) return 'mcp_servers';
  if (body.container !== undefined && body.container !== null) return 'container';
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (t && typeof t === 'object' && typeof t.type === 'string' && SERVER_TOOL_RE.test(t.type)) return `tool:${t.type.slice(0, 40)}`;
  }
  // Iterative walk (no recursion: deeply nested bodies cannot blow the stack).
  const stack = [body];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object') stack.push(x); continue; }
    if (typeof v.type === 'string' && v.type.trim().toLowerCase() === 'url') return 'url_source';
    // Responses API remote inputs (provider fetches them): input_image.image_url / input_file.file_url as http(s) URLs.
    for (const k of ['image_url', 'file_url']) if (typeof v[k] === 'string' && /^\s*https?:/i.test(v[k])) return 'url_source';
    if (v.source && typeof v.source === 'object' && !Array.isArray(v.source) && (v.source.url !== undefined || (typeof v.source.type === 'string' && v.source.type.trim().toLowerCase() === 'url'))) return 'url_source';
    const isToolUse = typeof v.type === 'string' && v.type.endsWith('tool_use');
    for (const [k, x] of Object.entries(v)) {
      if (!x || typeof x !== 'object') continue;
      if (k === 'input_schema' || (isToolUse && OPAQUE_KEYS.has(k))) continue;
      stack.push(x);
    }
  }
  return null;
}
const FORWARD_REQ_PREFIX = ['anthropic-', 'x-claude-code-', 'x-stainless-'];
// Upstream profiles. `anthropic` is the default (Claude Code). `openai-responses` is the EXPERIMENTAL generic CLI
// agent (Codex CLI 0.163.0 -> ai& Responses API): probed to call only POST /v1/responses with env_key auth. A minimal
// header set is forwarded (no x-codex-* metadata / installation_id); no anthropic-beta.
export const PROFILES = {
  anthropic: { upstream: 'https://api.anthropic.com', allowed: ALLOWED, queries: ALLOWED_QUERIES, fwdExact: FORWARD_REQ_EXACT, fwdPrefix: FORWARD_REQ_PREFIX, oauthBeta: true },
  'openai-responses': { upstream: 'https://api.aiand.com', allowed: new Map([['/v1/responses', new Set(['POST'])]]), queries: new Set(['']), fwdExact: new Set(['content-type', 'accept', 'user-agent']), fwdPrefix: [], oauthBeta: false },
};
const DROP_RESP = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'proxy-authenticate', 'www-authenticate', 'upgrade', 'trailer']);
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9._-]{8,512}$/;
const REDACTED = Buffer.from('[REDACTED:kw-broker]');

const BACKSLASH = 0x5c;
const isHex = (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
/**
 * Match `secret` at buf[pos], where every secret byte may appear either literally or as a JSON
 * `\uXXXX` escape (hex case-insensitive). The credential alphabet ([A-Za-z0-9._-], TOKEN_RE) has no
 * other JSON string encoding, so this covers every JSON-string spelling of the credential plus the
 * raw bytes. Returns the match length (>0), 0 when buf ends inside a possible match, -1 for no match.
 */
export function matchSecretAt(buf, pos, secret) {
  let p = pos;
  for (let k = 0; k < secret.length; k++) {
    if (p >= buf.length) return 0;
    const c = secret[k];
    if (buf[p] === c) { p++; continue; }
    if (buf[p] !== BACKSLASH) return -1;
    const hex = c.toString(16).padStart(4, '0');
    for (let j = 1; j < 6; j++) {
      if (p + j >= buf.length) return 0;
      const b = buf[p + j];
      if (j === 1) { if (b !== 0x75) return -1; continue; } // 'u'
      if (!isHex(b) || String.fromCharCode(b).toLowerCase() !== hex[j - 2]) return -1;
    }
    p += 6;
  }
  return p - pos;
}

/** True when `buf` contains `secret` raw or in any JSON \u-escaped spelling. */
export function containsSecret(buf, secret) {
  for (let i = 0; i < buf.length; i++) {
    if ((buf[i] === secret[0] || buf[i] === BACKSLASH) && matchSecretAt(buf, i, secret) > 0) return true;
  }
  return false;
}

/**
 * Streaming redaction of `secret` (raw bytes or any JSON \u-escaped spelling) from a byte stream,
 * holding back only a possible partial match. Encodings other than JSON string escapes (base64,
 * reversal, splitting across fields...) are NOT detected; this is defence in depth against an
 * upstream reflecting the credential, not a guarantee against arbitrary transformations.
 */
export class RedactStream extends Transform {
  constructor(secret) {
    super();
    this.secret = Buffer.from(secret);
    this.pending = Buffer.alloc(0);
    this.hits = 0;
  }
  _transform(chunk, _enc, cb) {
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out = [];
    let start = 0;
    let hold = buf.length;
    const first = this.secret[0];
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== first && buf[i] !== BACKSLASH) continue;
      const m = matchSecretAt(buf, i, this.secret);
      if (m > 0) {
        out.push(buf.subarray(start, i), REDACTED);
        this.hits++;
        i += m - 1;
        start = i + 1;
      } else if (m === 0) { hold = i; break; }
    }
    out.push(buf.subarray(start, hold));
    this.pending = Buffer.from(buf.subarray(hold));
    const data = Buffer.concat(out);
    if (data.length) this.push(data);
    cb();
  }
  _flush(cb) {
    if (this.pending.length) this.push(this.pending);
    cb();
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function clientCredential(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const key = req.headers['x-api-key'];
  return typeof key === 'string' ? key.trim() : null;
}

function sanitizePath(p) {
  return String(p).slice(0, 200).replace(/[^\x21-\x7e]/g, '?');
}

/**
 * @param {{ realToken: string, clientToken: string, upstream?: string, log?: (o: object) => void, allowInsecureUpstream?: boolean, allowServerTools?: boolean, profile?: string }} o
 */
export function createBroker(o) {
  if (!TOKEN_RE.test(o.realToken ?? '')) throw new Error('kw-llm-broker: real credential missing or malformed');
  if (!TOKEN_RE.test(o.clientToken ?? '')) throw new Error('kw-llm-broker: client placeholder missing or malformed');
  if (safeEqual(o.realToken, o.clientToken)) throw new Error('kw-llm-broker: client placeholder must differ from the real credential');
  const P = Object.prototype.hasOwnProperty.call(PROFILES, o.profile ?? 'anthropic') ? PROFILES[o.profile ?? 'anthropic'] : null;
  if (!P) throw new Error('kw-llm-broker: unknown profile');
  const up = new URL(o.upstream ?? P.upstream);
  if (up.protocol !== 'https:' && !o.allowInsecureUpstream) throw new Error('kw-llm-broker: upstream must be https');
  if (up.pathname !== '/' || up.search || up.username || up.password) throw new Error('kw-llm-broker: upstream must be a bare origin');
  const lib = up.protocol === 'https:' ? https : http;
  const agent = new lib.Agent({ keepAlive: true });
  const log = o.log ?? ((x) => process.stdout.write(JSON.stringify(x) + '\n'));
  const realToken = o.realToken;
  const clientToken = o.clientToken;
  const realTokenBuf = Buffer.from(realToken);

  return http.createServer((req, res) => {
    const t0 = Date.now();
    let reqBytes = 0;
    let respBytes = 0;
    let pathForLog = '?';
    let redactStream = null;
    const finish = (status, decision) => {
      log({ ts: new Date().toISOString(), kw: 'llm-broker', method: sanitizePath(req.method), path: pathForLog, status, decision, req_bytes: reqBytes, resp_bytes: respBytes, ms: Date.now() - t0, redactions: redactStream ? redactStream.hits : 0 });
    };
    const deny = (status, type, message, decision) => {
      req.resume();
      const body = JSON.stringify({ type: 'error', error: { type, message: `kw-llm-broker: ${message}` } });
      respBytes = Buffer.byteLength(body);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': respBytes, 'x-should-retry': 'false' });
      res.end(body);
      finish(status, decision);
    };

    const raw = String(req.url ?? '');
    const q = raw.indexOf('?');
    const pathname = q === -1 ? raw : raw.slice(0, q);
    const query = q === -1 ? '' : raw.slice(q);
    pathForLog = sanitizePath(pathname);
    const methods = raw.startsWith('/') ? P.allowed.get(pathname) : undefined;
    if (!methods || !methods.has(req.method) || !P.queries.has(query)) return deny(403, 'permission_error', 'method/path not allowed', 'forbidden_path');
    const cred = clientCredential(req);
    if (!cred || !safeEqual(cred, clientToken)) return deny(401, 'authentication_error', 'invalid run credential', 'bad_client_credential');
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_BODY_BYTES) return deny(413, 'request_too_large', 'request too large', 'too_large');

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (P.fwdExact.has(k) || P.fwdPrefix.some((p) => k.startsWith(p))) headers[k] = v;
    }
    if (P.oauthBeta) {
      const betas = String(headers['anthropic-beta'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
      headers['anthropic-beta'] = betas.join(',');
    }
    headers.authorization = `Bearer ${realToken}`;
    headers.host = up.host;

    // Buffer the request body (inspected, then forwarded as the re-serialized parsed object).
    const chunks = [];
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      reqBytes += c.length;
      if (reqBytes > MAX_BODY_BYTES) { aborted = true; chunks.length = 0; deny(413, 'request_too_large', 'request too large', 'too_large'); return; }
      chunks.push(c);
    });
    req.on('error', () => { aborted = true; });
    req.on('end', () => {
      if (aborted) return;
      const body = Buffer.concat(chunks);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { return deny(400, 'invalid_request_error', 'request body is not JSON', 'bad_body'); }
      const why = o.allowServerTools ? null : serverSideEgressReason(parsed);
      if (why) return deny(403, 'permission_error', `server-side tools/connectors are not allowed in this sandbox (${why})`, 'forbidden_server_tool');
      // Forward the RE-SERIALIZED parsed object, not the original bytes, so the upstream receives
      // exactly what was inspected: duplicate keys (JSON.parse keeps the last), odd escapes and
      // whitespace cannot create a parser differential between the broker and Anthropic.
      let canonical;
      try { canonical = Buffer.from(JSON.stringify(parsed), 'utf8'); } catch { return deny(400, 'invalid_request_error', 'request body could not be re-serialized', 'bad_body'); }
      forward(canonical);
    });

    const forward = (body) => {
    headers['content-length'] = String(body.length);
    let done = false;
    const upReq = lib.request(
      { protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method: req.method, path: pathname + query, headers, agent, timeout: 15 * 60_000 },
      (upRes) => {
        const out = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined || DROP_RESP.has(k)) continue;
          if (containsSecret(Buffer.from(Array.isArray(v) ? v.join('\n') : String(v)), realTokenBuf)) continue;
          out[k] = v;
        }
        res.writeHead(upRes.statusCode ?? 502, out);
        redactStream = new RedactStream(realToken);
        upRes.on('data', (c) => { respBytes += c.length; });
        upRes.pipe(redactStream).pipe(res);
        res.on('close', () => { if (!done) { done = true; finish(upRes.statusCode ?? 502, res.writableFinished ? 'forwarded' : 'client_closed'); } upRes.destroy(); });
      },
    );
    upReq.on('timeout', () => upReq.destroy(new Error('upstream timeout')));
    upReq.on('error', () => {
      if (done) return;
      done = true;
      if (!res.headersSent) {
        const body = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'kw-llm-broker: upstream unavailable' } });
        res.writeHead(502, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      } else res.destroy();
      finish(502, 'upstream_error');
    });
    res.on('close', () => { if (!res.writableFinished) upReq.destroy(); });
    upReq.end(body);
    };
  });
}

function main() {
  const tokenFile = process.env.KW_BROKER_TOKEN_FILE || '/run/kw-secrets/claude-token';
  const clientFile = process.env.KW_BROKER_CLIENT_TOKEN_FILE || '/run/kw-secrets/client-token';
  const read = (f) => { try { return readFileSync(f, 'utf8').replace(/[\r\n]/g, ''); } catch { return ''; } };
  const profile = process.env.KW_BROKER_PROFILE || 'anthropic';
  if (!Object.prototype.hasOwnProperty.call(PROFILES, profile)) { process.stderr.write('kw-llm-broker: unknown KW_BROKER_PROFILE\n'); process.exit(65); }
  const upstream = process.env.KW_BROKER_UPSTREAM || PROFILES[profile].upstream;
  let server;
  try {
    server = createBroker({ realToken: read(tokenFile), clientToken: read(clientFile), upstream, profile, allowInsecureUpstream: process.env.KW_BROKER_TEST_INSECURE_UPSTREAM === '1', allowServerTools: process.env.KW_BROKER_ALLOW_SERVER_TOOLS === '1' });
  } catch (e) {
    process.stderr.write(`${e.message}\n`); // never includes credential values
    process.exit(65);
  }
  const port = Number(process.env.KW_BROKER_PORT || 8080);
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), kw: 'llm-broker', event: 'listening', port, profile, upstream_host: new URL(upstream).host, allowed: [...PROFILES[profile].allowed.keys()] }) + '\n');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
