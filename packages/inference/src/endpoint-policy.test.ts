import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AiAndProvider,
  AiAndTransportError,
  createAiAndHttpsTransport,
  createInferenceProvider,
  EndpointPolicyError,
  guardAiAndTransport,
  type HttpRequest,
  type HttpTransport,
  loadAiAndConfig,
  RedirectBlockedError,
  validateAiAndEndpoint,
} from "./index";

// Synthetic canary only. Never a real key.
const CANARY = "sk-KWCANARY-endpoint-policy-0123456789abcdef";

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const OPENSSL = hasOpenssl();

type Seen = { method: string; url: string; authorization: string | undefined };
interface TestServer {
  url: string;
  port: number;
  seen: Seen[];
  close(): Promise<void>;
}

async function listen(server: http.Server | https.Server, seen: Seen[], proto: "http" | "https"): Promise<TestServer> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `${proto}://127.0.0.1:${port}`,
    port,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
const modelsOk: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "deepseek-ai/deepseek-v4-flash" }] }));
};
function recording(seen: Seen[], h: Handler): Handler {
  return (req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization });
    h(req, res);
  };
}
async function httpsServer(key: string, cert: string, h: Handler = modelsOk): Promise<TestServer> {
  const seen: Seen[] = [];
  return listen(https.createServer({ key, cert }, recording(seen, h)), seen, "https");
}
async function httpServer(h: Handler = modelsOk): Promise<TestServer> {
  const seen: Seen[] = [];
  return listen(http.createServer(recording(seen, h)), seen, "http");
}

/** Wraps a transport and records every request handed to it (i.e. every request that passed the guard). */
function spy(inner: HttpTransport) {
  const calls: HttpRequest[] = [];
  const t: HttpTransport = (req, signal) => {
    calls.push(req);
    return inner(req, signal);
  };
  return { t, calls };
}

function expectNoKey(x: unknown) {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  expect(s).not.toContain(CANARY);
  expect(s).not.toContain("KWCANARY");
}

const ALLOW_LOCAL = { NODE_ENV: "test", KW_AIAND_ALLOWED_HOSTS: "127.0.0.1" } as NodeJS.ProcessEnv;

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------------------------------------------
describe("validateAiAndEndpoint (pure policy)", () => {
  const prod = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

  it("accepts the default ai& endpoint and canonicalises the trailing slash", () => {
    const r = validateAiAndEndpoint("https://api.aiand.com/v1/", prod);
    expect(r).toEqual({ ok: true, url: "https://api.aiand.com/v1", host: "api.aiand.com", insecureDevException: false });
    expect(validateAiAndEndpoint("https://API.AIAND.COM/v1", prod).ok).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["not a url", "whitespace"],
    ["api.aiand.com/v1", "valid absolute URL"],
    ["ftp://api.aiand.com/v1", "https"],
    ["javascript:alert(1)", "https"],
    ["file:///etc/passwd", "https"],
    ["https://kwuser:kwsecretpw@api.aiand.com/v1", "credentials"],
    ["https://kwuser@api.aiand.com/v1", "credentials"],
    ["https://api.aiand.com/v1?key=x", "query"],
    ["https://api.aiand.com/v1?", "query"],
    ["https://api.aiand.com/v1#frag", "fragment"],
    ["https://api.aiand.com/v1#", "fragment"],
    ["https://evil.example/v1", "not allowed"],
    ["https://api.aiand.com.evil.example/v1", "not allowed"],
    ["https://api.aiand.com:8443/v1", "default https port"],
    ["https:\\\\evil.example\\v1", "backslash"],
    ["https://api.aiand.com/v1\n", "control"],
    ["http://api.aiand.com/v1", "must use https"],
  ])("rejects %j (%s)", (url, why) => {
    const r = validateAiAndEndpoint(url, prod);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.toLowerCase()).toContain(why.toLowerCase());
      expect(r.reason).not.toContain("kwsecretpw");
      expect(r.reason).not.toContain("evil");
    }
  });

  it("KW_AIAND_ALLOWED_HOSTS admits exact hosts only (no wildcards, no ports)", () => {
    expect(validateAiAndEndpoint("https://proxy.internal:8443/v1", { KW_AIAND_ALLOWED_HOSTS: "proxy.internal" }).ok).toBe(true);
    expect(validateAiAndEndpoint("https://a.proxy.internal/v1", { KW_AIAND_ALLOWED_HOSTS: "*.proxy.internal" }).ok).toBe(false);
    expect(validateAiAndEndpoint("https://proxy.internal/v1", { KW_AIAND_ALLOWED_HOSTS: "https://proxy.internal" }).ok).toBe(false);
    expect(validateAiAndEndpoint("https://proxy.internal/v1", { KW_AIAND_ALLOWED_HOSTS: "proxy.internal:443" }).ok).toBe(false);
  });

  it("http is allowed only with NODE_ENV in {development,test} AND KW_ALLOW_INSECURE_AIAND_HTTP=1 AND loopback AND allowlisted", () => {
    const base = { KW_ALLOW_INSECURE_AIAND_HTTP: "1", KW_AIAND_ALLOWED_HOSTS: "127.0.0.1,localhost,10.0.0.5" };
    expect(validateAiAndEndpoint("http://127.0.0.1:9/v1", { ...base, NODE_ENV: "development" })).toMatchObject({ ok: true, insecureDevException: true });
    expect(validateAiAndEndpoint("http://localhost:9/v1", { ...base, NODE_ENV: "test" })).toMatchObject({ ok: true, insecureDevException: true });
    // any single condition missing -> rejected
    expect(validateAiAndEndpoint("http://127.0.0.1:9/v1", { ...base, NODE_ENV: "production" }).ok).toBe(false);
    expect(validateAiAndEndpoint("http://127.0.0.1:9/v1", { ...base, NODE_ENV: undefined }).ok).toBe(false);
    expect(validateAiAndEndpoint("http://127.0.0.1:9/v1", { ...base, NODE_ENV: "staging" }).ok).toBe(false);
    expect(validateAiAndEndpoint("http://127.0.0.1:9/v1", { ...base, NODE_ENV: "development", KW_ALLOW_INSECURE_AIAND_HTTP: "true" }).ok).toBe(false);
    expect(validateAiAndEndpoint("http://127.0.0.1:9/v1", { ...base, NODE_ENV: "development", KW_ALLOW_INSECURE_AIAND_HTTP: undefined }).ok).toBe(false);
    expect(validateAiAndEndpoint("http://10.0.0.5:9/v1", { ...base, NODE_ENV: "development" }).ok).toBe(false);
    expect(validateAiAndEndpoint("http://127.0.0.1:9/v1", { NODE_ENV: "development", KW_ALLOW_INSECURE_AIAND_HTTP: "1" }).ok).toBe(false); // not allowlisted
    expect(validateAiAndEndpoint("http://api.aiand.com/v1", { NODE_ENV: "development", KW_ALLOW_INSECURE_AIAND_HTTP: "1" }).ok).toBe(false); // not loopback
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("every rejected configuration sends no credentials (spy transport)", () => {
  const bad = [
    "http://api.aiand.com/v1",
    "https://kwuser:kwsecretpw@api.aiand.com/v1",
    "https://api.aiand.com/v1?x=1",
    "https://api.aiand.com/v1#x",
    "https://evil.example/v1",
    "not a url",
    "",
    "https://api.aiand.com:444/v1",
  ];
  it.each(bad)("baseUrl %j -> endpoint_rejected, transport never called, no key in result/describe", async (baseUrl) => {
    const s = spy(async () => ({ status: 200, headers: {}, body: "{}" }));
    const p = new AiAndProvider({ apiKey: CANARY, baseUrl }, { transport: s.t, policyEnv: () => ({ NODE_ENV: "production" }) });
    const h = await p.health();
    expect(h.status).toBe("unavailable");
    if (h.status === "unavailable") expect(h.reason).toBe("endpoint_rejected");
    expect(s.calls).toHaveLength(0);
    expectNoKey(h);
    expectNoKey(p.describe());
    expect(JSON.stringify(p.describe())).not.toContain("kwsecretpw");
  });

  it("loadAiAndConfig validates AIAND_BASE_URL at load; createInferenceProvider then refuses to send", async () => {
    const env = { NODE_ENV: "production", AIAND_API_KEY: CANARY, AIAND_BASE_URL: "http://api.aiand.com/v1" } as NodeJS.ProcessEnv;
    const loaded = loadAiAndConfig({ env, envFile: null });
    expect(loaded.endpoint.ok).toBe(false);
    const s = spy(async () => ({ status: 200, headers: {}, body: "{}" }));
    const p = createInferenceProvider({ env, envFile: null, deps: { transport: s.t } });
    const h = await p.health();
    expect(h).toMatchObject({ status: "unavailable", reason: "endpoint_rejected" });
    expect(s.calls).toHaveLength(0);
    expectNoKey(h);
  });

  it("the default config loads as valid", () => {
    const loaded = loadAiAndConfig({ env: { NODE_ENV: "production", AIAND_API_KEY: CANARY }, envFile: null });
    expect(loaded.endpoint).toMatchObject({ ok: true, url: "https://api.aiand.com/v1" });
    expect(loaded.config.baseUrl).toBe("https://api.aiand.com/v1");
  });

  it("re-validates before every request: an env change after construction cannot open an unvalidated path", async () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "development", KW_ALLOW_INSECURE_AIAND_HTTP: "1", KW_AIAND_ALLOWED_HOSTS: "127.0.0.1" };
    const s = spy(async () => ({ status: 200, headers: {}, body: JSON.stringify({ data: [] }) }));
    const p = new AiAndProvider({ apiKey: CANARY, baseUrl: "http://127.0.0.1:9/v1" }, { transport: s.t, policyEnv: () => env });
    expect((await p.health()).status).toBe("ok");
    expect(s.calls).toHaveLength(1);
    env.NODE_ENV = "production";
    const h = await p.health();
    expect(h).toMatchObject({ status: "unavailable", reason: "endpoint_rejected" });
    expect(s.calls).toHaveLength(1);
  });

  it("guardAiAndTransport refuses a bad URL even if handed one directly", async () => {
    const s = spy(async () => ({ status: 200, headers: {}, body: "" }));
    const g = guardAiAndTransport(s.t, () => ({ NODE_ENV: "production" }));
    await expect(g({ method: "GET", url: "http://api.aiand.com/v1/models", headers: { Authorization: `Bearer ${CANARY}` } }, new AbortController().signal)).rejects.toBeInstanceOf(EndpointPolicyError);
    expect(s.calls).toHaveLength(0);
  });

  it("NODE_TLS_REJECT_UNAUTHORIZED=0 -> refuses to send the key (construction and per request)", async () => {
    const s = spy(async () => ({ status: 200, headers: {}, body: JSON.stringify({ data: [] }) }));
    const p = new AiAndProvider({ apiKey: CANARY }, { transport: s.t, policyEnv: () => ({ NODE_ENV: "production" }) });
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    const h = await p.health(); // valid at construction, TLS disabled afterwards -> per-request guard
    expect(h).toMatchObject({ status: "unavailable", reason: "endpoint_rejected" });
    if (h.status === "unavailable") expect(h.detail).toContain("TLS certificate verification is disabled");
    const p2 = new AiAndProvider({ apiKey: CANARY }, { transport: s.t, policyEnv: () => ({ NODE_ENV: "production" }) });
    expect(await p2.health()).toMatchObject({ status: "unavailable", reason: "endpoint_rejected" });
    expect(loadAiAndConfig({ env: { AIAND_API_KEY: CANARY }, envFile: null }).endpoint.ok).toBe(false);
    expect(s.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe.skipIf(!OPENSSL)("real TLS against local servers (generated test CA)", () => {
  let dir: string;
  let caCert: string;
  const pem: Record<string, { key: string; cert: string }> = {};

  function sh(args: string[]) {
    execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  }
  function leaf(name: string, san: string, signedByCa: boolean) {
    const ext = join(dir, `${name}.ext`);
    writeFileSync(ext, `subjectAltName=${san}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`);
    sh(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`]);
    if (signedByCa) {
      sh(["req", "-new", "-key", `${name}.key`, "-subj", `/CN=${name}`, "-out", `${name}.csr`]);
      sh(["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", String(Math.floor(Math.random() * 1e9)), "-days", "2", "-sha256", "-extfile", ext, "-out", `${name}.pem`]);
    } else {
      sh(["req", "-new", "-x509", "-key", `${name}.key`, "-subj", `/CN=${name}`, "-days", "2", "-sha256", "-addext", `subjectAltName=${san}`, "-out", `${name}.pem`]);
    }
    pem[name] = { key: readFileSync(join(dir, `${name}.key`), "utf8"), cert: readFileSync(join(dir, `${name}.pem`), "utf8") };
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kw-aiand-tls-"));
    sh(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"]);
    sh([
      "req", "-new", "-x509", "-key", "ca.key", "-subj", "/CN=KW Test CA (endpoint-policy)", "-days", "2", "-sha256",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "ca.pem",
    ]);
    caCert = readFileSync(join(dir, "ca.pem"), "utf8");
    leaf("good", "IP:127.0.0.1,DNS:localhost", true);
    leaf("wrongname", "DNS:wrong.invalid", true);
    leaf("selfsigned", "IP:127.0.0.1", false);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("valid HTTPS config (trusted test CA passed only to this transport) is accepted end to end", async () => {
    const srv = await httpsServer(pem.good!.key, pem.good!.cert);
    try {
      const s = spy(createAiAndHttpsTransport({ ca: caCert }));
      const p = new AiAndProvider({ apiKey: CANARY, baseUrl: `${srv.url}/v1/` }, { transport: s.t, policyEnv: () => ALLOW_LOCAL });
      const h = await p.health();
      expect(h.status).toBe("ok");
      expect(srv.seen).toHaveLength(1);
      expect(srv.seen[0]).toMatchObject({ method: "GET", url: "/v1/models", authorization: `Bearer ${CANARY}` });
    } finally {
      await srv.close();
    }
  });

  it("the same server is NOT trusted by a transport without the test CA (default trust store)", async () => {
    const srv = await httpsServer(pem.good!.key, pem.good!.cert);
    try {
      const p = new AiAndProvider({ apiKey: CANARY, baseUrl: `${srv.url}/v1` }, { policyEnv: () => ALLOW_LOCAL }); // default transport
      const h = await p.health();
      expect(h).toMatchObject({ status: "unavailable", reason: "transport_unreachable" });
      expect(srv.seen).toHaveLength(0);
      expectNoKey(h);
    } finally {
      await srv.close();
    }
  });

  it("self-signed / untrusted certificate -> TLS failure, key never transmitted, error carries no key", async () => {
    const srv = await httpsServer(pem.selfsigned!.key, pem.selfsigned!.cert);
    try {
      const t = createAiAndHttpsTransport({ ca: caCert });
      const err = await t({ method: "GET", url: `${srv.url}/v1/models`, headers: { Authorization: `Bearer ${CANARY}` } }, new AbortController().signal).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AiAndTransportError);
      expect((err as AiAndTransportError).tls).toBe(true);
      expectNoKey(String(err));
      expectNoKey((err as Error).stack ?? "");
      expectNoKey(Object.getOwnPropertyNames(err).map((k) => String((err as Record<string, unknown>)[k])).join("|"));
      expect(srv.seen).toHaveLength(0);

      const p = new AiAndProvider({ apiKey: CANARY, baseUrl: `${srv.url}/v1` }, { transport: t, policyEnv: () => ALLOW_LOCAL });
      const h = await p.health();
      expect(h.status).toBe("unavailable");
      expectNoKey(h);
      expect(srv.seen).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  it("hostname mismatch (CA-trusted cert for another name) -> failure, nothing received", async () => {
    const srv = await httpsServer(pem.wrongname!.key, pem.wrongname!.cert);
    try {
      const t = createAiAndHttpsTransport({ ca: caCert });
      const err = await t({ method: "GET", url: `${srv.url}/v1/models`, headers: { Authorization: `Bearer ${CANARY}` } }, new AbortController().signal).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AiAndTransportError);
      expect((err as AiAndTransportError).code).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
      expectNoKey(String(err));
      expect(srv.seen).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  it("HTTP endpoint in production is rejected before any request (server receives nothing)", async () => {
    const srv = await httpServer();
    try {
      const s = spy(createAiAndHttpsTransport());
      const env = { NODE_ENV: "production", KW_ALLOW_INSECURE_AIAND_HTTP: "1", KW_AIAND_ALLOWED_HOSTS: "127.0.0.1" } as NodeJS.ProcessEnv;
      const p = new AiAndProvider({ apiKey: CANARY, baseUrl: `${srv.url}/v1` }, { transport: s.t, policyEnv: () => env });
      expect(await p.health()).toMatchObject({ status: "unavailable", reason: "endpoint_rejected" });
      expect(s.calls).toHaveLength(0);
      expect(srv.seen).toHaveLength(0);
      // also via the env loader path
      const p2 = createInferenceProvider({ env: { ...env, AIAND_API_KEY: CANARY, AIAND_BASE_URL: `${srv.url}/v1` }, envFile: null, deps: { transport: s.t } });
      expect(await p2.health()).toMatchObject({ status: "unavailable", reason: "endpoint_rejected" });
      expect(s.calls).toHaveLength(0);
      expect(srv.seen).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  it("development-only http exception works only when every condition holds", async () => {
    const srv = await httpServer();
    try {
      const ok = { NODE_ENV: "development", KW_ALLOW_INSECURE_AIAND_HTTP: "1", KW_AIAND_ALLOWED_HOSTS: "127.0.0.1" } as NodeJS.ProcessEnv;
      const variants: NodeJS.ProcessEnv[] = [
        { ...ok, NODE_ENV: "production" },
        { ...ok, NODE_ENV: undefined },
        { ...ok, KW_ALLOW_INSECURE_AIAND_HTTP: "0" },
        { ...ok, KW_ALLOW_INSECURE_AIAND_HTTP: undefined },
        { ...ok, KW_AIAND_ALLOWED_HOSTS: undefined },
      ];
      for (const env of variants) {
        const s = spy(createAiAndHttpsTransport());
        const p = new AiAndProvider({ apiKey: CANARY, baseUrl: `${srv.url}/v1` }, { transport: s.t, policyEnv: () => env });
        expect(await p.health()).toMatchObject({ status: "unavailable", reason: "endpoint_rejected" });
        expect(s.calls).toHaveLength(0);
      }
      expect(srv.seen).toHaveLength(0);
      const p = new AiAndProvider({ apiKey: CANARY, baseUrl: `${srv.url}/v1` }, { transport: createAiAndHttpsTransport(), policyEnv: () => ok });
      expect((await p.health()).status).toBe("ok");
      expect(srv.seen).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });

  it("redirect to http:// and to another host -> error; the second server never sees the Authorization header", async () => {
    const plain = await httpServer();
    const other = await httpsServer(pem.good!.key, pem.good!.cert);
    let target = "";
    const redirector = await httpsServer(pem.good!.key, pem.good!.cert, (_req, res) => {
      res.writeHead(307, { location: target });
      res.end();
    });
    try {
      for (const loc of [`${plain.url}/v1/models`, `https://localhost:${other.port}/v1/models`, `${other.url}/v1/chat/completions`]) {
        target = loc;
        const t = createAiAndHttpsTransport({ ca: caCert });
        const err = await t({ method: "GET", url: `${redirector.url}/v1/models`, headers: { Authorization: `Bearer ${CANARY}` } }, new AbortController().signal).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(RedirectBlockedError);
        expectNoKey(String(err));

        // through the provider: terminal endpoint_rejected, no retry storm, nothing forwarded
        const env = { NODE_ENV: "test", KW_AIAND_ALLOWED_HOSTS: "127.0.0.1,localhost" } as NodeJS.ProcessEnv;
        const p = new AiAndProvider({ apiKey: CANARY, baseUrl: `${redirector.url}/v1` }, { transport: t, policyEnv: () => env });
        const h = await p.health();
        expect(h).toMatchObject({ status: "unavailable", reason: "endpoint_rejected" });
        expectNoKey(h);
      }
      expect(redirector.seen.length).toBeGreaterThan(0);
      expect(plain.seen).toHaveLength(0);
      expect(other.seen).toHaveLength(0);
    } finally {
      await Promise.all([plain.close(), other.close(), redirector.close()]);
    }
  });
});
