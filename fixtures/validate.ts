// Validates every fixtures/runs/*.json against FixtureRunFile plus cross-file invariants. Exits 1 on any failure.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureRunFile, type FixtureRunFile as FixtureRun } from "../packages/schema/src/index";

const runsDir = join(dirname(fileURLToPath(import.meta.url)), "runs");
const files = readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort();
const errors: string[] = [];
const runs: FixtureRun[] = [];

for (const file of files) {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(runsDir, file), "utf8"));
  } catch (e) {
    errors.push(`${file}: invalid JSON (${(e as Error).message})`);
    continue;
  }
  const r = FixtureRunFile.safeParse(json);
  if (!r.success) {
    for (const i of r.error.issues) errors.push(`${file}: ${i.path.join(".")}: ${i.message}`);
    continue;
  }
  const f = r.data;
  if (`${f.fixture_id}.json` !== file) errors.push(`${file}: file name must be <fixture_id>.json`);
  if (!f.label.startsWith("[fixture]") || !(f.run.label ?? "").startsWith("[fixture]")) errors.push(`${file}: labels must start with "[fixture]"`);
  for (const x of f.findings) {
    if (!x.description.startsWith("Hand-labeled fixture expectation")) errors.push(`${file}: finding ${x.id} description must say it is a hand-labeled expectation`);
  }
  runs.push(f);
}

// Records are upserted by id across files, so shared ids must carry identical content and other ids must be unique.
const policies = new Map<string, string>();
const seen = new Map<string, string>();
for (const f of runs) {
  const p = JSON.stringify(f.policy_version);
  const prev = policies.get(f.policy_version.id);
  if (prev !== undefined && prev !== p) errors.push(`${f.fixture_id}: policy_version ${f.policy_version.id} differs from another file`);
  policies.set(f.policy_version.id, p);
  const ids = [
    f.run.id,
    ...f.events.map((x) => x.id),
    ...f.evidence.map((x) => x.id),
    ...f.correlations.map((x) => x.id),
    ...f.findings.map((x) => x.id),
    ...f.finding_status_history.map((x) => x.id),
    ...f.safeguards.map((x) => x.id),
    ...f.verification_runs.map((x) => x.id),
  ];
  for (const id of ids) {
    const owner = seen.get(id);
    if (owner !== undefined) errors.push(`${f.fixture_id}: id ${id} also used in ${owner}`);
    seen.set(id, f.fixture_id);
  }
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(pad("fixture", 28) + pad("coverage", 10) + pad("events", 8) + pad("rep/obs/der", 13) + pad("evidence", 10) + pad("corr", 6) + pad("findings", 10) + "safeguards");
for (const f of runs) {
  const by = (b: string) => f.events.filter((e) => e.basis === b).length;
  console.log(
    pad(f.fixture_id, 28) +
      pad(f.coverage.level, 10) +
      pad(f.events.length, 8) +
      pad(`${by("reported")}/${by("observed")}/${by("derived")}`, 13) +
      pad(f.evidence.length, 10) +
      pad(f.correlations.length, 6) +
      pad(f.findings.length, 10) +
      f.safeguards.length,
  );
  for (const x of f.findings) console.log(`    ${x.id}  ${x.category}  severity=${x.severity} confidence=${x.confidence} status=${x.status}`);
}

if (errors.length > 0) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(`\nOK: ${runs.length} fixture file(s) valid.`);
