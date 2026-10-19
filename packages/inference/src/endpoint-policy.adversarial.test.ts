/**
 * ADVERSARIAL REVIEW TESTS for security issue 2 (ai& endpoint must enforce HTTPS). Written by an independent reviewer,
 * not part of the fix. Synthetic canary only; no real key is loaded anywhere.
 *
 * The two "BREAK" tests were originally `it.fails` (documenting a live break). Both gaps are now fixed (trust pinned to
 * the bundled Mozilla store; dedicated http.Agent for the dev exception), so they are plain `it` regression tests.
 *
 * Each break runs in a child process because the attack inputs (NODE_EXTRA_CA_CERTS, NODE_USE_ENV_PROXY) are read by
 * Node only at process start.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateAiAndEndpoint } from "./index";

const INDEX = fileURLToPath(new URL("./index.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

let OPENSSL = true;
try {
  execFileSync("openssl", ["version"], { stdio: "ignore" });
} catch {
  OPENSSL = false;
}

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kw-adv-https-"));
  if (!OPENSSL) return;
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca-key.pem", "-out", "ca.pem", "-days", "1", "-subj", "/CN=KW Adversarial CA"]);
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:api.aiand.com\n");
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf-key.pem", "-out", "leaf.csr", "-subj", "/CN=api.aiand.com"]);
  run(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca-key.pem", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "ext.cnf"]);
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * Child: attacker controls name resolution / routing for api.aiand.com (simulated by patching dns.lookup and
 * re-routing :443 to the MITM's ephemeral port, because a sandbox cannot bind 443) and serves a cert for api.aiand.com
 * signed by the attacker CA. Production config, default transport, default base URL.
 */
const MITM_CHILD = (d: string, preHook = "") => `
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import * as https from "node:https";
import { AiAndProvider } from ${JSON.stringify(INDEX)};
const req = createRequire(import.meta.url);
const dns = req("node:dns"); const tls = req("node:tls");
let MITM = 0;
const ol = dns.lookup;
dns.lookup = (h, o, cb) => { if (typeof o === "function") { cb = o; o = {}; } if (h === "api.aiand.com") return o && o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4); return ol(h, o, cb); };
const oc = tls.connect;
tls.connect = (...a) => { const o = a.find((x) => x && typeof x === "object"); if (o && Number(o.port) === 443 && o.servername === "api.aiand.com") o.port = MITM; return oc(...a); };
const seen = [];
const srv = https.createServer({ key: readFileSync(${JSON.stringify(join(d, "leaf-key.pem"))}), cert: readFileSync(${JSON.stringify(join(d, "leaf.pem"))}) }, (q, s) => { seen.push(String(q.headers.authorization ?? "")); s.writeHead(200, { "content-type": "application/json" }); s.end('{"data":[{"id":"deepseek-ai/deepseek-v4-flash"}]}'); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r)); MITM = srv.address().port;
${preHook}
const p = new AiAndProvider({ apiKey: "sk-KWCANARY-adv-mitm-0000" }, { policyEnv: () => ({ NODE_ENV: "production" }) });
const r = await p.health();
srv.close();
console.log(JSON.stringify({ status: r.status, reason: r.reason ?? null, canaryDelivered: seen.some((a) => a.includes("KWCANARY")) }));
process.exit(0);
`;

/** Child: development http exception (all four flags set) with Node's env-proxy support switched on. */
const PROXY_CHILD = `
import * as http from "node:http";
import { AiAndProvider } from ${JSON.stringify(INDEX)};
const proxySeen = [];
const ok = (s) => { s.writeHead(200, { "content-type": "application/json" }); s.end('{"data":[{"id":"deepseek-ai/deepseek-v4-flash"}]}'); };
const proxy = http.createServer((q, s) => { proxySeen.push(q.headers.authorization?.includes("KWCANARY") ? "canary" : "none"); ok(s); });
await new Promise((r) => proxy.listen(Number(process.env.KW_ADV_PROXY_PORT), "127.0.0.1", r));
let targetHits = 0;
const target = http.createServer((q, s) => { targetHits++; ok(s); });
await new Promise((r) => target.listen(0, "127.0.0.1", r));
const env = { NODE_ENV: "development", KW_ALLOW_INSECURE_AIAND_HTTP: "1", KW_AIAND_ALLOWED_HOSTS: "127.0.0.1" };
const p = new AiAndProvider({ apiKey: "sk-KWCANARY-adv-proxy-0000", baseUrl: "http://127.0.0.1:" + target.address().port + "/v1" }, { policyEnv: () => env });
const r = await p.health();
proxy.close(); target.close();
console.log(JSON.stringify({ status: r.status, targetHits, canaryAtProxy: proxySeen.includes("canary") }));
process.exit(0);
`;

function runChild(name: string, src: string, env: Record<string, string>): Record<string, unknown> {
  const file = join(dir, name);
  writeFileSync(file, src);
  const base = { ...process.env };
  delete base.NODE_EXTRA_CA_CERTS;
  delete base.NODE_USE_ENV_PROXY;
  delete base.HTTP_PROXY;
  delete base.HTTPS_PROXY;
  delete base.http_proxy;
  delete base.https_proxy;
  delete base.NO_PROXY;
  delete base.no_proxy;
  const r = spawnSync(TSX, [file], { env: { ...base, NODE_ENV: "production", ...env }, encoding: "utf8", timeout: 30_000 });
  const line = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  // never surface child stderr wholesale; it only ever contains synthetic data, but keep reports tidy
  if (!line.startsWith("{")) throw new Error(`child ${name} produced no verdict (exit ${r.status})`);
  return JSON.parse(line) as Record<string, unknown>;
}

describe.skipIf(!OPENSSL)("adversarial: trust-store injection via process env", () => {
  it("control: without the injected CA the MITM is refused and receives nothing", () => {
    const v = runChild("mitm-control.mts", MITM_CHILD(dir), {});
    expect(v.canaryDelivered).toBe(false);
    expect(v.status).toBe("unavailable");
  });

  // WAS BREAK: NODE_EXTRA_CA_CERTS silently extended the trust store used by createAiAndHttpsTransport. Fixed by pinning
  // the Agent's `ca` to tls.rootCertificates.
  it("FIXED: refuses to send the key when NODE_EXTRA_CA_CERTS injects an attacker CA (production, default endpoint)", () => {
    const v = runChild("mitm-extra-ca.mts", MITM_CHILD(dir), { NODE_EXTRA_CA_CERTS: join(dir, "ca.pem") });
    expect(v.canaryDelivered).toBe(false);
    expect(v.status).toBe("unavailable");
  });

  it("sanity: the injected CA really is trusted process-wide (so the test above exercises the pin, not a broken MITM)", () => {
    const v = runChild("mitm-extra-ca-global.mts", MITM_CHILD(dir, `
const gr = await new Promise((res) => { const q = https.request("https://api.aiand.com/v1/models", (s) => { s.resume(); res("status " + s.statusCode); }); q.on("error", (e) => res("error " + e.code)); q.end(); });
console.log(JSON.stringify({ globalAgent: gr })); process.exit(0);`), { NODE_EXTRA_CA_CERTS: join(dir, "ca.pem") });
    expect(v.globalAgent).toBe("status 200");
  });

  it("FIXED: in-process tls.setDefaultCACertificates([...default, attackerCA]) does not widen the transport's trust", () => {
    const v = runChild("mitm-setdefault.mts", MITM_CHILD(dir, `
if (typeof tls.setDefaultCACertificates === "function") tls.setDefaultCACertificates([...tls.getCACertificates("default"), readFileSync(${JSON.stringify(join(dir, "ca.pem"))}, "utf8")]);
else { console.log(JSON.stringify({ skipped: true })); process.exit(0); }`), {});
    if (v.skipped) return;
    expect(v.canaryDelivered).toBe(false);
    expect(v.status).toBe("unavailable");
  });

  it("FIXED: --use-openssl-ca with SSL_CERT_FILE pointing at an attacker CA does not widen the transport's trust", () => {
    const v = runChild("mitm-openssl-ca.mts", MITM_CHILD(dir), { NODE_OPTIONS: "--use-openssl-ca", SSL_CERT_FILE: join(dir, "ca.pem") });
    expect(v.canaryDelivered).toBe(false);
    expect(v.status).toBe("unavailable");
  });
});

describe("adversarial: development http exception vs env proxy", () => {
  // WAS BREAK: the http branch used Node's global http agent, which honours env proxies under NODE_USE_ENV_PROXY=1, so the
  // "loopback-only" request (Authorization header included, in plaintext) went to the proxy. Fixed with a dedicated
  // http.Agent. Requires the four dev-exception flags, so it never applied in production.
  it("FIXED: dev http exception never hands the key to a (possibly remote) HTTP proxy and still reaches the loopback target", () => {
    const port = String(20000 + Math.floor(Math.random() * 20000));
    const v = runChild("proxy.mts", PROXY_CHILD, { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: "", KW_ADV_PROXY_PORT: port });
    expect(v.canaryAtProxy).toBe(false);
    expect(v.targetHits).toBe(1);
    expect(v.status).toBe("ok");
  });
});

describe("adversarial: URL normalisation tricks never widen the host set (expected to hold)", () => {
  const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
  it.each([
    ["https:api.aiand.com/v1"],
    ["https:/api.aiand.com/v1"],
    ["https://api%2eaiand%2ecom/v1"],
    ["https://api.aiand.com:0443/v1"],
    ["https://API.aiand.com/v1"],
  ])("%s canonicalises to api.aiand.com on the default port", (u) => {
    const r = validateAiAndEndpoint(u, prod);
    expect(r.ok && new URL(r.url).host).toBe("api.aiand.com");
  });
  it.each([["https://api.aiand.com./v1"], ["https://api.aiand.com%2e/v1"], ["https://api.aiand.com。/v1"], ["http://[::ffff:127.0.0.1]:1/v1"], ["http://localhost.:1/v1"]])("%s is rejected", (u) => {
    expect(validateAiAndEndpoint(u, { NODE_ENV: "development", KW_ALLOW_INSECURE_AIAND_HTTP: "1", KW_AIAND_ALLOWED_HOSTS: "127.0.0.1,localhost" } as NodeJS.ProcessEnv).ok).toBe(false);
  });
});
