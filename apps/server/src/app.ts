import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { KwGraph } from "@kw/graph";
import { NullProvider, type InferenceProvider } from "@kw/inference";
import { describeInference } from "./status";
import { safeRedact } from "@kw/redaction";
import type { ApiError } from "@kw/schema";
import { ALLOWED_ORIGINS, defaultServerPaths, type DbLocation, type ServerPaths } from "./config";
import type { ServerContext } from "./context";
import type { Db } from "./db/connection";
import { ApiHttpError } from "./errors";
import { registerFindingsViewsRoutes } from "./findings-views";
import { createGraphRuntime } from "./graph/runtime";
import { registerRoutes } from "./routes";
import { createServiceRegistry, registerAddendumGuard, registerAddendumRoutes, type ServiceOverrides } from "./services/registry";

export interface AppOptions {
  db: Db;
  dbLocation: DbLocation;
  env?: NodeJS.ProcessEnv;
  /** true = Fastify's default logger; an object lets tests capture log lines (redaction tests assert no secret is logged). */
  logger?: boolean | { level?: string; stream?: { write(msg: string): void } };
  /** Validate every response against its contract schema. Defaults to on unless NODE_ENV=production. */
  validateResponses?: boolean;
  /** Filesystem locations (workspaces, blobs, docker). Tests pass temp dirs. */
  paths?: ServerPaths;
  /** ai& provider. Defaults to NullProvider ("not configured") so tests never call the network; index.ts passes the real one. */
  inference?: InferenceProvider;
  /** Neo4j client. Defaults to none (graph features fall back to SQLite) so tests never touch the dev graph; index.ts passes the real one. */
  graph?: KwGraph | null;
  /** Replace individual services (tests). */
  services?: ServiceOverrides;
  now?: () => Date;
}

function errorBody(code: ApiError["error"]["code"], message: string, details?: unknown): ApiError {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

/** Log lines never carry raw error text: messages/stacks can quote request or evidence content (ISSUE 3). */
const redactLogText = (s: string) => safeRedact(s).text;
const LOG_SERIALIZERS = {
  err: (e: unknown) => {
    const x = (e ?? {}) as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown };
    return { type: typeof x.name === "string" ? x.name : typeof e, message: redactLogText(String(x.message ?? e)), stack: redactLogText(String(x.stack ?? "")), code: x.code };
  },
};

/** Builds the API without listening, so tests can drive it with app.inject. The caller owns the database handle. */
export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const env = opts.env ?? process.env;
  const app = Fastify({ logger: opts.logger === true ? { serializers: LOG_SERIALIZERS } : opts.logger ? { ...opts.logger, serializers: LOG_SERIALIZERS } : false });

  await app.register(cors, { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] });

  app.setErrorHandler((err: FastifyError | ApiHttpError, req, reply) => {
    if (err instanceof ApiHttpError) {
      if (err.statusCode >= 500) req.log.error({ err, details: err.details === undefined ? undefined : redactLogText(JSON.stringify(err.details)) }, redactLogText(err.message));
      return reply.status(err.statusCode).send(errorBody(err.code, err.message, err.details));
    }
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.status(status).send(errorBody("validation_error", err.message, err.code ? { fastify_code: err.code } : undefined));
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send(errorBody("internal_error", "Internal server error."));
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send(errorBody("not_found", `No route for ${req.method} ${req.url.split("?")[0]}.`)),
  );

  const validateResponses = opts.validateResponses ?? env.NODE_ENV !== "production";
  const ctx = {
    db: opts.db,
    dbLocation: opts.dbLocation,
    env,
    paths: opts.paths ?? defaultServerPaths(env),
    log: app.log,
    validateResponses,
    inference: opts.inference ?? new NullProvider("ai& not configured"),
    now: opts.now ?? (() => new Date()),
  } as ServerContext;
  ctx.graph = createGraphRuntime({ db: opts.db, log: app.log, env, kw: opts.graph ?? null, now: ctx.now });
  app.addHook("onClose", async () => ctx.graph.close());
  ctx.services = createServiceRegistry(ctx, opts.services);
  app.decorate("kw", ctx);

  registerAddendumGuard(app, ctx);
  registerRoutes(app, {
    db: opts.db,
    dbLocation: opts.dbLocation,
    env,
    validateResponses,
    neo4jStatus: () => ctx.graph.status(),
    neo4jCached: () => ctx.graph.cachedStatus(),
    inference: describeInference(ctx.inference as { id: string; model: string; keySource?: string | null; baseHost?: string | null }),
  });
  registerAddendumRoutes(app, ctx);
  registerFindingsViewsRoutes(app, ctx);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Shared server context (db, paths, services). */
    kw: ServerContext;
  }
}
