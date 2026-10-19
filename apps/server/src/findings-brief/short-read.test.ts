import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FindingDetailResponse,
  FindingBriefResponse,
  SHORT_READ_MAX_WORDS,
  ShortRead,
  apiPaths,
  shortReadWordCount,
} from "@kw/schema";
import { importFixture, importFixtureFile, listFixtureFiles } from "../ingest/fixtures";
import { persistRunBundle } from "../ingest/persist";
import { buildBundle, buildFixtureFile } from "../test/bundle";
import { CANARY } from "../test/canaries";
import { createTestApp, getJson, type TestContext } from "../test/helpers";

const LIVE_FINDING = "fnd_live_brief_1";
const FX_FINDING = "fnd_fx_brief_1";
const LIVE_VER = "ver_live_brief_1";
const LIVE_SG = "sg_live_brief_1";
const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/runs");

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestApp();
  const imported = importFixture(ctx.db, buildFixtureFile("fx-short"));
  if (!imported.ok) throw new Error(imported.errors.join("\n"));
  persistRunBundle(ctx.db, buildBundle("live-brief", false));
});
afterEach(() => ctx.close());

async function shortRead(id: string): Promise<ShortRead> {
  const res = await getJson<FindingDetailResponse>(ctx.app, apiPaths.finding(id));
  expect(res.status).toBe(200);
  const d = FindingDetailResponse.parse(res.body);
  expect(d.short_read).toBeDefined();
  return ShortRead.parse(d.short_read);
}

function checkShape(s: ShortRead) {
  expect(s.deterministic).toBe(true);
  expect(s.word_count).toBe(shortReadWordCount(s));
  expect(s.word_count).toBeLessThanOrEqual(SHORT_READ_MAX_WORDS);
  expect(s.finding.endsWith(".")).toBe(true);
  expect(s.finding).not.toMatch(/\n/);
  expect(s.why).not.toMatch(/\n/);
  expect(s.fix).not.toMatch(/\n/);
  expect(s.numbers.length).toBeGreaterThanOrEqual(2);
  expect(s.numbers.length).toBeLessThanOrEqual(5);
  for (const x of s.numbers) expect(x.text).toMatch(/\d/);
  // No "done" claims; verified always carries the tested-scenario qualifier.
  expect(`${s.fix} ${s.numbers.map((x) => x.text).join(" ")}`).not.toMatch(/\b(done|fixed|resolved|secure)\b/i);
  if (/verified/i.test(s.fix)) expect(s.fix).toMatch(/tested scenario/);
}

describe("short read", () => {
  it("is served on GET /api/findings/:id and /brief, identical, with counts from the same records", async () => {
    const s = await shortRead(LIVE_FINDING);
    checkShape(s);
    const b = await getJson<FindingBriefResponse>(ctx.app, apiPaths.findingBrief(LIVE_FINDING));
    expect(b.status).toBe(200);
    expect(FindingBriefResponse.parse(b.body).short_read).toEqual(s);

    const d = (await getJson<FindingDetailResponse>(ctx.app, apiPaths.finding(LIVE_FINDING))).body;
    expect(s.finding_id).toBe(LIVE_FINDING);
    expect(s.finding).toContain(".env");
    expect(s.is_fixture).toBe(false);
    expect(s.finding).not.toMatch(/fixture/);
    expect(s.generated_from.event_ids).toEqual(d.related_events.map((e) => e.id));
    for (const x of s.numbers) for (const id of x.evidence_ids) expect([...s.generated_from.event_ids, d.run.id, ...s.generated_from.verification_run_ids]).toContain(id);
    const runCount = (ctx.db.prepare("SELECT COUNT(*) AS n FROM findings WHERE run_id = ?").get(d.run.id) as { n: number }).n;
    expect(s.numbers.map((x) => x.text)).toContain(`${runCount} ${runCount === 1 ? "finding" : "findings"} in this run`);
    // Fix status mirrors the brief's action statuses (stored rows), never a stronger claim.
    expect(d.brief?.how_to_fix.map((a) => a.status)).toContain(s.fix_status);
    expect(s.fix_status).not.toBe("verified_for_tested_scenario");
  });

  it("follows the stored verification result and keeps the tested-scenario qualifier", async () => {
    ctx.db.prepare("UPDATE findings SET category = 'permission_violation' WHERE id = ?").run(LIVE_FINDING);
    ctx.db.prepare("UPDATE verification_runs SET result = 'failed_verification' WHERE id = ?").run(LIVE_VER);
    ctx.db.prepare("UPDATE safeguards SET verification_status = 'failed_verification' WHERE id = ?").run(LIVE_SG);
    const s = await shortRead(LIVE_FINDING);
    checkShape(s);
    expect(s.fix_status).toBe("failed_verification");
    expect(s.fix).toMatch(/verification failed/);
    expect(s.fix_verification_run_id).toBe(LIVE_VER);
  });

  it("marks fixture findings as hand-labeled", async () => {
    const s = await shortRead(FX_FINDING.replace("brief", "short"));
    checkShape(s);
    expect(s.is_fixture).toBe(true);
    expect(s.finding).toMatch(/\(hand-labeled fixture\)\.$/);
  });

  it("stays within 150 words for every repository fixture finding", async () => {
    const files = listFixtureFiles(FIXTURE_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const out = importFixtureFile(ctx.db, f);
      if (!out.ok) throw new Error(out.errors.join("\n"));
    }
    const ids = (ctx.db.prepare("SELECT id FROM findings").all() as { id: string }[]).map((r) => r.id);
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) {
      const s = await shortRead(id);
      checkShape(s);
    }
  });

  it("enforces the limit even with very long stored strings, and redacts secrets", async () => {
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    ctx.db.prepare("UPDATE findings SET title = ?, category = 'outcome_mismatch' WHERE id = ?").run(`${long} ${CANARY.openai}`, LIVE_FINDING);
    ctx.db.prepare("UPDATE runs SET task_description = ? WHERE id = (SELECT run_id FROM findings WHERE id = ?)").run(`${long} ${CANARY.anthropic}`, LIVE_FINDING);
    const s = await shortRead(LIVE_FINDING);
    checkShape(s);
    expect(JSON.stringify(s)).not.toContain("KWCANARY");
  });
});
