import type { FastifyInstance } from "fastify";
import {
  API_ROUTES,
  IdParams,
  MECHANISMS,
  MechanismsResponse,
  SafeguardApproveBody,
  SafeguardDetailResponse,
  SafeguardMutationResponse,
  SafeguardPatchQuery,
  SafeguardProposalBody,
  SafeguardProposalResponse,
  SafeguardRejectBody,
  SafeguardRollbackBody,
  SafeguardVersionBody,
} from "@kw/schema";
import type { ServerContext } from "../context";
import { checkOutput, parseInput } from "../http/validate";

export function registerSafeguardRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const v = ctx.validateResponses;
  const svc = () => ctx.services.safeguards;
  const actor = (req: Parameters<typeof ctx.services.auth.actor>[0]) => ctx.services.auth.actor(req);

  app.get(API_ROUTES.safeguardMechanisms, async () => checkOutput(MechanismsResponse, { items: Object.values(MECHANISMS) }, v));

  app.post(API_ROUTES.findingSafeguardProposals, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const body = parseInput(SafeguardProposalBody, req.body, "body");
    return checkOutput(SafeguardProposalResponse, await svc().propose(id, body, actor(req)), v);
  });

  app.get(API_ROUTES.safeguard, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    return checkOutput(SafeguardDetailResponse, await svc().get(id), v);
  });

  app.post(API_ROUTES.safeguardVersions, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const body = parseInput(SafeguardVersionBody, req.body, "body");
    return checkOutput(SafeguardDetailResponse, await svc().addVersion(id, body, actor(req)), v);
  });

  app.post(API_ROUTES.safeguardReject, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const body = parseInput(SafeguardRejectBody, req.body, "body");
    return checkOutput(SafeguardDetailResponse, await svc().reject(id, body, actor(req)), v);
  });

  app.post(API_ROUTES.safeguardApprove, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const body = parseInput(SafeguardApproveBody, req.body, "body");
    return checkOutput(SafeguardMutationResponse, await svc().approve(id, body, actor(req)), v);
  });

  app.post(API_ROUTES.safeguardRollback, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const body = parseInput(SafeguardRollbackBody, req.body, "body");
    return checkOutput(SafeguardMutationResponse, await svc().rollback(id, body, actor(req)), v);
  });

  app.get(API_ROUTES.safeguardPatch, async (req, reply) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const { version_id } = parseInput(SafeguardPatchQuery, req.query, "query");
    const text = await svc().patch(id, version_id);
    return reply.type("text/plain; charset=utf-8").send(text);
  });
}
