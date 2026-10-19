import type { ComponentStatus } from "@kw/schema";
import { GraphClient, type GraphClientOptions, type GraphHealth, type GraphResult } from "./client";
import { deleteRun, ensureConstraints, projectRunBundle, type ProjectOptions, type ProjectionReceipt } from "./projector";
import * as q from "./queries";

export * from "./client";
export * from "./config";
export * from "./model";
export * from "./bundle";
export { planProjection, verificationOutcomeProps, OWNED_LABELS, SHARED_LABELS, type NodeRow, type RelRow, type ProjectionPlan } from "./projection";
export { constraintStatements, ensureConstraints, projectRunBundle, deleteRun, type ProjectionReceipt, type ProjectOptions } from "./projector";
export * from "./queries";

/**
 * Convenience facade: one object the server can hold for the process lifetime. Every method returns a
 * GraphResult and never throws; when Neo4j is down or not configured the result is { ok: false, error: { kind:
 * "graph_unavailable" | "not_configured" | "auth_failed", ... } }.
 */
export class KwGraph {
  readonly client: GraphClient;
  constructor(opts: GraphClientOptions = {}) {
    this.client = new GraphClient(opts);
  }
  health(): Promise<GraphResult<GraphHealth>> {
    return this.client.health();
  }
  componentStatus(): Promise<ComponentStatus> {
    return this.client.componentStatus();
  }
  ensureConstraints() {
    return ensureConstraints(this.client);
  }
  projectRunBundle(bundle: unknown, opts?: ProjectOptions): Promise<GraphResult<ProjectionReceipt>> {
    return projectRunBundle(this.client, bundle, opts);
  }
  deleteRun(runId: string) {
    return deleteRun(this.client, runId);
  }
  // FR-8 questions
  eventsSupportingFinding(findingId: string, opts?: { includeNonObserved?: boolean }) {
    return q.eventsSupportingFinding(this.client, findingId, opts);
  }
  reportsComparedToObserved(runId: string, opts?: { observedEventId?: string }) {
    return q.reportsComparedToObserved(this.client, runId, opts);
  }
  processForEvent(eventId: string) {
    return q.processForEvent(this.client, eventId);
  }
  policyInEffect(eventId: string) {
    return q.policyInEffect(this.client, eventId);
  }
  safeguardsFromIncident(findingId: string) {
    return q.safeguardsFromIncident(this.client, findingId);
  }
  verificationOutcomes(by: { findingId: string } | { safeguardId: string }) {
    return q.verificationOutcomes(this.client, by);
  }
  // multi-hop investigations
  processAncestry(eventId: string, opts?: { maxDepth?: number }) {
    return q.processAncestry(this.client, eventId, opts);
  }
  crossRunResourceRecurrence(filter?: { resourceId?: string; findingId?: string; limit?: number }) {
    return q.crossRunResourceRecurrence(this.client, filter);
  }
  findingNeighborhood(findingId: string, depth?: number, opts?: { maxPaths?: number }) {
    return q.findingNeighborhood(this.client, findingId, depth, opts);
  }
  close(): Promise<void> {
    return this.client.close();
  }
}
