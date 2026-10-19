import type { FastifyInstance } from "fastify";
import { API_ROUTES, AuthCheckResponse } from "@kw/schema";
import type { ServerContext } from "../context";
import { checkOutput } from "../http/validate";

export function registerAuthRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get(API_ROUTES.authCheck, async (req) => checkOutput(AuthCheckResponse, ctx.services.auth.check(req), ctx.validateResponses));
}
