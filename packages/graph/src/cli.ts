/**
 * Small operator CLI (dev only):
 *   pnpm --filter @kw/graph graph health
 *   pnpm --filter @kw/graph graph constraints
 *   pnpm --filter @kw/graph graph project <bundle.json | dir-of-bundles> [...]
 *   pnpm --filter @kw/graph graph delete <run_id> [...]
 * Prints statuses and counts only (never credentials). Exit code 1 on any failure.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KwGraph } from "./index";

const [cmd, ...args] = process.argv.slice(2);
const g = new KwGraph();
let failed = false;
const out = (x: unknown) => console.log(JSON.stringify(x, null, 2));

try {
  switch (cmd) {
    case "health": {
      const h = await g.health();
      out(h);
      failed = !h.ok;
      break;
    }
    case "constraints": {
      const r = await g.ensureConstraints();
      out(r);
      failed = !r.ok;
      break;
    }
    case "project": {
      const c = await g.ensureConstraints();
      if (!c.ok) {
        out(c);
        failed = true;
        break;
      }
      const files = args.flatMap((a) =>
        statSync(a).isDirectory() ? readdirSync(a).filter((f) => f.endsWith(".json")).sort().map((f) => join(a, f)) : [a],
      );
      for (const f of files) {
        const r = await g.projectRunBundle(JSON.parse(readFileSync(f, "utf8")));
        if (r.ok) console.log(`${f}: run=${r.value.run_id} nodes=${r.value.nodes} rels=${r.value.relationships} dangling=${r.value.dangling.length}`);
        else {
          console.log(`${f}: FAILED ${r.error.kind}: ${r.error.message}`);
          failed = true;
        }
      }
      break;
    }
    case "delete": {
      for (const id of args) {
        const r = await g.deleteRun(id);
        out({ run_id: id, ...r });
        failed ||= !r.ok;
      }
      break;
    }
    default:
      console.log("usage: graph health | constraints | project <file|dir>... | delete <run_id>...");
      failed = true;
  }
} finally {
  await g.close();
}
process.exitCode = failed ? 1 : 0;
