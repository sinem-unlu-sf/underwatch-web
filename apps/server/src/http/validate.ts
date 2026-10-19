import type { z } from "zod";
import { ApiHttpError } from "../errors";

function formatIssues(issues: z.core.$ZodIssue[]) {
  return issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}

/** Parses request input; failures become 400 validation_error with per-field issues in details. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown, part: "params" | "query" | "body"): z.output<S> {
  const result = schema.safeParse(value ?? (part === "body" ? undefined : {}));
  if (!result.success) {
    throw new ApiHttpError("validation_error", `Invalid request ${part}.`, { issues: formatIssues(result.error.issues) });
  }
  return result.data;
}

/**
 * Checks a response against its contract schema when enabled. A mismatch is a server bug, so it surfaces as a 500
 * rather than sending a body that breaks the client's assumptions.
 */
export function checkOutput<S extends z.ZodType>(schema: S, value: z.input<S>, enabled: boolean): z.output<S> | z.input<S> {
  if (!enabled) return value;
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiHttpError("internal_error", "Response did not match the API contract.", { issues: formatIssues(result.error.issues) });
  }
  return result.data;
}
