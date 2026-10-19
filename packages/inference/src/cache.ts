import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./bundle";

/**
 * Cache key = sha256(bundle hash + prompt_version + model [+ variant]). The prompt version already encodes the task and
 * schema. `variant` carries generation parameters that change the answer (the provider passes the reasoning effort), so
 * changing AIAND_REASONING_EFFORT never serves a result produced at a different effort.
 */
export function inferenceCacheKey(bundleSha256: string, promptVersion: string, model: string, variant?: string): string {
  return sha256((variant === undefined ? [bundleSha256, promptVersion, model] : [bundleSha256, promptVersion, model, variant]).join("\u001f"));
}

export interface InferenceCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export class MemoryCache implements InferenceCache {
  readonly #m = new Map<string, unknown>();
  constructor(private readonly maxEntries = 500) {}
  async get(key: string) {
    return this.#m.get(key);
  }
  async set(key: string, value: unknown) {
    if (this.#m.size >= this.maxEntries && !this.#m.has(key)) {
      const oldest = this.#m.keys().next().value;
      if (oldest !== undefined) this.#m.delete(oldest);
    }
    this.#m.set(key, value);
  }
  get size() {
    return this.#m.size;
  }
}

/** One JSON file per key under `dir`. Values are already-redacted model output plus metadata; never request bodies or keys. */
export class JsonFileCache implements InferenceCache {
  constructor(private readonly dir: string) {}
  private path(key: string) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("invalid cache key");
    return join(this.dir, `${key}.json`);
  }
  async get(key: string) {
    try {
      return JSON.parse(await readFile(this.path(key), "utf8")) as unknown;
    } catch {
      return undefined;
    }
  }
  async set(key: string, value: unknown) {
    try {
      await mkdir(this.dir, { recursive: true });
      const p = this.path(key);
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
      await rename(tmp, p);
    } catch {
      // A cache write failure must never fail the inference call.
    }
  }
}

/** Memory first, then file; file hits are promoted to memory. */
export class TieredCache implements InferenceCache {
  constructor(private readonly tiers: readonly InferenceCache[]) {}
  async get(key: string) {
    for (let i = 0; i < this.tiers.length; i++) {
      const v = await this.tiers[i]!.get(key);
      if (v !== undefined) {
        for (let j = 0; j < i; j++) await this.tiers[j]!.set(key, v);
        return v;
      }
    }
    return undefined;
  }
  async set(key: string, value: unknown) {
    for (const t of this.tiers) await t.set(key, value);
  }
}

export function createCache(opts: { dir?: string | null } = {}): InferenceCache {
  return opts.dir ? new TieredCache([new MemoryCache(), new JsonFileCache(opts.dir)]) : new MemoryCache();
}
