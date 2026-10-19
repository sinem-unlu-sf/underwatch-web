import type { FastifyInstance } from "fastify";
import { API_ROUTES, IdParams, LiveFeedQuery, LiveFeedResponse, StartSupervisedRunBody, StartSupervisedRunResponse } from "@kw/schema";
import type { ServerContext } from "../context";
import { checkOutput, parseInput } from "../http/validate";
import { liveSnapshot } from "./live-feed";
import { getSupervisedService } from "./service";

/** POST /api/runs starts a live supervised run (202; poll GET /api/runs/:id, which carries `supervised`). */
export function registerSupervisedRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post(API_ROUTES.runs, async (req, reply) => {
    const body = parseInput(StartSupervisedRunBody, req.body, "body");
    const res = await getSupervisedService(ctx).start(body);
    return reply.status(202).send(checkOutput(StartSupervisedRunResponse, res, ctx.validateResponses));
  });

  /** GET /api/runs/:id/live: in-memory display stream of a supervised run in progress (agent stdout + kernel events). */
  app.get(API_ROUTES.runLive, async (req) => {
    const { id } = parseInput(IdParams, req.params, "params");
    const { after } = parseInput(LiveFeedQuery, req.query, "query");
    return checkOutput(LiveFeedResponse, await liveSnapshot(id, after), ctx.validateResponses);
  });
}
