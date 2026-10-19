// Regenerates fixtures/runs/*.json from the scenario scripts. Run: pnpm fixtures:generate (see fixtures/README.md).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixtureRunFile } from "../packages/schema/src/index";
import { fx01 } from "./scenarios/fx-01";
import { fx02 } from "./scenarios/fx-02";
import { fx03 } from "./scenarios/fx-03";
import { fx04 } from "./scenarios/fx-04";
import { fx05 } from "./scenarios/fx-05";

const runsDir = join(dirname(fileURLToPath(import.meta.url)), "runs");
mkdirSync(runsDir, { recursive: true });

const written = new Set<string>();
for (const build of [fx01, fx02, fx03, fx04, fx05]) {
  const input = build();
  const parsed = FixtureRunFile.safeParse(input);
  if (!parsed.success) {
    console.error(`${input.fixture_id}: generated fixture is invalid`);
    for (const i of parsed.error.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
    process.exit(1);
  }
  const file = `${parsed.data.fixture_id}.json`;
  writeFileSync(join(runsDir, file), JSON.stringify(parsed.data, null, 2) + "\n");
  written.add(file);
  console.log(`wrote runs/${file}`);
}

// Drop generated files whose scenario no longer exists.
for (const f of readdirSync(runsDir)) {
  if (f.endsWith(".json") && !written.has(f)) {
    rmSync(join(runsDir, f));
    console.log(`removed stale runs/${f}`);
  }
}
