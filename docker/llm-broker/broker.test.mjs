// node --test docker/llm-broker/broker.test.mjs
// Unit tests for the LLM credential broker against a LOCAL mock upstream.
// Synthetic canary credentials only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBroker, RedactStream, OAUTH_BETA } from './broker.mjs';

const REAL = 'sk-ant-oat01-KWCANARY-0123456789abcdefABCDEF-unit';
const CLIENT = 'sk-ant-oat01-kwbroker-run-placeholder-0001';
const logs = [];
let upstream, broker, upUrl, brUrl;
let seen = [];
let mode = 'ok';

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (mode === 'reflect') {
        // A hostile / buggy upstream that reflects the credential in headers and body (split across chunks).
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-echo-auth': req.headers.authorization, 'set-cookie': 'sid=abc' });
        const s = `data: {"auth":"${req.headers.authorization}"}\n\n`;
        const cut = s.indexOf('KWCANARY') + 4;
        res.write(s.slice(0, cut));
        setTimeout(() => { res.write(s.slice(cut)); res.end('event: ping\ndata: {}\n\n'); }, 20);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_1', 'anthropic-ratelimit-unified-status': 'allowed', 'set-cookie': 'sid=abc' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upUrl = `http://127.0.0.1:${upstream.address().port}`;
  broker = createBroker({ realToken: REAL, clientToken: CLIENT, upstream: upUrl, allowInsecureUpstream: true, log: (o) => logs.push(o) });
  await new Promise((r) => broker.listen(0, '127.0.0.1', r));
  brUrl = `http://127.0.0.1:${broker.address().port}`;
});
after(() => { broker.close(); upstream.close(); });

const req = (path, { method = 'POST', headers = {}, body = '{}' } = {}) =>
  new Promise((resolve, reject) => {
    const r = http.request(`${brUrl}${path}`, { method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    if (method !== 'GET' && method !== 'HEAD') r.end(body); else r.end();
  });

test('forwards /v1/messages?beta=true, swaps credentials, strips hostile headers', async () => {
  seen = []; mode = 'ok';
  const r = await req('/v1/messages?beta=true', {
    headers: {
      authorization: `Bearer ${CLIENT}`, 'x-api-key': 'sk-KWCANARY-agent-supplied', cookie: 'a=b', 'proxy-authorization': 'Basic eA==',
      'x-forwarded-for': '1.2.3.4', 'accept-encoding': 'gzip', 'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
      'anthropic-version': '2023-06-01', 'x-claude-code-session-id': 's1', 'content-type': 'application/json', host: 'evil.example',
    },
    body: '{"model":"x"}',
  });
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1);
  const h = seen[0].headers;
  assert.equal(seen[0].url, '/v1/messages?beta=true');
  assert.equal(h.authorization, `Bearer ${REAL}`);
  for (const k of ['x-api-key', 'cookie', 'proxy-authorization', 'x-forwarded-for', 'accept-encoding']) assert.equal(h[k], undefined, k);
  assert.equal(h.host, new URL(upUrl).host);
  assert.equal(h['anthropic-beta'], `claude-code-20250219,interleaved-thinking-2025-05-14,${OAUTH_BETA}`);
  assert.equal(h['anthropic-version'], '2023-06-01');
  assert.equal(h['x-claude-code-session-id'], 's1');
  assert.equal(seen[0].body, '{"model":"x"}');
  assert.equal(r.headers['set-cookie'], undefined);
  assert.equal(r.headers['anthropic-ratelimit-unified-status'], 'allowed');
});

test('OAuth beta is not duplicated and x-api-key placeholder is accepted', async () => {
  seen = []; mode = 'ok';
  const r = await req('/v1/messages/count_tokens', { headers: { 'x-api-key': CLIENT, 'anthropic-beta': OAUTH_BETA } });
  assert.equal(r.status, 200);
  assert.equal(seen[0].headers['anthropic-beta'], OAUTH_BETA);
  assert.equal(seen[0].headers.authorization, `Bearer ${REAL}`);
});

test('non-allowlisted methods, paths and queries are 403 and never reach upstream', async () => {
  seen = [];
  const auth = { authorization: `Bearer ${CLIENT}` };
  const cases = [
    ['/v1/models', 'GET'], ['/api/hello', 'HEAD'], ['/v1/messages', 'GET'], ['/v1/files', 'POST'], ['/v1/messages/batches', 'POST'],
    ['/v1/messages/../models', 'POST'], ['/v1/messages/', 'POST'], ['/V1/messages', 'POST'], ['/v1/messages?beta=true&x=1', 'POST'],
    ['/v1/messages%2f..%2fmodels', 'POST'], ['/api/oauth/profile', 'GET'], ['//api.anthropic.com/v1/messages', 'POST'],
  ];
  for (const [p, m] of cases) {
    const r = await req(p, { method: m, headers: auth });
    assert.equal(r.status, 403, `${m} ${p}`);
    if (m !== 'HEAD') assert.match(r.body, /not allowed/);
  }
  assert.equal(seen.length, 0);
});

test('absolute-form (forward-proxy style) request is refused', async () => {
  seen = [];
  const r = await new Promise((resolve) => {
    const x = http.request({ host: '127.0.0.1', port: broker.address().port, method: 'POST', path: 'http://example.com/v1/messages', headers: { authorization: `Bearer ${CLIENT}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    x.end('{}');
  });
  assert.equal(r, 403);
  assert.equal(seen.length, 0);
});

test('missing or wrong run credential is 401 and never reaches upstream', async () => {
  seen = [];
  assert.equal((await req('/v1/messages')).status, 401);
  assert.equal((await req('/v1/messages', { headers: { authorization: 'Bearer sk-ant-oat01-wrong-placeholder' } })).status, 401);
  assert.equal((await req('/v1/messages', { headers: { authorization: `Bearer ${REAL}` } })).status, 401);
  assert.equal(seen.length, 0);
});

test('credential reflected by upstream is removed from headers and (chunk-split) body', async () => {
  mode = 'reflect';
  const r = await req('/v1/messages?beta=true', { headers: { authorization: `Bearer ${CLIENT}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-echo-auth'], undefined);
  assert.equal(r.headers['set-cookie'], undefined);
  assert.ok(!r.body.includes(REAL));
  assert.ok(!r.body.includes('KWCANARY'));
  assert.match(r.body, /\[REDACTED:kw-broker\]/);
  assert.match(r.body, /event: ping/);
  mode = 'ok';
});

test('logs carry metadata only (no credentials, headers, queries or bodies)', () => {
  const all = JSON.stringify(logs);
  assert.ok(logs.length >= 10);
  for (const s of [REAL, CLIENT, 'KWCANARY', 'sk-KWCANARY', 'Bearer', 'beta=true', '"model"', 'evil.example']) assert.ok(!all.includes(s), s);
  for (const l of logs) assert.deepEqual(Object.keys(l).sort(), ['decision', 'kw', 'method', 'ms', 'path', 'redactions', 'req_bytes', 'resp_bytes', 'status', 'ts']);
});

test('RedactStream holds back only partial matches', async () => {
  const s = new RedactStream('SECRETTOKEN');
  const out = [];
  s.on('data', (c) => out.push(c.toString()));
  s.write('ping\n'); s.write('xxSECRET'); s.write('TOKENyy SEC'); s.end('X');
  await new Promise((r) => s.on('end', r));
  assert.equal(out[0], 'ping\n'); // not held back
  assert.equal(out.join(''), 'xx[REDACTED:kw-broker]yy SECX'.replace(/^/, 'ping\n'));
});

test('constructor refuses insecure upstream, malformed or equal credentials', () => {
  assert.throws(() => createBroker({ realToken: REAL, clientToken: CLIENT, upstream: 'http://api.anthropic.com' }), /https/);
  assert.throws(() => createBroker({ realToken: '', clientToken: CLIENT }), /real credential/);
  assert.throws(() => createBroker({ realToken: 'bad token with spaces', clientToken: CLIENT }), /real credential/);
  assert.throws(() => createBroker({ realToken: REAL, clientToken: REAL }), /differ/);
  assert.throws(() => createBroker({ realToken: REAL, clientToken: CLIENT, upstream: 'https://api.anthropic.com/v1' }), /bare origin/);
});

test('server-side egress tools / MCP connector / container are refused; client tools pass; non-JSON is 400', async () => {
  seen = []; mode = 'ok';
  const auth = { authorization: `Bearer ${CLIENT}`, 'content-type': 'application/json' };
  const bad = [
    { tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] },
    { tools: [{ name: 'Read', input_schema: {} }, { type: 'web_search_20250305', name: 'web_search' }] },
    { tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] },
    { mcp_servers: [{ type: 'url', url: 'https://attacker.example/mcp', name: 'x' }] },
    { container: 'container_123' },
  ];
  for (const b of bad) {
    const r = await req('/v1/messages?beta=true', { headers: auth, body: JSON.stringify({ model: 'x', ...b }) });
    assert.equal(r.status, 403, JSON.stringify(b));
    assert.match(r.body, /server-side tools/);
  }
  assert.equal((await req('/v1/messages', { headers: auth, body: 'not json' })).status, 400);
  assert.equal(seen.length, 0);
  const ok = await req('/v1/messages?beta=true', { headers: auth, body: JSON.stringify({ model: 'x', mcp_servers: [], tools: [{ name: 'Bash', input_schema: {} }, { type: 'custom', name: 'c', input_schema: {} }] }) });
  assert.equal(ok.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers['content-length'], String(Buffer.byteLength(seen[0].body)));
  const blogs = logs.filter((l) => l.decision === 'forbidden_server_tool');
  assert.equal(blogs.length, bad.length);
  assert.ok(!JSON.stringify(blogs).includes('attacker.example'));
});

test('openai-responses profile (EXPERIMENTAL generic CLI agent): only POST /v1/responses, real Bearer, no anthropic-beta', async () => {
  const AI_REAL = 'sk-KWCANARY-aiand-real-0123456789';
  const AI_CLIENT = 'kw-aiand-run-placeholder-0001';
  const got = [];
  const up = http.createServer((rq, rs) => { let b = ''; rq.on('data', (c) => { b += c; }); rq.on('end', () => { got.push({ url: rq.url, headers: rq.headers, body: b }); rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{"ok":true}'); }); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const b = createBroker({ realToken: AI_REAL, clientToken: AI_CLIENT, profile: 'openai-responses', upstream: `http://127.0.0.1:${up.address().port}`, allowInsecureUpstream: true, log: () => {} });
  await new Promise((r) => b.listen(0, '127.0.0.1', r));
  const call = (p, headers) => new Promise((resolve, reject) => {
    const r = http.request(`http://127.0.0.1:${b.address().port}${p}`, { method: 'POST', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject); r.end('{"model":"m","input":"x","tools":[{"type":"function","name":"exec_command"}]}');
  });
  try {
    const ok = { authorization: `Bearer ${AI_CLIENT}`, 'content-type': 'application/json', 'x-codex-turn-metadata': 'installation_id=abc', originator: 'codex_exec' };
    assert.equal(await call('/v1/responses', ok), 200);
    assert.equal(got.length, 1);
    assert.equal(got[0].headers.authorization, `Bearer ${AI_REAL}`);
    assert.equal(got[0].headers['anthropic-beta'], undefined);
    assert.equal(got[0].headers['x-codex-turn-metadata'], undefined);
    assert.equal(got[0].headers.originator, undefined);
    assert.equal(await call('/v1/messages', ok), 403);
    assert.equal(await call('/v1/chat/completions', ok), 403);
    assert.equal(await call('/v1/responses?x=1', ok), 403);
    assert.equal(await call('/v1/responses', { ...ok, authorization: 'Bearer wrong-placeholder-123' }), 401);
    assert.equal(got.length, 1);
    assert.throws(() => createBroker({ realToken: AI_REAL, clientToken: AI_CLIENT, profile: 'nope' }), /unknown profile/);
  } finally { b.close(); up.close(); }
});

test('openai-responses: hosted Responses API tools and remote image/file URLs are refused (egress around the sandbox)', async () => {
  const { serverSideEgressReason: why } = await import('./broker.mjs');
  for (const type of ['mcp', 'code_interpreter', 'file_search', 'image_generation', 'web_search_preview']) assert.ok(why({ tools: [{ type }] }), type);
  assert.equal(why({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://evil.example/x.png' }] }] }), 'url_source');
  assert.equal(why({ input: [{ role: 'user', content: [{ type: 'input_file', file_url: 'http://evil.example/f' }] }] }), 'url_source');
  // Codex-shaped client tools and inline data: images still pass.
  assert.equal(why({ tools: [{ type: 'function', name: 'exec_command' }, { type: 'custom', name: 'apply_patch' }, { type: 'local_shell' }], input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }] }), null);
});
