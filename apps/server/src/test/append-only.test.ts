/** Migration 097: events/evidence append-only; a finding is confirmed only by a user actor. */
import { afterEach, describe, expect, it } from "vitest";
import { persistRunBundle } from "../ingest/persist";
import { buildBundle } from "./bundle";
import { createTestApp, tableCount, type TestContext } from "./helpers";

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe("append-only observed records (migration 097)", () => {
  it("rejects UPDATE/DELETE on events and evidence; re-ingesting the same bundle stays idempotent", async () => {
    ctx = await createTestApp();
    const bundle = buildBundle("ao-live", false);
    persistRunBundle(ctx.db, bundle);
    const ev = tableCount(ctx.db, "events");
    const evd = tableCount(ctx.db, "evidence");
    expect(ev).toBeGreaterThan(0);
    expect(evd).toBeGreaterThan(0);
    expect(() => ctx!.db.prepare("UPDATE events SET summary = 'tampered'").run()).toThrow(/append-only/);
    expect(() => ctx!.db.prepare("DELETE FROM events").run()).toThrow(/append-only/);
    expect(() => ctx!.db.prepare("UPDATE evidence SET excerpt = 'tampered'").run()).toThrow(/append-only/);
    expect(() => ctx!.db.prepare("DELETE FROM evidence").run()).toThrow(/append-only/);
    persistRunBundle(ctx.db, bundle); // idempotent re-ingest: INSERT OR IGNORE, no UPDATE/DELETE
    expect(tableCount(ctx.db, "events")).toBe(ev);
    expect(tableCount(ctx.db, "evidence")).toBe(evd);
  });

  it("only a user actor can confirm a finding", async () => {
    ctx = await createTestApp();
    persistRunBundle(ctx.db, buildBundle("ao-confirm", false));
    const f = ctx.db.prepare("SELECT id FROM findings WHERE is_fixture = 0 AND status != 'confirmed' LIMIT 1").get() as { id: string };
    expect(f).toBeTruthy();
    const ins = (actor: string) =>
      ctx!.db
        .prepare("INSERT INTO finding_status_history (id, finding_id, is_fixture, from_status, to_status, actor_type, actor, note, at) VALUES (?, ?, 0, 'new', 'confirmed', ?, 'x', NULL, '2026-10-17T03:00:00Z')")
        .run(`fsc_ao_${actor}`, f.id, actor);
    expect(() => ins("system")).toThrow(/only a user actor/);
    // Without a user-actor history row, the status column cannot be flipped to confirmed directly.
    expect(() => ctx!.db.prepare("UPDATE findings SET status = 'confirmed' WHERE id = ?").run(f.id)).toThrow(/requires a user-actor/);
    ins("user");
    ctx.db.prepare("UPDATE findings SET status = 'confirmed' WHERE id = ?").run(f.id);
    expect((ctx.db.prepare("SELECT status FROM findings WHERE id = ?").get(f.id) as { status: string }).status).toBe("confirmed");
  });
});
