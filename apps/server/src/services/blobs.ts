import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BlobRef, BlobStore } from "./types";

const SHA_RE = /^[0-9a-f]{64}$/;

/** Content-addressed blob store on the local filesystem (data/evidence/blobs/<aa>/<sha256>). */
export class FsBlobStore implements BlobStore {
  constructor(private readonly dir: string) {}

  #path(sha256: string): string {
    if (!SHA_RE.test(sha256)) throw new Error("invalid blob id");
    return path.join(this.dir, sha256.slice(0, 2), sha256);
  }

  put(data: string | Uint8Array): BlobRef {
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = this.#path(sha256);
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, file);
    }
    return { sha256, size_bytes: bytes.length };
  }

  get(sha256: string): Buffer | null {
    const file = this.#path(sha256);
    return existsSync(file) ? readFileSync(file) : null;
  }

  has(sha256: string): boolean {
    return existsSync(this.#path(sha256));
  }
}
