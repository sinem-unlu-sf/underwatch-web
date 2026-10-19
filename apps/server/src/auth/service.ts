import type { AuthCheckResponse } from "@kw/schema";
import type { FastifyRequest } from "fastify";
import { UI_ACTOR } from "../config";
import type { ServerContext } from "../context";
import type { AuthService } from "../services/types";

/**
 * Local single-user auth. The guard (plugin.ts) has already verified Host, Origin, the client header (mutations) and
 * the bearer token before any route runs, so a request that reaches check() is authenticated.
 */
export function createAuthService(_ctx: ServerContext): AuthService {
  return {
    check(_req: FastifyRequest): AuthCheckResponse {
      return {
        authenticated: true,
        actor: UI_ACTOR,
        mode: "token",
        detail:
          "Local single-user mode: the API listens on 127.0.0.1 only, requires the local bearer token from data/auth-token, " +
          "checks Host and Origin, and requires the x-kw-client header on mutating requests.",
      };
    },
    actor(_req: FastifyRequest): string {
      return UI_ACTOR;
    },
  };
}
