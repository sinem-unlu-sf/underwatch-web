import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("purity (no I/O, no clock, no randomness, no inference/graph dependency)", () => {
  it("src imports only @kw/schema, zod and local modules; no clock/random/env/network globals", () => {
    for (const f of files(SRC)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)) {
        expect(["@kw/schema", "zod"].includes(m[1]!) || m[1]!.startsWith("."), `${f} imports ${m[1]}`).toBe(true);
      }
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/\bDate\b|Math\.random|performance\.|process\.|fetch\(|setTimeout|require\(|import\(/);
    }
  });
});
