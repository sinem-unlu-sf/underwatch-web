import type { FastifyInstance } from "fastify";
import { API_ROUTES, IdParams, StartVerificationBody, VerificationHarnessStatus, VerificationRunResponse } from "@kw/schema";
import type { ServerContext } from "../context";
import { checkOutput, parseInput } from "../http/validate";

export function registerVerificationRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const v = ctx.validateResponses;
  const svc = () => ctx.services.verification;

  app.post(API_ROUTES.safeguardVerificationRuns, async (req, reply) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const body = parseInput(StartVerificationBody, req.body, "body");
    const res = await svc().startRun(id, body, ctx.services.auth.actor(req));
    return reply.status(202).send(checkOutput(VerificationRunResponse, res, v));
  });

  app.get(API_ROUTES.verificationRun, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    return checkOutput(VerificationRunResponse, await svc().getRun(id), v);
  });

  app.get(API_ROUTES.verificationHarness, async () => checkOutput(VerificationHarnessStatus, await svc().harnessStatus(), v));
}
