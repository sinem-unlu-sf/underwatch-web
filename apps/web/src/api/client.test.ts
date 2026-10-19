import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, api, buildQuery } from "./client";

function mockFetch(impl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => vi.unstubAllGlobals());

async function failure(p: Promise<unknown>): Promise<ApiRequestError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiRequestError) return e;
    throw e;
  }
  throw new Error("expected rejection");
}

describe("api client", () => {
  it("builds query strings without empty values", () => {
    expect(buildQuery({ a: "x", b: undefined, c: "", d: 0, e: null })).toBe("?a=x&d=0");
    expect(buildQuery({})).toBe("");
  });

  it("reports unreachable when fetch throws", async () => {
    mockFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    const e = await failure(api.health());
    expect(e.kind).toBe("unreachable");
  });

  it("reports unreachable when the dev proxy answers 5xx without a JSON body", async () => {
    mockFetch(() => Promise.resolve(new Response("", { status: 500 })));
    const e = await failure(api.overview());
    expect(e.kind).toBe("unreachable");
  });

  it("surfaces ApiError bodies with their code", async () => {
    mockFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ error: { code: "not_found", message: "Run not found" } }), { status: 404 })),
    );
    const e = await failure(api.run("run_missing"));
    expect(e.kind).toBe("http");
    expect(e.code).toBe("not_found");
    expect(e.status).toBe(404);
  });

  it("rejects 200 responses that do not match the shared contract", async () => {
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ items: "nope", total: -1 }), { status: 200 })));
    const e = await failure(api.runs({}));
    expect(e.kind).toBe("contract");
    expect(Array.isArray(e.details)).toBe(true);
  });
});

describe("api token", () => {
  afterEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("moves ?token= from the URL into storage and sends it as a Bearer header", async () => {
    const { captureTokenFromUrl, getToken, TOKEN_STORAGE_KEY } = await import("./auth");
    window.history.replaceState(null, "", "/findings/fnd_1?token=abc123def&x=1#ask");
    expect(captureTokenFromUrl()).toBe(true);
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("abc123def");
    expect(getToken()).toBe("abc123def");
    expect(window.location.search).toBe("?x=1");
    expect(window.location.href).not.toContain("abc123def");

    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ authenticated: true, actor: "developer", mode: "token", detail: "ok" }))));
    vi.stubGlobal("fetch", fetchMock);
    await api.authCheck();
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer abc123def");
    expect(headers["x-kw-client"]).toBe("kw-web");
  });

  it("classifies 401/403 as permission denied", async () => {
    const { isPermissionDenied } = await import("./client");
    mockFetch(() => Promise.resolve(new Response(JSON.stringify({ error: { code: "unauthorized", message: "token required" } }), { status: 401 })));
    const e = await failure(api.authCheck());
    expect(isPermissionDenied(e)).toBe(true);
  });
});
