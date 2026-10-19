import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KW_CLIENT_HEADER, KW_CLIENT_HEADER_VALUE, apiPaths } from "@kw/schema";
import { createTestApp, type TestContext } from "./helpers";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestApp();
});
afterEach(() => ctx.close());

const HOST = { host: "127.0.0.1:4600" };
const WEB = { ...HOST, origin: "http://127.0.0.1:4601", [KW_CLIENT_HEADER]: KW_CLIENT_HEADER_VALUE, "content-type": "application/json" };
const WEB_NO_BODY = { ...HOST, origin: "http://127.0.0.1:4601", [KW_CLIENT_HEADER]: KW_CLIENT_HEADER_VALUE };
const PASSWORD = "correct horse battery";

function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return ctx.rawInject({ method: "POST", url, payload: JSON.stringify(payload), headers: { ...WEB, ...headers } });
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function signup(email = "ana@example.com", extra: Record<string, unknown> = {}) {
  return post(apiPaths.accountSignup(), { name: "Ana", email, password: PASSWORD, setup_code: ctx.token, ...extra });
}

describe("local accounts", () => {
  it("refuses signup without the local setup code or API token (403)", async () => {
    const r = await post(apiPaths.accountSignup(), { name: "Ana", email: "ana@example.com", password: PASSWORD });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("forbidden");
    const wrong = await post(apiPaths.accountSignup(), { name: "Ana", email: "ana@example.com", password: PASSWORD, setup_code: "0".repeat(64) });
    expect(wrong.statusCode).toBe(403);
    expect(Number(ctx.db.prepare("SELECT COUNT(*) AS n FROM accounts").get()!.n)).toBe(0);
  });

  it("signs up with the setup code or the API token as Bearer (201), never returning the password hash", async () => {
    const viaCode = await signup();
    expect(viaCode.statusCode).toBe(201);
    const body = viaCode.json();
    expect(Object.keys(body.user).sort()).toEqual(["created_at", "email", "id", "name"]);
    expect(body.session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(viaCode.body).not.toContain(PASSWORD);
    expect(viaCode.body).not.toContain("scrypt");
    const viaBearer = await post(apiPaths.accountSignup(), { name: "Bo", email: "bo@example.com", password: PASSWORD }, bearer(ctx.token));
    expect(viaBearer.statusCode).toBe(201);
    // Stored: scrypt hash and sha256 of the session token only.
    const row = ctx.db.prepare("SELECT password_hash FROM accounts WHERE email = 'ana@example.com'").get() as { password_hash: string };
    expect(row.password_hash.startsWith("scrypt$")).toBe(true);
    expect(row.password_hash).not.toContain(PASSWORD);
    const sess = ctx.db.prepare("SELECT token_sha256 FROM sessions").all() as { token_sha256: string }[];
    expect(sess.map((s) => s.token_sha256)).not.toContain(body.session.token);
  });

  it("enforces password length and rejects duplicate emails case-insensitively (409)", async () => {
    const short = await signup("x@example.com", { password: "short" });
    expect(short.statusCode).toBe(400);
    expect((await signup()).statusCode).toBe(201);
    const dup = await signup("ANA@example.com");
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("conflict");
  });

  it("logs in (200) and fails with a generic 401 for a wrong password or unknown email", async () => {
    await signup();
    const ok = await post(apiPaths.accountLogin(), { email: "Ana@Example.com", password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.email).toBe("ana@example.com");
    expect(ok.body).not.toContain("password_hash");
    const wrong = await post(apiPaths.accountLogin(), { email: "ana@example.com", password: "wrong password!!" });
    const unknown = await post(apiPaths.accountLogin(), { email: "nobody@example.com", password: PASSWORD });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
  });

  it("accepts a session token as Bearer on the API, serves /me, and logout revokes it", async () => {
    const token = (await signup()).json().session.token as string;
    const overview = await ctx.rawInject({ method: "GET", url: apiPaths.overview(), headers: { ...HOST, ...bearer(token) } });
    expect(overview.statusCode).toBe(200);
    const me = await ctx.rawInject({ method: "GET", url: apiPaths.accountMe(), headers: { ...HOST, ...bearer(token) } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe("ana@example.com");
    expect(me.body).not.toContain("password");
    const out = await ctx.rawInject({ method: "POST", url: apiPaths.accountLogout(), headers: { ...WEB_NO_BODY, ...bearer(token) } });
    expect(out.statusCode).toBe(204);
    const after = await ctx.rawInject({ method: "GET", url: apiPaths.overview(), headers: { ...HOST, ...bearer(token) } });
    expect(after.statusCode).toBe(401);
    const meAfter = await ctx.rawInject({ method: "GET", url: apiPaths.accountMe(), headers: { ...HOST, ...bearer(token) } });
    expect(meAfter.statusCode).toBe(401);
  });

  it("rejects an expired session token", async () => {
    const token = (await signup()).json().session.token as string;
    ctx.db.prepare("UPDATE sessions SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    const r = await ctx.rawInject({ method: "GET", url: apiPaths.overview(), headers: { ...HOST, ...bearer(token) } });
    expect(r.statusCode).toBe(401);
  });

  it("keeps the API token working; /me with the API token is 401 (no account); Host/Origin/client checks still apply", async () => {
    const r = await ctx.rawInject({ method: "GET", url: apiPaths.overview(), headers: { ...HOST, ...bearer(ctx.token) } });
    expect(r.statusCode).toBe(200);
    const me = await ctx.rawInject({ method: "GET", url: apiPaths.accountMe(), headers: { ...HOST, ...bearer(ctx.token) } });
    expect(me.statusCode).toBe(401);
    const noClient = await ctx.rawInject({
      method: "POST",
      url: apiPaths.accountLogin(),
      payload: JSON.stringify({ email: "a@example.com", password: PASSWORD }),
      headers: { ...HOST, "content-type": "application/json" },
    });
    expect(noClient.statusCode).toBe(403);
    const evilOrigin = await post(apiPaths.accountLogin(), { email: "a@example.com", password: PASSWORD }, { origin: "http://evil.example" });
    expect(evilOrigin.statusCode).toBe(403);
    const evilHost = await post(apiPaths.accountSignup(), { name: "A", email: "a@example.com", password: PASSWORD, setup_code: ctx.token }, { host: "evil.example:4600" });
    expect(evilHost.statusCode).toBe(403);
    const anonLogout = await ctx.rawInject({ method: "POST", url: apiPaths.accountLogout(), headers: WEB_NO_BODY });
    expect(anonLogout.statusCode).toBe(401);
  });

  it("rate-limits login attempts per IP and email (429)", async () => {
    await signup();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await post(apiPaths.accountLogin(), { email: "ana@example.com", password: "wrong password!!" })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    const limited = await post(apiPaths.accountLogin(), { email: "ana@example.com", password: PASSWORD });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");
  });

  it("reports only the account count in settings status", async () => {
    await signup();
    const s = await ctx.app.inject({ method: "GET", url: apiPaths.settingsStatus() });
    expect(s.statusCode).toBe(200);
    expect(s.json().local_accounts).toBe(1);
    expect(s.body).not.toContain("ana@example.com");
  });
});
