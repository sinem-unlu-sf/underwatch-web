// Writes managed-settings.json (and run-settings.json) for a policy JSON file. Used for container checks.
// usage: tsx scripts/render-settings.ts <policy.json|-> <outDir>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderClaudeSettings } from "../src/index";

const [policyPath, outDir] = process.argv.slice(2);
if (!policyPath || !outDir) {
  console.error("usage: tsx scripts/render-settings.ts <policy.json|-> <outDir>");
  process.exit(64);
}
const policy = policyPath === "-" ? { rules: [] } : JSON.parse(readFileSync(policyPath, "utf8"));
const r = renderClaudeSettings(policy);
if (!r.validation.managed.ok) throw new Error(r.validation.managed.errors.join("; "));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "managed-settings.json"), JSON.stringify(r.managed, null, 2) + "\n");
writeFileSync(join(outDir, "run-settings.json"), JSON.stringify(r.run, null, 2) + "\n");
console.log(JSON.stringify({ not_compiled: r.compilation.not_compiled, notes: r.notes }, null, 2));
