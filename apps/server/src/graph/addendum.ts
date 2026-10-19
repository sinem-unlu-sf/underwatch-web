/**
 * Ask Witness addendum nodes in the Neo4j projection (docs/PRD-addendum-ask-witness.md section 6). @kw/graph projects the
 * core run (Run, events, findings, v1 safeguard/verification rows); this module adds, per run:
 *   (Investigation)-[:INVESTIGATES]->(Finding), (Investigation)-[:USES_EVIDENCE]->(AgentAction|ObservedEvent|Evidence)
 *   (Safeguard)-[:ADDRESSES]->(Finding), (Safeguard)-[:HAS_VERSION|CURRENT_VERSION]->(SafeguardVersion)
 *   (SafeguardVersion)-[:PREVIOUS_VERSION]->(SafeguardVersion), (SafeguardVersion)-[:FROM_INVESTIGATION]->(Investigation)
 *   (VerificationRun)-[:TESTS]->(Safeguard), (VerificationRun)-[:TESTS_VERSION]->(SafeguardVersion)
 * and the secondary label AgentAction on every AgentEvent. Neo4j never holds full AI answers, safeguard content or file
 * contents: an Investigation keeps a short redacted summary of its latest answer; a SafeguardVersion keeps a content hash.
 * USES_EVIDENCE only points at ids the application validated as present in the bundle sent to the model.
 */
import { createHash } from "node:crypto";
import { redact } from "@kw/redaction";
import type { GraphClient, GraphResult } from "@kw/graph";
import type { InvestigationTurn } from "@kw/schema";
import { stmt } from "../db/codec";
import type { Db } from "../db/connection";

export const ADDENDUM_CONSTRAINTS = [
  "CREATE CONSTRAINT kw_investigation_id IF NOT EXISTS FOR (n:Investigation) REQUIRE n.id IS UNIQUE",
  "CREATE CONSTRAINT kw_safeguard_version_id IF NOT EXISTS FOR (n:SafeguardVersion) REQUIRE n.id IS UNIQUE",
  "CREATE INDEX kw_investigation_owner_run IF NOT EXISTS FOR (n:Investigation) ON (n.owner_run)",
  "CREATE INDEX kw_safeguard_version_owner_run IF NOT EXISTS FOR (n:SafeguardVersion) ON (n.owner_run)",
];

const SUMMARY_CHARS = 200;

function parse<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** Redacted, single-line, truncated: the only part of an AI answer that is copied into the graph. */
export function shortRedactedSummary(text: string | null | undefined, knownSecrets: string[] = []): string | null {
  if (!text) return null;
  const r = redact(text, { knownSecrets }).text.replace(/\s+/g, " ").trim();
  return r.length > SUMMARY_CHARS ? `${r.slice(0, SUMMARY_CHARS - 1)}…` : r;
}

/** Ids the application validated as in-bundle for a turn's answer (never the raw model output). */
export function validatedCitations(answer: InvestigationTurn["answer"]): string[] {
  if (!answer) return [];
  const ids = new Set<string>(answer.evidence_references);
  for (const c of [...answer.verified_facts, ...answer.hypotheses, ...answer.unsupported_claims]) for (const id of c.evidence_ids) ids.add(id);
  return [...ids].sort();
}

export interface AddendumPlan {
  investigations: Array<{ id: string; props: Record<string, unknown>; finding_id: string; cited: string[] }>;
  safeguards: Array<{ id: string; finding_id: string; props: Record<string, unknown> }>;
  versions: Array<{ id: string; safeguard_id: string; prev: string | null; current: boolean; investigation_id: string | null; props: Record<string, unknown> }>;
  verifications: Array<{ id: string; safeguard_id: string; version_id: string | null; verification_status: string | null }>;
}

/** Pure read of the relational rows for one run (deterministic order). */
export function planAddendum(db: Db, runId: string, knownSecrets: string[] = []): AddendumPlan {
  const invRows = stmt(db, "SELECT id, finding_id, run_id, status, created_at, updated_at FROM investigations WHERE run_id = ? AND finding_id IS NOT NULL ORDER BY id").all(runId);
  const investigations = invRows.map((inv) => {
    const turns = stmt(db, "SELECT model, status, answer, created_at FROM investigation_turns WHERE investigation_id = ? ORDER BY seq").all(inv.id as string);
    const cited = new Set<string>();
    for (const t of turns) for (const id of validatedCitations(parse<InvestigationTurn["answer"]>(t.answer, null))) cited.add(id);
    const last = turns.at(-1);
    const lastAnswer = last ? parse<InvestigationTurn["answer"]>(last.answer, null) : null;
    return {
      id: inv.id as string,
      finding_id: inv.finding_id as string,
      cited: [...cited].sort(),
      props: {
        id: inv.id,
        owner_run: runId,
        finding_id: inv.finding_id,
        run_id: inv.run_id,
        status: inv.status,
        created_at: inv.created_at,
        updated_at: inv.updated_at,
        turn_count: turns.length,
        model: (last?.model as string | undefined) ?? null,
        latest_turn_status: (last?.status as string | undefined) ?? null,
        latest_answer_summary: shortRedactedSummary(lastAnswer?.summary, knownSecrets),
        advisory: true,
      },
    };
  });

  const sgRows = stmt(
    db,
    `SELECT s.id AS id, s.finding_id AS finding_id, s.lifecycle_status AS lifecycle_status, s.verification_state AS verification_state,
            s.current_version_id AS current_version_id, s.source_investigation_id AS source_investigation_id, s.workspace_id AS workspace_id
     FROM safeguards s JOIN findings f ON f.id = s.finding_id WHERE f.run_id = ? ORDER BY s.id`,
  ).all(runId);
  const safeguards = sgRows.map((s) => ({
    id: s.id as string,
    finding_id: s.finding_id as string,
    props: {
      lifecycle_status: s.lifecycle_status ?? null,
      verification_state: s.verification_state ?? null,
      current_version_id: s.current_version_id ?? null,
      source_investigation_id: s.source_investigation_id ?? null,
      workspace_id: s.workspace_id ?? null,
    },
  }));

  const versions: AddendumPlan["versions"] = [];
  for (const s of sgRows) {
    const rows = stmt(
      db,
      "SELECT id, safeguard_id, version, type, content, target, author, source_investigation_id, model, prompt_version, created_at FROM safeguard_versions WHERE safeguard_id = ? ORDER BY version",
    ).all(s.id as string);
    let prev: string | null = null;
    for (const v of rows) {
      const target = parse<Record<string, unknown>>(v.target, {});
      versions.push({
        id: v.id as string,
        safeguard_id: v.safeguard_id as string,
        prev,
        current: v.id === s.current_version_id,
        investigation_id: (v.source_investigation_id as string | null) ?? null,
        props: {
          id: v.id,
          owner_run: runId,
          safeguard_id: v.safeguard_id,
          version: Number(v.version),
          type: v.type,
          author: v.author,
          target_kind: typeof target.kind === "string" ? target.kind : null,
          target_path: typeof target.rel_path === "string" ? target.rel_path : null,
          // content itself stays in SQLite; the graph keeps only its hash and size.
          content_sha256: createHash("sha256").update(String(v.content ?? ""), "utf8").digest("hex"),
          content_chars: String(v.content ?? "").length,
          source_investigation_id: v.source_investigation_id ?? null,
          model: v.model ?? null,
          prompt_version: v.prompt_version ?? null,
          created_at: v.created_at,
        },
      });
      prev = v.id as string;
    }
  }

  const verifications = stmt(
    db,
    `SELECT v.id AS id, v.safeguard_id AS safeguard_id, v.version_id AS version_id, v.verification_status AS verification_status
     FROM verification_runs v JOIN safeguards s ON s.id = v.safeguard_id JOIN findings f ON f.id = s.finding_id WHERE f.run_id = ? ORDER BY v.id`,
  )
    .all(runId)
    .map((v) => ({
      id: v.id as string,
      safeguard_id: v.safeguard_id as string,
      version_id: (v.version_id as string | null) ?? null,
      verification_status: (v.verification_status as string | null) ?? null,
    }));

  return { investigations, safeguards, versions, verifications };
}

export interface AddendumReceipt {
  investigations: number;
  uses_evidence: number;
  safeguard_versions: number;
  addresses: number;
  tests: number;
  agent_actions_labeled: number;
}

/**
 * Replace the run's addendum subgraph (delete + re-create), so it mirrors SQLite exactly; idempotent. Must run after
 * the core projection of the same run (it MATCHes the run's Finding/Safeguard/VerificationRun/Event nodes).
 */
export async function projectAddendum(g: GraphClient, runId: string, plan: AddendumPlan): Promise<GraphResult<AddendumReceipt>> {
  return g.write(async (tx) => {
    const count = async (cypher: string, params: Record<string, unknown>) => Number((await tx.run(cypher, params)).records[0]?.get("c") ?? 0);
    await tx.run("MATCH (n:Investigation {owner_run: $runId}) DETACH DELETE n", { runId });
    await tx.run("MATCH (n:SafeguardVersion {owner_run: $runId}) DETACH DELETE n", { runId });
    const agentActions = await count("MATCH (e:AgentEvent {owner_run: $runId}) SET e:AgentAction RETURN count(e) AS c", { runId });

    const investigations = await count(
      `UNWIND $rows AS row
       MERGE (i:Investigation {id: row.id}) SET i = row.props
       WITH i, row MATCH (f:Finding {id: row.finding_id})
       MERGE (i)-[r:INVESTIGATES {key: 'investigates:' + row.id}]->(f)
       SET r = {key: 'investigates:' + row.id, basis: 'derived', rule: 'investigation.finding_id', owner_run: $runId}
       RETURN count(DISTINCT i) AS c`,
      { rows: plan.investigations.map((i) => ({ id: i.id, finding_id: i.finding_id, props: i.props })), runId },
    );
    const uses = await count(
      `UNWIND $rows AS row
       MATCH (i:Investigation {id: row.inv})
       CALL (row) { MATCH (n:Event {id: row.target}) RETURN n UNION MATCH (n:Evidence {id: row.target}) RETURN n }
       MERGE (i)-[r:USES_EVIDENCE {key: 'uses:' + row.inv + ':' + row.target}]->(n)
       SET r = {key: 'uses:' + row.inv + ':' + row.target, basis: 'ai', rule: 'investigation_turn.answer citations (validated in-bundle)', owner_run: $runId}
       RETURN count(r) AS c`,
      { rows: plan.investigations.flatMap((i) => i.cited.map((target) => ({ inv: i.id, target }))), runId },
    );
    const addresses = await count(
      `UNWIND $rows AS row
       MATCH (s:Safeguard {id: row.id}) MATCH (f:Finding {id: row.finding_id})
       SET s += row.props
       MERGE (s)-[r:ADDRESSES {key: 'addresses:' + row.id}]->(f)
       SET r = {key: 'addresses:' + row.id, basis: 'derived', rule: 'safeguard.finding_id', owner_run: $runId}
       RETURN count(r) AS c`,
      { rows: plan.safeguards, runId },
    );
    const versions = await count(
      `UNWIND $rows AS row
       MATCH (s:Safeguard {id: row.safeguard_id})
       MERGE (v:SafeguardVersion {id: row.id}) SET v = row.props
       MERGE (s)-[r:HAS_VERSION {key: 'has_version:' + row.id}]->(v)
       SET r = {key: 'has_version:' + row.id, basis: 'derived', rule: 'safeguard_version.safeguard_id', owner_run: $runId}
       FOREACH (_ IN CASE WHEN row.current THEN [1] ELSE [] END |
         MERGE (s)-[c:CURRENT_VERSION {key: 'current:' + s.id}]->(v)
         SET c = {key: 'current:' + s.id, basis: 'derived', rule: 'safeguards.current_version_id', owner_run: $runId})
       RETURN count(v) AS c`,
      { rows: plan.versions.map((v) => ({ id: v.id, safeguard_id: v.safeguard_id, current: v.current, props: v.props })), runId },
    );
    await tx.run(
      `UNWIND $rows AS row
       MATCH (v:SafeguardVersion {id: row.id}) MATCH (p:SafeguardVersion {id: row.prev})
       MERGE (v)-[r:PREVIOUS_VERSION {key: 'prev:' + row.id}]->(p)
       SET r = {key: 'prev:' + row.id, basis: 'derived', rule: 'safeguard_version.version - 1', owner_run: $runId}`,
      { rows: plan.versions.filter((v) => v.prev).map((v) => ({ id: v.id, prev: v.prev })), runId },
    );
    await tx.run(
      `UNWIND $rows AS row
       MATCH (v:SafeguardVersion {id: row.id}) MATCH (i:Investigation {id: row.inv})
       MERGE (v)-[r:FROM_INVESTIGATION {key: 'from_inv:' + row.id}]->(i)
       SET r = {key: 'from_inv:' + row.id, basis: 'ai', rule: 'safeguard_version.source_investigation_id', owner_run: $runId}`,
      { rows: plan.versions.filter((v) => v.investigation_id).map((v) => ({ id: v.id, inv: v.investigation_id })), runId },
    );
    const tests = await count(
      `UNWIND $rows AS row
       MATCH (vr:VerificationRun {id: row.id}) MATCH (s:Safeguard {id: row.safeguard_id})
       SET vr.verification_status = row.verification_status, vr.version_id = row.version_id
       MERGE (vr)-[r:TESTS {key: 'tests:' + row.id}]->(s)
       SET r = {key: 'tests:' + row.id, basis: 'derived', rule: 'verification_run.safeguard_id', owner_run: $runId}
       RETURN count(r) AS c`,
      { rows: plan.verifications, runId },
    );
    await tx.run(
      `UNWIND $rows AS row
       MATCH (vr:VerificationRun {id: row.id}) MATCH (v:SafeguardVersion {id: row.version_id})
       MERGE (vr)-[t:TESTS_VERSION {key: 'tests_version:' + row.id}]->(v)
       SET t = {key: 'tests_version:' + row.id, basis: 'derived', rule: 'verification_run.version_id', owner_run: $runId}`,
      { rows: plan.verifications.filter((v) => v.version_id), runId },
    );
    return {
      investigations,
      uses_evidence: uses,
      safeguard_versions: versions,
      addresses,
      tests,
      agent_actions_labeled: agentActions,
    };
  });
}
