import type { FastifyInstance } from "fastify";
import { registerAccountRoutes } from "../accounts/routes";
import { createAuthService, registerAuthGuard, registerAuthRoutes } from "../auth";
import type { ServerContext } from "../context";
import { createGraphService, registerGraphRoutes, withGraphProjection } from "../graph";
import { createInvestigationService, registerInvestigationRoutes } from "../investigations";
import { createSafeguardService, registerSafeguardRoutes } from "../safeguards";
import { registerSupervisedRoutes } from "../supervised";
import { createVerificationService, registerVerificationRoutes } from "../verification";
import { createWorkspaceService, registerWorkspaceRoutes } from "../workspaces";
import { FsBlobStore } from "./blobs";
import { createGraphEvidenceRetriever } from "./graph-retriever";
import type { ServiceRegistry } from "./types";

/** Test seam: replace any service with a fake (e.g. a fake WorkspaceService in safeguard tests). */
export type ServiceOverrides = Partial<{ [K in keyof ServiceRegistry]: (ctx: ServerContext) => ServiceRegistry[K] }>;

/** Builds every service. Services read ctx.services lazily, so order here does not matter. */
export function createServiceRegistry(ctx: ServerContext, overrides: ServiceOverrides = {}): ServiceRegistry {
  const make = <K extends keyof ServiceRegistry>(key: K, fallback: (c: ServerContext) => ServiceRegistry[K]): ServiceRegistry[K] =>
    (overrides[key] ?? fallback)(ctx);
  return withGraphProjection(ctx, {
    auth: make("auth", createAuthService),
    blobs: make("blobs", (c) => new FsBlobStore(c.paths.blobsDir)),
    // Graph-backed by default; it falls back to the relational retriever (and says so) when Neo4j is unavailable.
    evidence: make("evidence", createGraphEvidenceRetriever),
    workspaces: make("workspaces", createWorkspaceService),
    investigations: make("investigations", createInvestigationService),
    safeguards: make("safeguards", createSafeguardService),
    verification: make("verification", createVerificationService),
    graph: make("graph", createGraphService),
  });
}

/** Guard first (onRequest hooks must exist before routes), then each module's routes. */
export function registerAddendumGuard(app: FastifyInstance, ctx: ServerContext): void {
  registerAuthGuard(app, ctx);
}

export function registerAddendumRoutes(app: FastifyInstance, ctx: ServerContext): void {
  registerAuthRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  registerWorkspaceRoutes(app, ctx);
  registerInvestigationRoutes(app, ctx);
  registerSafeguardRoutes(app, ctx);
  registerVerificationRoutes(app, ctx);
  registerGraphRoutes(app, ctx);
  registerSupervisedRoutes(app, ctx);
}
