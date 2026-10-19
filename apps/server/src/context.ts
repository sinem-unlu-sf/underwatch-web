import type { FastifyBaseLogger } from "fastify";
import type { InferenceProvider } from "@kw/inference";
import type { DbLocation, ServerPaths } from "./config";
import type { Db } from "./db/connection";
import type { GraphRuntime } from "./graph/runtime";
import type { ServiceRegistry } from "./services/types";

/**
 * Shared server context handed to every module's register<X>Routes(app, ctx) and create<X>Service(ctx).
 * `services` is filled once all services are constructed; read it at call time (not at construction time) so module
 * construction order does not matter.
 */
export interface ServerContext {
  db: Db;
  dbLocation: DbLocation;
  env: NodeJS.ProcessEnv;
  paths: ServerPaths;
  log: FastifyBaseLogger;
  validateResponses: boolean;
  /** ai& provider (NullProvider when not configured, and always in tests unless injected). Never exposes the key. */
  inference: InferenceProvider;
  services: ServiceRegistry;
  /** Neo4j projection runtime (no-op when no KwGraph was injected, e.g. in tests). Never exposes credentials. */
  graph: GraphRuntime;
  now(): Date;
}
