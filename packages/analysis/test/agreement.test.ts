import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Finding, FixtureRunFile, type Confidence, type FindingCategory, type Severity } from "@kw/schema";
import { analyzeRun } from "../src/index";
import { SCENARIOS } from "./scenarios";

/**
 * Agreement table: engine findings vs hand-labeled expected findings (category, severity, confidence).
 * Disagreements are REPORTED, not asserted away: the test fails only if the engine crashes or emits schema-invalid
 * findings. Fixtures are read-only (KW_FIXTURES_DIR, default <repo>/fixtures/runs).
 */
interface Label {
  category: FindingCategory;
  severity: Severity;
  confidence: Confidence;
  related?: string[];
}
interface Row {
  source: string;
  expected: string;
  engine: string;
  category: boolean;
  severity: boolean;
  confidence: boolean;
}

const fmt = (l: Label | undefined) => (l ? `${l.category}/${l.severity}/${l.confidence}` : "-");

function compare(source: string, expected: Label[], engine: Label[]): Row[] {
  const rows: Row[] = [];
  const used = new Set<number>();
  const score = (e: Label, g: Label) =>
    (e.category === g.category ? 100 : 0) + (e.related && g.related && e.related.some((id) => g.related!.includes(id)) ? 10 : 0) + (e.severity === g.severity ? 2 : 0) + (e.confidence === g.confidence ? 1 : 0);
  for (const e of expected) {
    let best = -1;
    let bestScore = -1;
    engine.forEach((g, i) => {
      if (used.has(i)) return;
      const s = score(e, g);
      if (s > bestScore && s >= 100) [best, bestScore] = [i, s];
    });
    const g = best >= 0 ? engine[best] : undefined;
    if (best >= 0) used.add(best);
    rows.push({ source, expected: fmt(e), engine: fmt(g), category: !!g, severity: !!g && g.severity === e.severity, confidence: !!g && g.confidence === e.confidence });
  }
  engine.forEach((g, i) => {
    if (!used.has(i)) rows.push({ source, expected: "-", engine: fmt(g), category: false, severity: false, confidence: false });
  });
  if (expected.length === 0 && engine.length === 0) rows.push({ source, expected: "(none)", engine: "(none)", category: true, severity: true, confidence: true });
  return rows;
}

function printTable(title: string, rows: Row[]): void {
  const yn = (b: boolean) => (b ? "yes" : "NO");
  const lines = [
    `\n### ${title}`,
    "| case | expected (category/severity/confidence) | engine | category | severity | confidence |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.source} | ${r.expected} | ${r.engine} | ${yn(r.category)} | ${r.expected === "-" ? "n/a" : yn(r.severity)} | ${r.expected === "-" ? "n/a" : yn(r.confidence)} |`),
  ];
  const exp = rows.filter((r) => r.expected !== "-" && r.expected !== "(none)");
  const eng = rows.filter((r) => r.engine !== "-" && r.engine !== "(none)");
  const tp = exp.filter((r) => r.category).length;
  lines.push(
    `\ncategory recall ${tp}/${exp.length}; category precision ${tp}/${eng.length}; severity agreement ${exp.filter((r) => r.severity).length}/${exp.length}; confidence agreement ${exp.filter((r) => r.confidence).length}/${exp.length}`,
  );
  console.log(lines.join("\n"));
}

describe("agreement table", () => {
  it("inline PRD section 11 scenarios", () => {
    const rows: Row[] = [];
    for (const s of SCENARIOS) {
      const r = analyzeRun(s.input);
      for (const f of r.findings) Finding.parse(f);
      rows.push(...compare(s.id, s.expected, r.findings));
    }
    printTable("Inline scenarios (labels written before first engine run)", rows);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("fixtures/runs/*.json (read-only)", () => {
    const dir = process.env.KW_FIXTURES_DIR ?? fileURLToPath(new URL("../../../fixtures/runs", import.meta.url));
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
    if (files.length === 0) {
      console.log(`\n### Fixtures: none found in ${dir} (agreement on fixtures not measured)`);
      return;
    }
    // Two passes: with the run's evidence records (full final-report text from the hook payload excerpt) and without
    // (engine sees only the event summary, which the fixtures cut off). Both are printed; neither is asserted.
    for (const withEvidence of [true, false]) {
    const rows: Row[] = [];
    for (const f of files) {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const parsed = FixtureRunFile.safeParse(raw);
      if (!parsed.success) {
        rows.push({ source: `${f} (schema-invalid: ${parsed.error.issues[0]?.message ?? "?"})`, expected: "?", engine: "not run", category: false, severity: false, confidence: false });
        continue;
      }
      const fx = parsed.data;
      const r = analyzeRun({ run: fx.run, events: fx.events, policy: fx.policy_version, coverage: fx.coverage, evidence: withEvidence ? fx.evidence : undefined });
      for (const x of r.findings) Finding.parse(x);
      rows.push(
        ...compare(
          fx.fixture_id,
          fx.findings.map((x) => ({ category: x.category, severity: x.severity, confidence: x.confidence, related: x.related_event_ids })),
          r.findings.map((x) => ({ category: x.category, severity: x.severity, confidence: x.confidence, related: x.related_event_ids })),
        ),
      );
    }
    printTable(`Fixtures in ${dir} (${withEvidence ? "with evidence excerpts" : "event summaries only"})`, rows);
    expect(rows.length).toBeGreaterThan(0);
    }
  });
});
