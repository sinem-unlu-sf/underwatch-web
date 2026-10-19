import type { ServerContext } from "../context";
import type { ServiceRegistry } from "../services/types";

/**
 * Keeps the Neo4j projection in step with Ask Witness / safeguard / verification writes WITHOUT touching those modules:
 * each mutating service method is wrapped so that, after it succeeds, the owning run is re-projected in the background.
 * Projection is best-effort (ctx.graph records failures) and never delays or fails the original call.
 */
export function withGraphProjection(ctx: ServerContext, services: ServiceRegistry): ServiceRegistry {
  const after = <A extends unknown[], R>(fn: ((...args: A) => Promise<R>) | undefined, then: (result: R, ...args: A) => void) =>
    typeof fn !== "function"
      ? (fn as unknown as (...args: A) => Promise<R>) // test fakes may omit methods
      : async (...args: A): Promise<R> => {
      const result = await fn(...args);
      try {
        then(result, ...args);
      } catch (err) {
        ctx.log.warn({ err }, "graph projection scheduling failed");
      }
      return result;
    };

  const inv = services.investigations;
  const sg = services.safeguards;
  const ver = services.verification;
  const bySafeguard = (reason: string) => (_r: unknown, safeguardId: string, ..._rest: unknown[]) => ctx.graph.scheduleSafeguard(safeguardId, reason);

  return {
    ...services,
    investigations: {
      ...inv,
      ask: after(inv.ask?.bind(inv), (r, findingId) => ctx.graph.scheduleFinding(r.investigation.finding_id ?? findingId, "investigation")),
    },
    safeguards: {
      ...sg,
      propose: after(sg.propose?.bind(sg), (_r, findingId) => ctx.graph.scheduleFinding(findingId, "safeguard proposed")),
      addVersion: after(sg.addVersion?.bind(sg), bySafeguard("safeguard version")),
      reject: after(sg.reject?.bind(sg), bySafeguard("safeguard rejected")),
      approve: after(sg.approve?.bind(sg), bySafeguard("safeguard approved")),
      rollback: after(sg.rollback?.bind(sg), bySafeguard("safeguard rolled back")),
      recordVerification: after(sg.recordVerification?.bind(sg), bySafeguard("verification recorded")),
    },
    verification: {
      ...ver,
      startRun: after(ver.startRun?.bind(ver), bySafeguard("verification started")),
    },
  };
}
