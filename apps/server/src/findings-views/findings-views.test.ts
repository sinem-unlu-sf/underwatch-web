import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FINDINGS_VIEWS_CONTRACT,
  findingsViewsPaths,
  taskContextKey,
  type DigestRefreshResponse,
  type DigestResponse,
  type DigestVersionsResponse,
  type FindingsSnapshotResponse,
  type RunFindingsResponse,
  type TasksResponse,
} from "@kw/schema";
import { importFixtureFile, listFixtureFiles } from "../ingest/fixtures";
import { persistRunBundle, type RunBundle } from "../ingest/persist";
import { buildBundle } from "../test/bundle";
import { createTestApp, getJson, postJson, tableCount, type TestContext } from "../test/helpers";
import { wasBlocked } from "./digest";

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function app(now?: Date): Promise<TestContext> {
  ctx = await createTestApp({}, now ? { now: () => now } : {});
  return ctx;
}

/** A synthetic live bundle whose run started at `startedAt` (findings keep their own timestamps). */
function bundleAt(slug: string, startedAt: string, overrides: Partial<RunBundle["run"]> = {}): RunBundle {
  const b = buildBundle(slug, false);
  b.run = { ...b.run, started_at: startedAt, ended_at: new Date(Date.parse(startedAt) + 60_000).toISOString(), ...overrides };
  return b;
}

const digestUrl = (date: string, tz: string, version?: number) =>
  `${findingsViewsPaths.digest(date)}?tz=${encodeURIComponent(tz)}${version ? `&version=${version}` : ""}`;
const refreshUrl = (date: string, tz: string) => `${findingsViewsPaths.digestRefresh(date)}?tz=${encodeURIComponent(tz)}`;

describe("daily digest", () => {
  it("assigns runs to days in the requested time zone (boundary around local midnight)", async () => {
    const c = await app();
    // 23:59:59 JST on Mar 1 and 00:00:00 JST on Mar 2; both are Mar 1 in UTC.
    persistRunBundle(c.db, bundleAt("late", "2026-03-01T14:59:59.000Z"));
    persistRunBundle(c.db, bundleAt("early", "2026-03-01T15:00:00.000Z"));

    const mar1Tokyo = await getJson<DigestResponse>(c.app, digestUrl("2026-03-01", "Asia/Tokyo"));
    expect(mar1Tokyo.status).toBe(200);
    expect(mar1Tokyo.body.snapshot.content.scope).toEqual({
      date: "2026-03-01",
      tz: "Asia/Tokyo",
      start: "2026-02-28T15:00:00.000Z",
      end: "2026-03-01T15:00:00.000Z",
    });
    expect(mar1Tokyo.body.snapshot.content.runs.map((r) => r.id)).toEqual(["run_live_late"]);
    expect(mar1Tokyo.body.snapshot.content.findings.map((f) => f.id).sort()).toEqual(["fnd_late_1", "fnd_late_2"]);

    const mar2Tokyo = await getJson<DigestResponse>(c.app, digestUrl("2026-03-02", "Asia/Tokyo"));
    expect(mar2Tokyo.body.snapshot.content.runs.map((r) => r.id)).toEqual(["run_live_early"]);

    const mar1Utc = await getJson<DigestResponse>(c.app, digestUrl("2026-03-01", "UTC"));
    expect(mar1Utc.body.snapshot.content.runs.map((r) => r.id)).toEqual(["run_live_late", "run_live_early"]);
    // Different tz => different scope key => separate snapshot history.
    expect(mar1Utc.body.snapshot.scope_key).toBe("2026-03-01@UTC");
    expect(mar1Tokyo.body.snapshot.scope_key).toBe("2026-03-01@Asia/Tokyo");
  });

  it("builds deterministic summaries and groups that reference finding and evidence ids", async () => {
    const c = await app();
    persistRunBundle(c.db, bundleAt("sum", "2026-03-01T10:00:00.000Z"));
    const { body } = await getJson<DigestResponse>(c.app, digestUrl("2026-03-01", "UTC"));
    const content = body.snapshot.content;
    expect(content.summary).toMatchObject({ total_findings: 2, total_runs: 1, needs_attention: ["fnd_sum_1"] });
    // fnd_sum_2 has confidence low and a linked reported event with outcome succeeded; fnd_sum_1 links an observed "attempted" event.
    expect(content.summary.uncertain).toEqual(["fnd_sum_2"]);
    expect(content.summary.blocked).toEqual([]);
    const f1 = content.findings.find((f) => f.id === "fnd_sum_1")!;
    expect(f1.evidence_ids).toEqual(["evd_sum_2"]);
    expect(f1.observed_outcomes).toEqual(["attempted"]);
    expect(f1.reported_outcomes).toEqual([]);
    const f2 = content.findings.find((f) => f.id === "fnd_sum_2")!;
    expect(f2.reported_outcomes).toEqual(["succeeded"]);
    expect(f2.observed_outcomes).toEqual(["attempted"]);

    const taskKey = taskContextKey(null, "Synthetic test task for sum");
    expect(content.groups_by_task).toEqual([
      { key: taskKey, kind: "task", label: "Synthetic test task for sum", finding_ids: ["fnd_sum_1", "fnd_sum_2"], run_ids: ["run_live_sum"], open_count: 1, max_severity: "high" },
    ]);
    expect(content.groups_by_category.map((g) => [g.key, g.finding_ids])).toEqual([
      ["unreported_observed_action", ["fnd_sum_1"]],
      ["outcome_mismatch", ["fnd_sum_2"]],
    ]);
    expect(content.contains_fixture_data).toBe(false);
    for (const g of [...content.groups_by_task, ...content.groups_by_category]) {
      for (const id of g.finding_ids) expect(content.findings.some((f) => f.id === id)).toBe(true);
    }
  });

  it("keeps a stored version stable, reports newer_available, and only refresh appends a version", async () => {
    const c = await app();
    persistRunBundle(c.db, bundleAt("a", "2026-03-01T10:00:00.000Z"));

    const first = await getJson<DigestResponse>(c.app, digestUrl("2026-03-01", "UTC"));
    expect(first.body).toMatchObject({ latest_version: 1, newer_available: false });
    expect(first.body.snapshot.version).toBe(1);
    expect(tableCount(c.db, "finding_snapshots")).toBe(1);

    const again = await getJson<DigestResponse>(c.app, digestUrl("2026-03-01", "UTC"));
    expect(again.body.snapshot).toEqual(first.body.snapshot);
    expect(tableCount(c.db, "finding_snapshots")).toBe(1);

    // A new finding arrives for the same day: the stored version does not change, but the response says so.
    persistRunBundle(c.db, bundleAt("b", "2026-03-01T12:00:00.000Z"));
    const stale = await getJson<DigestResponse>(c.app, digestUrl("2026-03-01", "UTC"));
    expect(stale.body.snapshot.id).toBe(first.body.snapshot.id);
    expect(stale.body.snapshot.content.findings).toHaveLength(2);
    expect(stale.body.newer_available).toBe(true);
    expect(stale.body.changes.new_finding_ids.sort()).toEqual(["fnd_b_1", "fnd_b_2"]);
    expect(tableCount(c.db, "finding_snapshots")).toBe(1);

    const refreshed = await postJson<DigestRefreshResponse>(c.app, refreshUrl("2026-03-01", "UTC"), {});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({ created: true, latest_version: 2, newer_available: false });
    expect(refreshed.body.snapshot.version).toBe(2);
    expect(refreshed.body.snapshot.content.findings.map((f) => f.id).sort()).toEqual(["fnd_a_1", "fnd_a_2", "fnd_b_1", "fnd_b_2"]);

    const unchanged = await postJson<DigestRefreshResponse>(c.app, refreshUrl("2026-03-01", "UTC"), {});
    expect(unchanged.body).toMatchObject({ created: false, latest_version: 2 });
    expect(tableCount(c.db, "finding_snapshots")).toBe(2);

    // Older versions stay readable; asking for a version never creates one.
    const v1 = await getJson<DigestResponse>(c.app, digestUrl("2026-03-01", "UTC", 1));
    expect(v1.body.snapshot.id).toBe(first.body.snapshot.id);
    expect(v1.body).toMatchObject({ latest_version: 2, newer_available: true });
    expect((await getJson(c.app, digestUrl("2026-03-01", "UTC", 9))).status).toBe(404);
    expect((await getJson(c.app, digestUrl("2026-03-02", "UTC", 1))).status).toBe(404);
    expect(tableCount(c.db, "finding_snapshots")).toBe(2);

    const versions = await getJson<DigestVersionsResponse>(c.app, `${findingsViewsPaths.digestVersions("2026-03-01")}?tz=UTC`);
    expect(versions.body.scope_key).toBe("2026-03-01@UTC");
    expect(versions.body.items.map((i) => [i.version, i.total_findings])).toEqual([
      [2, 4],
      [1, 2],
    ]);

    // Stored snapshots are append-only at the database level.
    expect(() => c.db.exec("DELETE FROM finding_snapshots")).toThrow(/append-only/);
    expect(() => c.db.exec("UPDATE finding_snapshots SET version = 7")).toThrow(/append-only/);
  });

  it("reports a user's status change as an update without rewriting the stored version", async () => {
    const c = await app();
    persistRunBundle(c.db, bundleAt("st", "2026-03-01T10:00:00.000Z"));
    const first = await getJson<DigestResponse>(c.app, digestUrl("2026-03-01", "UTC"));
    const changed = await postJson(c.app, "/api/findings/fnd_st_1/status", { to: "under_review" });
    expect(changed.status).toBe(200);
    const after = await getJson<DigestResponse>(c.app, digestUrl("2026-03-01", "UTC"));
    expect(after.body.snapshot.content_hash).toBe(first.body.snapshot.content_hash);
    expect(after.body.snapshot.content.findings.find((f) => f.id === "fnd_st_1")!.status).toBe("new");
    expect(after.body.newer_available).toBe(true);
    expect(after.body.changes).toEqual({ new_finding_ids: [], updated_finding_ids: ["fnd_st_1"], removed_finding_ids: [] });
  });

  it("shows completeness caveats instead of implying nothing happened", async () => {
    const c = await app(new Date("2026-03-01T18:00:00.000Z"));
    const errored = bundleAt("cov", "2026-03-01T10:00:00.000Z", { status: "running", ended_at: null });
    errored.coverage = { ...errored.coverage, sources: errored.coverage.sources.map((s) => ({ ...s, errors: ["inotify watch limit reached"] })) };
    persistRunBundle(c.db, errored);

    const { body } = await getJson<DigestResponse>(c.app, digestUrl("2026-03-01", "UTC"));
    const comp = body.snapshot.content.completeness;
    expect(comp.status).toBe("has_gaps");
    expect(comp.caveats.map((x) => x.kind).sort()).toEqual(["collector_errors", "coverage_partial", "day_in_progress", "run_in_progress"]);
    expect(comp.caveats.find((x) => x.kind === "collector_errors")!.detail).toContain("inotify watch limit reached");
    expect(body.snapshot.content.summary.coverage_gaps).toEqual(comp.caveats);

    // A day with no runs is "no_runs", never "complete"; a run without a coverage report is "coverage_unknown".
    const empty = await getJson<DigestResponse>(c.app, digestUrl("2026-02-01", "UTC"));
    expect(empty.body.snapshot.content.completeness).toEqual({ status: "no_runs", caveats: [] });
    c.db.prepare("DELETE FROM coverage_reports WHERE run_id = 'run_live_cov'").run();
    const unknown = await getJson<DigestResponse>(c.app, digestUrl("2026-03-01", "UTC"));
    expect(unknown.body.changes.updated_finding_ids).toEqual([]);
    expect(unknown.body.newer_available).toBe(true); // caveats changed even though no finding did
    const refreshed = await postJson<DigestRefreshResponse>(c.app, refreshUrl("2026-03-01", "UTC"), {});
    expect(refreshed.body.snapshot.content.completeness.caveats.map((x) => x.kind).sort()).toEqual([
      "coverage_unknown",
      "day_in_progress",
      "run_in_progress",
    ]);
  });

  it("rejects bad dates and time zones with 400", async () => {
    const c = await app();
    expect((await getJson(c.app, digestUrl("2026-02-30", "UTC"))).status).toBe(400);
    expect((await getJson(c.app, digestUrl("2026-03-01", "Mars/Olympus"))).status).toBe(400);
    expect((await postJson(c.app, refreshUrl("2026-13-01", "UTC"), {})).status).toBe(400);
    expect((await getJson(c.app, `${findingsViewsPaths.digestVersions("2026-03-01")}?tz=Not/AZone`)).status).toBe(400);
    expect(tableCount(c.db, "finding_snapshots")).toBe(0);
  });
});

describe("current state snapshot", () => {
  it("is read-only and its id changes if and only if findings change", async () => {
    const c = await app();
    const fx = buildBundle("fx-cur", true);
    persistRunBundle(c.db, fx);
    const a = await getJson<FindingsSnapshotResponse>(c.app, findingsViewsPaths.findingsSnapshot());
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ total: 2, truncated: false });
    expect(a.body.findings.every((f) => f.is_fixture)).toBe(true);
    expect(a.body.data_mode.contains_fixture_data).toBe(true);
    expect(a.body.findings.map((f) => f.severity)).toEqual(["high", "medium"]);

    const b = await getJson<FindingsSnapshotResponse>(c.app, findingsViewsPaths.findingsSnapshot());
    expect(b.body.snapshot_id).toBe(a.body.snapshot_id);
    expect(tableCount(c.db, "finding_snapshots")).toBe(0);

    await postJson(c.app, `/api/findings/${fx.findings[0]!.id}/status`, { to: "under_review" });
    const afterStatus = await getJson<FindingsSnapshotResponse>(c.app, findingsViewsPaths.findingsSnapshot());
    expect(afterStatus.body.snapshot_id).not.toBe(a.body.snapshot_id);

    persistRunBundle(c.db, bundleAt("cur-live", "2026-03-02T10:00:00.000Z"));
    const afterNew = await getJson<FindingsSnapshotResponse>(c.app, findingsViewsPaths.findingsSnapshot());
    expect(afterNew.body.snapshot_id).not.toBe(afterStatus.body.snapshot_id);
    expect(afterNew.body.total).toBe(4);
    expect(afterNew.body.findings.filter((f) => !f.is_fixture)).toHaveLength(2);
    expect(afterNew.body.completeness.caveats.some((x) => x.kind === "coverage_partial")).toBe(true);
  });
});

describe("task contexts", () => {
  it("groups runs by task and the task's run lists only that run's findings", async () => {
    const c = await app();
    const shared = { task_description: "Fix the login bug", repository_id: "repo-1" };
    persistRunBundle(c.db, bundleAt("t1", "2026-03-01T10:00:00.000Z", shared));
    persistRunBundle(c.db, bundleAt("t2", "2026-03-02T10:00:00.000Z", shared));
    persistRunBundle(c.db, bundleAt("other", "2026-03-03T10:00:00.000Z"));

    const { status, body } = await getJson<TasksResponse>(c.app, findingsViewsPaths.tasks());
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    const login = body.items.find((t) => t.key === taskContextKey("repo-1", "Fix the login bug"))!;
    expect(login.runs.map((r) => r.id)).toEqual(["run_live_t2", "run_live_t1"]);
    expect(login).toMatchObject({ finding_count: 4, open_finding_count: 2, max_open_severity: "high", contains_fixture_data: false });
    // Most recent activity first.
    expect(body.items[0]!.task_description).toBe("Synthetic test task for other");

    const filtered = await getJson<TasksResponse>(c.app, `${findingsViewsPaths.tasks()}?q=LOGIN`);
    expect(filtered.body.items.map((t) => t.key)).toEqual([login.key]);
    expect((await getJson<TasksResponse>(c.app, `${findingsViewsPaths.tasks()}?fixture=only`)).body.items).toEqual([]);

    const runFindings = await getJson<RunFindingsResponse>(c.app, "/api/runs/run_live_t1/findings");
    expect(runFindings.body.items.map((f) => f.id).sort()).toEqual(["fnd_t1_1", "fnd_t1_2"]);
  });
});

describe("blocked bucket", () => {
  it("counts prevented attempts only when the evidence does not show a success; observed beats reported", () => {
    expect(wasBlocked({ reported_outcomes: ["succeeded"], observed_outcomes: ["denied"] })).toBe(true);
    expect(wasBlocked({ reported_outcomes: ["attempted", "denied"], observed_outcomes: [] })).toBe(true);
    expect(wasBlocked({ reported_outcomes: ["denied"], observed_outcomes: ["succeeded"] })).toBe(false);
    expect(wasBlocked({ reported_outcomes: ["denied", "succeeded"], observed_outcomes: [] })).toBe(false);
    expect(wasBlocked({ reported_outcomes: [], observed_outcomes: ["denied", "succeeded"] })).toBe(false);
    expect(wasBlocked({ reported_outcomes: [], observed_outcomes: [] })).toBe(false);
  });
});

describe("real labeled fixtures", () => {
  it("serves every view over fixtures/runs within the contract, labeled as fixture data", async () => {
    const c = await app(new Date("2026-10-17T03:00:00.000Z"));
    const dir = path.resolve(import.meta.dirname, "../../../../fixtures/runs");
    for (const file of listFixtureFiles(dir)) expect(importFixtureFile(c.db, file).ok, file).toBe(true);

    const snap = await getJson<FindingsSnapshotResponse>(c.app, findingsViewsPaths.findingsSnapshot());
    expect(snap.status).toBe(200);
    expect(snap.body.total).toBeGreaterThan(0);
    expect(snap.body.findings.every((f) => f.is_fixture)).toBe(true);

    const tasks = await getJson<TasksResponse>(c.app, findingsViewsPaths.tasks());
    expect(tasks.status).toBe(200);
    expect(tasks.body.items.every((t) => t.contains_fixture_data)).toBe(true);

    // fx-04 starts 2026-10-17T10:00Z = 19:00 JST on Oct 17; "now" is 12:00 JST, so the day is still in progress.
    const today = await getJson<DigestResponse>(c.app, digestUrl("2026-10-17", "Asia/Tokyo"));
    expect(today.status).toBe(200);
    expect(today.body.snapshot.content.contains_fixture_data).toBe(true);
    expect(today.body.snapshot.content.completeness.caveats.some((x) => x.kind === "day_in_progress")).toBe(true);
    expect(today.body.snapshot.content.runs.length).toBeGreaterThan(0);

    // Denied vs succeeded stay distinct in the summary: fx-03 (attempt blocked, nothing succeeded) is "blocked"; fx-04's
    // env read was denied once but then observed succeeding via bash, so it is NOT counted as blocked.
    const s = today.body.snapshot.content.summary;
    expect(s.blocked).toContain("fnd_fx03_env_read_blocked");
    expect(s.blocked).not.toContain("fnd_fx04_env_read_via_bash");
    expect(s.needs_attention).toContain("fnd_fx04_env_read_via_bash");
  });
});

describe("auth and separation from collection", () => {
  it("rejects unauthenticated requests on every findings-views route", async () => {
    const c = await app();
    const host = { host: "127.0.0.1:4600" };
    const urls: [string, string][] = [
      ["GET", findingsViewsPaths.findingsSnapshot()],
      ["GET", findingsViewsPaths.tasks()],
      ["GET", digestUrl("2026-03-01", "UTC")],
      ["GET", `${findingsViewsPaths.digestVersions("2026-03-01")}?tz=UTC`],
    ];
    for (const [method, url] of urls) {
      const r = await c.rawInject({ method: method as "GET", url, headers: host });
      expect(r.statusCode, url).toBe(401);
    }
    const post = await c.rawInject({ method: "POST", url: refreshUrl("2026-03-01", "UTC"), headers: { ...host, "x-kw-client": "web" } });
    expect([401, 403]).toContain(post.statusCode);
    // Authenticated, but without the client header: refused as a cross-site request.
    const noClient = await c.rawInject({ method: "POST", url: refreshUrl("2026-03-01", "UTC"), headers: { ...host, authorization: `Bearer ${c.token}` } });
    expect(noClient.statusCode).toBe(403);
    expect(tableCount(c.db, "finding_snapshots")).toBe(0);
  });

  it("has no server-side mode: no route takes a mode parameter", () => {
    for (const [name, endpoint] of Object.entries(FINDINGS_VIEWS_CONTRACT)) {
      const query = "query" in endpoint ? endpoint.query : undefined;
      const keys = query && "shape" in query ? Object.keys((query as unknown as { shape: object }).shape) : [];
      expect(keys, name).not.toContain("mode");
    }
  });

  it("no ingestion, finding-generation or collection code reads presentation-mode state", () => {
    const repo = path.resolve(import.meta.dirname, "../../../..");
    const forbidden = [/finding_snapshots/, /findings-views/, /FindingsViewMode/, /FINDINGS_VIEW_MODE/, /kw\.findings\.mode/, /registerFindingsViewsRoutes/];
    const allowed = (rel: string) =>
      rel.startsWith("apps/server/src/findings-views/") ||
      rel === "apps/server/src/app.ts" || // registers the read routes only
      rel.startsWith("packages/schema/src/findings-views") ||
      rel === "packages/schema/src/index.ts" ||
      /\.test\.tsx?$/.test(rel);
    const roots = ["apps/server/src", ...readdirSync(path.join(repo, "packages")).map((p) => `packages/${p}/src`)];
    const offenders: string[] = [];
    let scanned = 0;
    const walk = (rel: string) => {
      const abs = path.join(repo, rel);
      let st;
      try {
        st = statSync(abs);
      } catch {
        return;
      }
      if (st.isDirectory()) {
        if (rel.endsWith("node_modules")) return;
        for (const e of readdirSync(abs)) walk(`${rel}/${e}`);
        return;
      }
      if (!/\.(ts|tsx|js|mjs)$/.test(rel) || allowed(rel)) return;
      scanned++;
      const text = readFileSync(abs, "utf8");
      if (forbidden.some((re) => re.test(text))) offenders.push(rel);
    };
    roots.forEach(walk);
    expect(scanned).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });

  it("ingestion behaves the same whether or not snapshots exist, and never writes them", async () => {
    const c = await app();
    persistRunBundle(c.db, bundleAt("pre", "2026-03-01T10:00:00.000Z"));
    await getJson(c.app, digestUrl("2026-03-01", "UTC"));
    await postJson(c.app, refreshUrl("2026-03-01", "UTC"), {});
    const before = tableCount(c.db, "finding_snapshots");
    const result = persistRunBundle(c.db, bundleAt("post", "2026-03-01T11:00:00.000Z"));
    expect(result.counts.findings).toEqual({ inserted: 2, skipped: 0 });
    expect(result.counts.events).toEqual({ inserted: 4, skipped: 0 });
    expect(result.conflicts).toEqual([]);
    expect(tableCount(c.db, "finding_snapshots")).toBe(before);
  });
});
