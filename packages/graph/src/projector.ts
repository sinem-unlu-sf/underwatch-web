import { fail, ok, type GraphClient, type GraphResult, type TxRunner } from "./client";
import { parseRunBundle } from "./bundle";
import { NODE_LABELS, type NodeLabel } from "./model";
import { OWNED_LABELS, planProjection, type NodeRow, type ProjectionPlan, type RelRow } from "./projection";

// ---------------------------------------------------------------------------------------------------------------
// Schema DDL. Current (Neo4j 5.x / 2025+) syntax; IF NOT EXISTS makes it idempotent. Only uniqueness constraints
// and range indexes are used: property existence/type/key constraints are Enterprise-only.
// ---------------------------------------------------------------------------------------------------------------

export function constraintStatements(): string[] {
  const out: string[] = [];
  for (const label of NODE_LABELS) {
    out.push(`CREATE CONSTRAINT kw_${snake(label)}_id IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`);
  }
  for (const label of OWNED_LABELS) {
    out.push(`CREATE INDEX kw_${snake(label)}_owner_run IF NOT EXISTS FOR (n:${label}) ON (n.owner_run)`);
  }
  out.push("CREATE INDEX kw_event_run_id IF NOT EXISTS FOR (n:Event) ON (n.run_id)");
  out.push("CREATE INDEX kw_finding_recurrence_of IF NOT EXISTS FOR (n:Finding) ON (n.recurrence_of_finding_id)");
  out.push("CREATE INDEX kw_verification_executed_run IF NOT EXISTS FOR (n:VerificationRun) ON (n.executed_run_id)");
  out.push("CREATE INDEX kw_resource_key IF NOT EXISTS FOR (n:Resource) ON (n.kind, n.key)");
  return out;
}

const snake = (s: NodeLabel | string) => s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

export async function ensureConstraints(g: GraphClient): Promise<GraphResult<{ statements: number }>> {
  const stmts = constraintStatements();
  for (const s of stmts) {
    const r = await g.autoCommit(s);
    if (!r.ok) return r;
  }
  return ok({ statements: stmts.length });
}

// ---------------------------------------------------------------------------------------------------------------
// Projection executor
// ---------------------------------------------------------------------------------------------------------------

export interface ProjectionReceipt {
  run_id: string;
  mode: "replace" | "merge";
  /** Rows sent (distinct nodes / relationships in the plan). */
  nodes: number;
  relationships: number;
  nodes_by_label: Record<string, number>;
  relationships_by_type: Record<string, number>;
  /** Relationships the plan contained whose endpoint is not in the graph (e.g. recurrence of a finding in a run not yet projected). Not created; no stub nodes. */
  dangling: { type: string; key: string; from: string; to: string }[];
  /** Cross-run links created from already-projected runs pointing at this run (RECURRED_AS / EXECUTED_AS). */
  reverse_links: number;
  deleted_nodes: number;
  pruned_shared_nodes: number;
}

export interface ProjectOptions {
  /**
   * replace (default): delete this run's owned nodes first, then re-create them, so the graph mirrors the bundle
   * exactly (stale edges disappear). merge: only MERGE/SET, never delete.
   */
  mode?: "replace" | "merge";
}

function nodeStatement(primary: string, extra: string | null, shared: boolean): string {
  return [
    "UNWIND $rows AS row",
    `MERGE (n:${primary} {id: row.id})`,
    shared ? "SET n += row.props" : "SET n = row.props",
    extra ? `SET n:${extra}` : "",
    "FOREACH (_ IN CASE WHEN row.ts IS NULL THEN [] ELSE [1] END | SET n.ts = datetime(row.ts))",
    "RETURN count(n) AS c",
  ]
    .filter(Boolean)
    .join("\n");
}

function relStatement(type: string, fromLabel: string, toLabel: string): string {
  return [
    "UNWIND $rows AS row",
    `MATCH (a:${fromLabel} {id: row.from})`,
    `MATCH (b:${toLabel} {id: row.to})`,
    `MERGE (a)-[r:${type} {key: row.key}]->(b)`,
    "SET r = row.props",
    "RETURN collect(row.key) AS keys",
  ].join("\n");
}

const group = <T>(items: T[], key: (t: T) => string) => {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k) ?? [];
    arr.push(it);
    m.set(k, arr);
  }
  return m;
};

const BATCH = 500;

/**
 * Remove shared nodes no projected run refers to any more: resources nothing touches, policy versions no run is
 * under and nothing violates, and logical policies left without versions. `keep`: shared ids of the bundle being
 * projected (never pruned, even when nothing in the bundle links to them yet).
 */
async function pruneShared(tx: TxRunner, keep: string[]): Promise<number> {
  let n = 0;
  for (const stmt of [
    "MATCH (n:Resource) WHERE NOT (n)--() AND NOT n.id IN $keep DELETE n RETURN count(*) AS c",
    "MATCH (n:PolicyVersion) WHERE NOT (n)-[:UNDER_POLICY|VIOLATES]-() AND NOT n.id IN $keep DETACH DELETE n RETURN count(*) AS c",
    "MATCH (n:Policy) WHERE NOT (n)--() AND NOT n.id IN $keep DELETE n RETURN count(*) AS c",
  ]) {
    const r = await tx.run(stmt, { keep });
    n += Number(r.records[0]?.get("c") ?? 0);
  }
  return n;
}

const POLICY_CONFLICT_CODE = "KW.PolicyVersionImmutable";

/**
 * Policy versions are immutable snapshots shared by every run under them (FR-8: later changes must not silently
 * rewrite historical conclusions). Shared nodes are merged with SET +=, so without this check a bundle carrying a
 * different policy body under an existing version id would silently rewrite the policy other runs were judged by.
 */
async function assertPolicyVersionsUnchanged(tx: TxRunner, plan: ProjectionPlan): Promise<void> {
  const rows = plan.nodes.filter((n) => n.primary === "PolicyVersion").map((n) => ({ id: n.id, sha: n.props.content_sha256 ?? null }));
  if (rows.length === 0) return;
  const r = await tx.run(
    `UNWIND $rows AS row
     MATCH (pv:PolicyVersion {id: row.id})
     WHERE pv.content_sha256 IS NOT NULL AND row.sha IS NOT NULL AND pv.content_sha256 <> row.sha
     RETURN collect(pv.id) AS ids`,
    { rows },
  );
  const ids = (r.records[0]?.get("ids") as string[] | undefined) ?? [];
  if (ids.length > 0) {
    throw Object.assign(new Error(`PolicyVersion content differs from the projected snapshot (immutable): ${ids.join(", ")}`), { code: POLICY_CONFLICT_CODE });
  }
}

async function applyPlan(tx: TxRunner, plan: ProjectionPlan, mode: "replace" | "merge"): Promise<ProjectionReceipt> {
  await assertPolicyVersionsUnchanged(tx, plan);
  let deleted = 0;
  if (mode === "replace") {
    for (const label of OWNED_LABELS) {
      const r = await tx.run(`MATCH (n:${label} {owner_run: $runId}) DETACH DELETE n RETURN count(*) AS c`, { runId: plan.runId });
      deleted += Number(r.records[0]?.get("c") ?? 0);
    }
  }

  const nodesByLabel: Record<string, number> = {};
  for (const [k, rows] of group<NodeRow>(plan.nodes, (n) => `${n.primary}|${n.extra ?? ""}|${n.shared}`)) {
    const [primary, extra, shared] = k.split("|") as [string, string, string];
    const stmt = nodeStatement(primary, extra || null, shared === "true");
    for (let i = 0; i < rows.length; i += BATCH) {
      await tx.run(stmt, { rows: rows.slice(i, i + BATCH).map((n) => ({ id: n.id, ts: n.ts, props: n.props })) });
    }
    const label = extra || primary;
    nodesByLabel[label] = (nodesByLabel[label] ?? 0) + rows.length;
  }

  const relsByType: Record<string, number> = {};
  const dangling: ProjectionReceipt["dangling"] = [];
  for (const [k, rows] of group<RelRow>(plan.rels, (r) => `${r.type}|${r.fromLabel}|${r.toLabel}`)) {
    const [type, fromLabel, toLabel] = k.split("|") as [string, string, string];
    const stmt = relStatement(type, fromLabel, toLabel);
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const res = await tx.run(stmt, { rows: slice.map((r) => ({ from: r.from, to: r.to, key: r.key, props: r.props })) });
      const created = new Set((res.records[0]?.get("keys") as string[] | undefined) ?? []);
      for (const r of slice) {
        if (created.has(r.key)) relsByType[type] = (relsByType[type] ?? 0) + 1;
        else dangling.push({ type, key: r.key, from: r.from, to: r.to });
      }
    }
  }

  // Cross-run links whose source record belongs to ANOTHER, already-projected run (their owner is that run).
  const rev1 = await tx.run(
    `UNWIND $findingIds AS fid
     MATCH (later:Finding {recurrence_of_finding_id: fid})
     WHERE later.owner_run <> $runId
     MATCH (prior:Finding {id: fid})
     WITH prior, later, 'recurrence:' + later.id AS k
     MERGE (prior)-[r:RECURRED_AS {key: k}]->(later)
     SET r = {key: k, basis: 'derived', rule: 'finding.recurrence_of_finding_id', confidence: null,
              record_basis: null, owner_run: later.owner_run}
     RETURN count(r) AS c`,
    { findingIds: plan.findingIds, runId: plan.runId },
  );
  const rev2 = await tx.run(
    `MATCH (vr:VerificationRun {executed_run_id: $runId})
     WHERE vr.owner_run <> $runId
     MATCH (run:Run {id: $runId})
     WITH vr, run, 'executed:' + vr.id AS k
     MERGE (vr)-[r:EXECUTED_AS {key: k}]->(run)
     SET r = {key: k, basis: 'derived', rule: 'verification_run.run_id', confidence: null,
              record_basis: null, owner_run: vr.owner_run}
     RETURN count(r) AS c`,
    { runId: plan.runId },
  );
  const reverse = Number(rev1.records[0]?.get("c") ?? 0) + Number(rev2.records[0]?.get("c") ?? 0);

  let pruned = 0;
  if (mode === "replace") {
    // Shared nodes left without any relationship (e.g. a resource only this run touched, before re-projection).
    pruned = await pruneShared(tx, plan.nodes.filter((n) => n.shared).map((n) => n.id));
  }

  return {
    run_id: plan.runId,
    mode,
    nodes: plan.nodes.length,
    relationships: plan.rels.length - dangling.length,
    nodes_by_label: nodesByLabel,
    relationships_by_type: relsByType,
    dangling,
    reverse_links: reverse,
    deleted_nodes: deleted,
    pruned_shared_nodes: pruned,
  };
}

/**
 * Project one run bundle (FixtureRunFile-shaped, or the RunBundle shape for live runs) into the graph in a single
 * write transaction. Idempotent: projecting the same bundle again yields the same nodes and relationships.
 */
export async function projectRunBundle(g: GraphClient, input: unknown, opts: ProjectOptions = {}): Promise<GraphResult<ProjectionReceipt>> {
  const parsed = parseRunBundle(input);
  if (!parsed.ok) return fail("invalid_input", `Bundle failed validation: ${parsed.issues.join("; ")}`);
  const plan = planProjection(parsed.bundle);
  const mode = opts.mode ?? "replace";
  const r = await g.write((tx) => applyPlan(tx, plan, mode));
  if (!r.ok && r.error.code === POLICY_CONFLICT_CODE) return fail("invalid_input", r.error.message, POLICY_CONFLICT_CODE);
  return r;
}

/** Remove a run's owned subgraph (and shared nodes left orphaned). Cross-run links into it disappear with it. */
export async function deleteRun(g: GraphClient, runId: string): Promise<GraphResult<{ deleted_nodes: number; pruned_shared_nodes: number }>> {
  return g.write(async (tx) => {
    let deleted = 0;
    for (const label of OWNED_LABELS) {
      const r = await tx.run(`MATCH (n:${label} {owner_run: $runId}) DETACH DELETE n RETURN count(*) AS c`, { runId });
      deleted += Number(r.records[0]?.get("c") ?? 0);
    }
    return { deleted_nodes: deleted, pruned_shared_nodes: await pruneShared(tx, []) };
  });
}
