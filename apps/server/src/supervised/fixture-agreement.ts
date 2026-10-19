/**
 * Runs @kw/analysis over the hand-labeled fixture runs and compares its findings with the fixture's own (hand-written)
 * findings. Read-only: nothing is written to the database, so fixture findings are never overwritten. Used by
 * `pnpm seed:fixtures` (printed table) and recorded in docs/ASK-WITNESS.md section 6.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { analyzeRun } from "@kw/analysis";
import { FixtureRunFile, type Finding } from "@kw/schema";

export interface AgreementRow {
  fixture: string;
  expected: string;
  engine: string;
  category: boolean;
  severity: boolean | null;
  confidence: boolean | null;
}

export interface AgreementReport {
  rows: AgreementRow[];
  expected: number;
  engine: number;
  category_tp: number;
  severity_agree: number;
  confidence_agree: number;
  errors: string[];
}

const fmt = (f: Pick<Finding, "category" | "severity" | "confidence">) => `${f.category}/${f.severity}/${f.confidence}`;

export function fixtureAgreement(files: string[]): AgreementReport {
  const rows: AgreementRow[] = [];
  const errors: string[] = [];
  let expectedN = 0;
  let engineN = 0;
  for (const file of files) {
    const name = path.basename(file, ".json");
    const parsed = FixtureRunFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      errors.push(`${name}: schema-invalid (${parsed.error.issues[0]?.message ?? "?"})`);
      continue;
    }
    const fx = parsed.data;
    const r = analyzeRun({ run: fx.run, events: fx.events, policy: fx.policy_version, coverage: fx.coverage, evidence: fx.evidence });
    const exp = fx.findings;
    const eng = r.findings;
    expectedN += exp.length;
    engineN += eng.length;
    const used = new Set<number>();
    for (const e of exp) {
      let best = -1;
      let bestScore = -1;
      eng.forEach((g, i) => {
        if (used.has(i) || g.category !== e.category) return;
        const s = (g.related_event_ids.some((id) => e.related_event_ids.includes(id)) ? 10 : 0) + (g.severity === e.severity ? 2 : 0) + (g.confidence === e.confidence ? 1 : 0);
        if (s > bestScore) [best, bestScore] = [i, s];
      });
      const g = best >= 0 ? eng[best]! : null;
      if (g) used.add(best);
      rows.push({ fixture: fx.fixture_id, expected: fmt(e), engine: g ? fmt(g) : "-", category: !!g, severity: g ? g.severity === e.severity : false, confidence: g ? g.confidence === e.confidence : false });
    }
    eng.forEach((g, i) => {
      if (!used.has(i)) rows.push({ fixture: fx.fixture_id, expected: "-", engine: fmt(g), category: false, severity: null, confidence: null });
    });
    if (exp.length === 0 && eng.length === 0) rows.push({ fixture: fx.fixture_id, expected: "(none)", engine: "(none)", category: true, severity: null, confidence: null });
  }
  const labeled = rows.filter((r) => r.expected !== "-" && r.expected !== "(none)");
  return {
    rows,
    expected: expectedN,
    engine: engineN,
    category_tp: labeled.filter((r) => r.category).length,
    severity_agree: labeled.filter((r) => r.severity === true).length,
    confidence_agree: labeled.filter((r) => r.confidence === true).length,
    errors,
  };
}

export function formatAgreement(rep: AgreementReport): string {
  const yn = (b: boolean | null) => (b === null ? "n/a" : b ? "yes" : "NO");
  return [
    "| fixture | hand label (category/severity/confidence) | @kw/analysis | category | severity | confidence |",
    "|---|---|---|---|---|---|",
    ...rep.rows.map((r) => `| ${r.fixture} | ${r.expected} | ${r.engine} | ${yn(r.category)} | ${yn(r.severity)} | ${yn(r.confidence)} |`),
    "",
    `category recall ${rep.category_tp}/${rep.expected}; category precision ${rep.category_tp}/${rep.engine}; severity agreement ${rep.severity_agree}/${rep.expected}; confidence agreement ${rep.confidence_agree}/${rep.expected}`,
    ...rep.errors.map((e) => `error: ${e}`),
  ].join("\n");
}
