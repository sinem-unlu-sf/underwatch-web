import { describe, expect, it } from "vitest";
import {
  DigestDate,
  DigestQuery,
  FINDINGS_VIEWS_CONTRACT,
  FINDINGS_VIEWS_ROUTES,
  canonicalJson,
  contentHash,
  diffSnapshotFindings,
  digestScopeKey,
  findingsViewsPaths,
  hasSnapshotChanges,
  taskContextKey,
  zonedDate,
  zonedDayBounds,
} from "./index";

describe("findings views: time zones", () => {
  it("computes [start, end) of a day in a fixed-offset zone", () => {
    expect(zonedDayBounds("2026-10-17", "Asia/Tokyo")).toEqual({ start: "2026-10-16T15:00:00.000Z", end: "2026-10-17T15:00:00.000Z" });
    expect(zonedDayBounds("2026-10-17", "UTC")).toEqual({ start: "2026-10-17T00:00:00.000Z", end: "2026-10-18T00:00:00.000Z" });
  });
  it("handles a DST day (23 hours)", () => {
    const { start, end } = zonedDayBounds("2026-03-08", "America/New_York");
    expect(start).toBe("2026-03-08T05:00:00.000Z");
    expect(end).toBe("2026-03-09T04:00:00.000Z");
  });
  it("maps an instant to its local date", () => {
    expect(zonedDate(new Date("2026-10-16T16:00:00Z"), "Asia/Tokyo")).toBe("2026-10-17");
    expect(zonedDate(new Date("2026-10-16T16:00:00Z"), "UTC")).toBe("2026-10-16");
  });
  it("validates dates and time zones", () => {
    expect(DigestDate.safeParse("2026-02-30").success).toBe(false);
    expect(DigestDate.safeParse("2026-10-17").success).toBe(true);
    expect(DigestQuery.parse({}).tz).toBe("UTC");
    expect(DigestQuery.safeParse({ tz: "Not/AZone" }).success).toBe(false);
    expect(DigestQuery.parse({ tz: "Asia/Tokyo", version: "2" })).toEqual({ tz: "Asia/Tokyo", version: 2 });
    expect(digestScopeKey("2026-10-17", "Asia/Tokyo")).toBe("2026-10-17@Asia/Tokyo");
  });
});

describe("findings views: hashing and diffs", () => {
  it("hashes independent of key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
  it("reports new, updated and removed findings", () => {
    const prev = [{ id: "fnd_a", status: "new" }, { id: "fnd_b", status: "new" }, { id: "fnd_c", status: "new" }];
    const next = [{ id: "fnd_a", status: "new" }, { id: "fnd_b", status: "confirmed" }, { id: "fnd_d", status: "new" }];
    const changes = diffSnapshotFindings(prev, next);
    expect(changes).toEqual({ new_finding_ids: ["fnd_d"], updated_finding_ids: ["fnd_b"], removed_finding_ids: ["fnd_c"] });
    expect(hasSnapshotChanges(changes)).toBe(true);
    expect(hasSnapshotChanges(diffSnapshotFindings(prev, prev))).toBe(false);
  });
  it("derives stable task keys", () => {
    const k = taskContextKey("fixture/demo-repo", "Fix the bug.");
    expect(k).toMatch(/^tsk_[0-9a-f]{24}$/);
    expect(taskContextKey("fixture/demo-repo", "  Fix the bug. ")).toBe(k);
    expect(taskContextKey(null, "Fix the bug.")).not.toBe(k);
  });
});

describe("findings views: contract", () => {
  it("has one contract entry per route with matching paths", () => {
    for (const key of Object.keys(FINDINGS_VIEWS_ROUTES) as (keyof typeof FINDINGS_VIEWS_ROUTES)[]) {
      expect(FINDINGS_VIEWS_CONTRACT[key].path).toBe(FINDINGS_VIEWS_ROUTES[key]);
    }
    expect(findingsViewsPaths.digest("2026-10-17")).toBe("/api/digests/2026-10-17");
  });
});
