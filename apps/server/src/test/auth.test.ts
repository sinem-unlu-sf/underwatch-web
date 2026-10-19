import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KW_CLIENT_HEADER, KW_CLIENT_HEADER_VALUE, apiPaths } from "@kw/schema";
import { createTestApp, type TestContext } from "./helpers";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestApp();
});
afterEach(() => ctx.close());

const HOST = { host: "127.0.0.1:4600" };
const ORIGIN = "http://127.0.0.1:4601";

describe("local auth guard", () => {
  it("creates a 32-byte token file with mode 600", () => {
    const file = path.join(ctx.paths.dataDir, "auth-token");
    expect(readFileSync(file, "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(ctx.token);
  });

  it("leaves /api/health open but requires the bearer token everywhere else (401)", async () => {
    const anon = await ctx.rawInject({ method: "GET", url: apiPaths.health(), headers: HOST });
    expect(anon.statusCode).toBe(200);
    // Minimal liveness only without the token: no version, no DB driver/detail.
    expect(Object.keys(anon.json()).sort()).toEqual(["service", "status", "time"]);
    const authed = await ctx.rawInject({ method: "GET", url: apiPaths.health(), headers: { ...HOST, authorization: `Bearer ${ctx.token}` } });
    expect(authed.json()).toMatchObject({ database: { ok: true }, version: expect.any(String) });
    const wrongH = await ctx.rawInject({ method: "GET", url: apiPaths.health(), headers: { ...HOST, authorization: `Bearer ${"0".repeat(64)}` } });
    expect(wrongH.json().database).toBeUndefined();
    const missing = await ctx.rawInject({ method: "GET", url: apiPaths.overview(), headers: HOST });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("unauthorized");
    const wrong = await ctx.rawInject({ method: "GET", url: apiPaths.workspaces(), headers: { ...HOST, authorization: `Bearer ${"0".repeat(64)}` } });
    expect(wrong.statusCode).toBe(401);
    const malformed = await ctx.rawInject({ method: "GET", url: apiPaths.workspaces(), headers: { ...HOST, authorization: ctx.token } });
    expect(malformed.statusCode).toBe(401);
    const ok = await ctx.rawInject({ method: "GET", url: apiPaths.authCheck(), headers: { ...HOST, authorization: `Bearer ${ctx.token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ authenticated: true, mode: "token" });
    expect(ok.body).not.toContain(ctx.token);
  });

  it("rejects foreign Host headers (DNS rebinding) with 403, even on /api/health", async () => {
    for (const host of ["evil.example:4600", "127.0.0.1:9999", "localhost"]) {
      const r = await ctx.rawInject({ method: "GET", url: apiPaths.health(), headers: { host } });
      expect(r.statusCode, host).toBe(403);
      expect(r.json().error.code).toBe("forbidden");
    }
    const viaProxy = await ctx.rawInject({ method: "GET", url: apiPaths.health(), headers: { host: "localhost:4601" } });
    expect(viaProxy.statusCode).toBe(200);
  });

  it("rejects mutating requests from a foreign Origin or without the client header (403)", async () => {
    const auth = { ...HOST, authorization: `Bearer ${ctx.token}`, "content-type": "application/json" };
    const payload = JSON.stringify({ path: "/tmp", label: "x", confirm: true });
    const evil = await ctx.rawInject({
      method: "POST",
      url: apiPaths.workspaces(),
      payload,
      headers: { ...auth, origin: "http://evil.example", [KW_CLIENT_HEADER]: KW_CLIENT_HEADER_VALUE },
    });
    expect(evil.statusCode).toBe(403);
    const noClient = await ctx.rawInject({ method: "POST", url: apiPaths.workspaces(), payload, headers: { ...auth, origin: ORIGIN } });
    expect(noClient.statusCode).toBe(403);
    // A GET from a foreign origin is refused too.
    const evilGet = await ctx.rawInject({ method: "GET", url: apiPaths.overview(), headers: { ...auth, origin: "http://evil.example" } });
    expect(evilGet.statusCode).toBe(403);
    // Allowed origin + header + token reaches the route (400 here: /tmp is not a project directory).
    const ok = await ctx.rawInject({
      method: "POST",
      url: apiPaths.workspaces(),
      payload,
      headers: { ...auth, origin: ORIGIN, [KW_CLIENT_HEADER]: KW_CLIENT_HEADER_VALUE },
    });
    expect(ok.statusCode).toBe(400);
  });

  it("answers CORS preflight without a token", async () => {
    const r = await ctx.rawInject({
      method: "OPTIONS",
      url: apiPaths.workspaces(),
      headers: { ...HOST, origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "authorization,x-kw-client" },
    });
    expect(r.statusCode).toBeLessThan(300);
  });
});
