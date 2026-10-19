import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { KW_CLIENT_HEADER, KW_CLIENT_HEADER_VALUE } from "@kw/schema";
import { buildApp, type AppOptions } from "../app";
import { ensureAuthToken } from "../auth/token";
import type { ServerPaths } from "../config";
import { openDatabase, type Db } from "../db/connection";

export interface TestContext {
  db: Db;
  /**
   * app.inject here is wrapped: unless a test sets the header itself, every request carries the local API token, an
   * allowed Host, and (for mutating methods) WEB_HEADERS. Set a header to undefined to omit it (e.g. auth tests).
   */
  app: FastifyInstance;
  /** The unwrapped inject (no default headers). */
  rawInject: FastifyInstance["inject"];
  /** The test app's API token (data dir is a temp dir). */
  token: string;
  /** Temp dirs (workspaces, blobs) created for this app; removed by close(). */
  paths: ServerPaths;
  close: () => Promise<void>;
}

/** Temp ServerPaths so tests never touch data/ or real workspaces. demoTemplateDir/dockerDir still point at the repo. */
export function createTestPaths(): ServerPaths {
  const root = mkdtempSync(path.join(tmpdir(), "kw-test-"));
  return {
    repoRoot: path.resolve(import.meta.dirname, "../../../.."),
    dataDir: root,
    workspacesDir: path.join(root, "workspaces"),
    blobsDir: path.join(root, "evidence", "blobs"),
    demoTemplateDir: path.resolve(import.meta.dirname, "../../../../fixtures/demo-repo-template"),
    dockerDir: path.resolve(import.meta.dirname, "../../../../docker"),
    claudeTokenFile: path.join(root, "no-claude-token"),
  };
}

export async function createTestApp(
  env: NodeJS.ProcessEnv = {},
  opts: Pick<AppOptions, "inference" | "services" | "now" | "paths" | "graph"> = {},
): Promise<TestContext> {
  const db = openDatabase(":memory:");
  const paths = opts.paths ?? createTestPaths();
  const app = await buildApp({ db, dbLocation: { path: ":memory:", configuredVia: "test" }, env, validateResponses: true, ...opts, paths });
  const token = ensureAuthToken(paths.dataDir);
  const rawInject = app.inject.bind(app) as FastifyInstance["inject"];
  (app as { inject: unknown }).inject = withDefaultHeaders(rawInject, authHeaders(token));
  return {
    db,
    app,
    rawInject,
    token,
    paths,
    close: async () => {
      await app.close();
      db.close();
      if (!opts.paths) rmSync(paths.dataDir, { recursive: true, force: true });
    },
  };
}

/** Headers the web app sends on every request (see KW_CLIENT_HEADER in @kw/schema). */
export const WEB_HEADERS = { [KW_CLIENT_HEADER]: KW_CLIENT_HEADER_VALUE, origin: "http://127.0.0.1:4601" } as const;

/** Host + bearer token for a test app (what the web client sends through the Vite proxy). */
export function authHeaders(token: string): Record<string, string> {
  return { host: "127.0.0.1:4600", authorization: `Bearer ${token}` };
}

type InjectOpts = { method?: string; url?: string; headers?: Record<string, unknown> } & Record<string, unknown>;

function withDefaultHeaders(raw: FastifyInstance["inject"], defaults: Record<string, string>) {
  const call = raw as unknown as (opts?: unknown, cb?: unknown) => unknown;
  return (opts?: unknown, cb?: unknown) => {
    if (opts === undefined || typeof opts === "function") return call(opts, cb);
    const o: InjectOpts = typeof opts === "string" ? { url: opts } : (opts as InjectOpts);
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(String(o.method ?? "GET").toUpperCase());
    const given = Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const merged: Record<string, unknown> = { ...defaults, ...(mutating ? WEB_HEADERS : {}), ...given };
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    return call({ ...o, headers: merged }, cb);
  };
}

export function tableCount(db: Db, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

export async function getJson<T = any>(app: FastifyInstance, url: string): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as T };
}

export async function postJson<T = any>(app: FastifyInstance, url: string, payload: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: "POST", url, payload: payload as object, headers: WEB_HEADERS });
  return { status: res.statusCode, body: res.json() as T };
}
