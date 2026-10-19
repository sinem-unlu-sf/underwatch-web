/**
 * Live verification driver (REAL Docker + REAL Claude Code run; no mocks). Runs in its own process so dev-server
 * hot reloads cannot interrupt a harness run. Writes to the configured database (default data/kw.db), so results show
 * up in the app.
 *
 *   pnpm --filter @kw/server exec tsx src/verification/live.ts [finding_id] [permission_rule|claude_md_instruction ...]
 *
 * Proposes (template author; ai& is not used here) safeguards for the finding on the demo workspace via the
 * SafeguardService, then starts one verification per requested type and waits for it. Prints outcomes only (no
 * secrets, no canary values).
 */
import { randomUUID } from "node:crypto";
import { buildApp } from "../app";
import { resolveDbLocation } from "../config";
import { openDatabase } from "../db/connection";

const findingId = process.argv[2] ?? "fnd_fx04_env_read_via_bash";
const types = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ["permission_rule", "claude_md_instruction"];

const dbLocation = resolveDbLocation();
const db = openDatabase(dbLocation.path);
const app = await buildApp({ db, dbLocation, logger: false });
const s = app.kw.services;

try {
  const harness = await s.verification.harnessStatus();
  console.log("harness:", JSON.stringify(harness.checks.map((c) => ({ id: c.id, ok: c.ok }))));
  let demo = (await s.workspaces.listWorkspaces()).find((w) => w.kind === "demo" && w.status === "active");
  if (!demo) demo = (await s.workspaces.createDemoWorkspace()).workspace;
  console.log("workspace:", demo.id, demo.kind);

  const proposal = await s.safeguards.propose(findingId, { client_request_id: `live-${randomUUID()}`, workspace_id: demo.id }, "verification-live-script");
  console.log("proposal author:", proposal.generation.author, "items:", proposal.items.map((i) => `${i.safeguard.type}:${i.safeguard.id}`).join(", "));

  const started = [];
  for (const type of types) {
    const item = proposal.items.find((i) => i.safeguard.type === type && i.current_version);
    if (!item) {
      console.log(`no ${type} safeguard in the proposal; skipped`);
      continue;
    }
    const res = await s.verification.startRun(item.safeguard.id, { client_request_id: `live-${randomUUID()}` }, "verification-live-script");
    console.log(`started ${type}: run ${res.run.id} (safeguard ${item.safeguard.id}, version ${res.run.version_id})`);
    started.push({ type, runId: res.run.id });
  }
  // Runs execute concurrently (resources are suffixed with the run id).
  await Promise.all(started.map((r) => (s.verification as unknown as { _wait(id: string): Promise<void> })._wait(r.runId)));
  for (const r of started) {
    const { run } = await s.verification.getRun(r.runId);
    console.log(
      `\n=== ${r.type} ${run.id}: ${run.verification_status} (${run.result}) ===\n` +
        JSON.stringify(
          { environment: run.environment, cases: run.cases, limitations: run.limitations, artifacts: run.artifacts.map((a) => `${a.kind}:${a.blob_sha256.slice(0, 12)} ${a.size_bytes}B ${a.label}`), notes: run.notes },
          null,
          2,
        ),
    );
  }
} finally {
  await app.close();
  db.close();
}
