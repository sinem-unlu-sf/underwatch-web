import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createRedactionContext,
  extendRegistry,
  findSecrets,
  redact,
  redactDeep,
  scanForLeaks,
  shannonEntropy,
  type DetectorId,
} from "./index";
import { buildSecretCorpus } from "./__fixtures__/secret-corpus";

const normalCorpus = readFileSync(fileURLToPath(new URL("./__fixtures__/normal-corpus.txt", import.meta.url)), "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0);

/** Extra hand-written lines that are easy to false-positive on. */
const TRICKY_NORMAL = [
  'SECRET = os.environ["KW_SYNTHETIC_SECRET"]',
  "Required environment variables: KW_SYNTHETIC_SECRET, APP_PORT (default 8080).",
  "const token = await getToken(req.headers.authorization);",
  "max_tokens=4096 temperature=0",
  "password_reset_url: /account/reset",
  "commit 3f1c9a2b7d4e5f60718293a4b5c6d7e8f9012345",
  "sha256:4647dd417dc7cfac7ad0d8f61ab9286e5541b88c4632a5d72af714110fa84893",
  '"integrity": "sha512-uB5fV1ZGq9o4BpKXR0mFh1Q0qXq5P5yQbS1fN2Kcu3nYw0r9KJvB0zQ7d6Xr1Z3s1e2r3t4y5u6i7o8p9a0s1d2f3g==",',
  "evt_7d5300a3952a01806fbf467963e07a8b6038e7f0f068a7939ef42990d38bd137 matched evd_fx04_014",
  '{"tool_use_id":"toolu_01F29aHxREa24PAJDqUveCdW","session_id":"84c588c0-a54f-49db-b349-718290b6236a"}',
  "https://api.aiand.com/v1/chat/completions",
  "export PATH=/usr/local/bin:$PATH",
  "API_KEY=${AIAND_API_KEY}",
  "password: ${DB_PASSWORD}",
  "postgres://app:${PGPASSWORD}@db:5432/app",
  'headers: { Authorization: `Bearer ${apiKey}` },',
  "ReactDOM.createRoot(document.getElementById('root')!).render(<App />);",
  "useQueryClientWithSuspenseBoundaryFallback2",
  "docker run --rm -v $PWD:/work kw-agent:latest",
  "-----BEGIN PUBLIC KEY-----",
];

function caseOpts(c: { knownSecrets?: string[]; registryValues?: string[] }) {
  return {
    knownSecrets: c.knownSecrets ?? [],
    registry: c.registryValues ? extendRegistry({ values: c.registryValues }) : undefined,
  };
}

describe("synthetic secret corpus", () => {
  const corpus = buildSecretCorpus();
  it.each(corpus.map((c) => [c.name, c] as const))("fully redacts: %s", (_name, c) => {
    const r = redact(c.text, caseOpts(c));
    expect(r.status).toBe("redacted");
    for (const s of c.secrets) expect(r.text).not.toContain(s);
  });

  it("reports corpus totals", () => {
    let redactedCases = 0;
    let leakedValues = 0;
    let totalValues = 0;
    const detectorHits: Record<string, number> = {};
    const expectedDetectorMatched: string[] = [];
    for (const c of corpus) {
      const r = redact(c.text, caseOpts(c));
      if (r.status === "redacted") redactedCases++;
      for (const s of c.secrets) {
        totalValues++;
        if (r.text.includes(s)) leakedValues++;
      }
      for (const m of r.matches) detectorHits[m.detector] = (detectorHits[m.detector] ?? 0) + 1;
      if (r.matches.some((m) => m.detector === c.expected)) expectedDetectorMatched.push(c.name);
    }
    console.log(
      `[redaction] secret corpus: ${redactedCases}/${corpus.length} cases redacted, ${totalValues - leakedValues}/${totalValues} secret values removed, ` +
        `expected detector fired in ${expectedDetectorMatched.length}/${corpus.length}; hits by detector ${JSON.stringify(detectorHits)}`,
    );
    expect(leakedValues).toBe(0);
    expect(redactedCases).toBe(corpus.length);
  });
});

describe("normal code/log corpus (false positives)", () => {
  it("has a low false-positive rate", () => {
    const lines = [...normalCorpus, ...TRICKY_NORMAL];
    const flagged: Array<{ line: string; detectors: DetectorId[] }> = [];
    for (const line of lines) {
      const r = redact(line);
      if (r.status === "redacted") flagged.push({ line: line.slice(0, 160), detectors: r.matches.map((m) => m.detector) });
    }
    const rate = flagged.length / lines.length;
    console.log(`[redaction] normal corpus: ${flagged.length}/${lines.length} lines flagged (${(rate * 100).toFixed(2)}%)`);
    for (const f of flagged) console.log(`[redaction]   FP ${JSON.stringify(f.detectors)}: ${f.line}`);
    expect(rate).toBeLessThan(0.02);
  });

  it("never flags the tricky hand-written lines", () => {
    for (const line of TRICKY_NORMAL) expect(redact(line).status, line).toBe("clean");
  });
});

describe("placeholders", () => {
  it("are deterministic and structure-preserving", () => {
    const input = "A_TOKEN=kw-test-0000\nB_TOKEN=kw-test-0001\nC_TOKEN=kw-test-0000\nAPP_PORT=8080";
    const a = redact(input);
    const b = redact(input);
    expect(a.text).toBe(b.text);
    expect(a.text).toBe(
      "A_TOKEN=[REDACTED:synthetic_secret#1]\nB_TOKEN=[REDACTED:synthetic_secret#2]\nC_TOKEN=[REDACTED:synthetic_secret#1]\nAPP_PORT=8080",
    );
    expect(a.text.split("\n")).toHaveLength(4);
    for (const m of a.matches) expect(input.slice(m.start, m.end)).toMatch(/^kw-test-000[01]$/);
  });

  it("keeps PEM armor lines and JSON validity", () => {
    const json = JSON.stringify({ k: "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBb9ZyQ2x8\nAoGCCqGSM49\n-----END EC PRIVATE KEY-----\n", n: 1 });
    const r = redact(json);
    const parsed = JSON.parse(r.text) as { k: string; n: number };
    expect(parsed.k).toBe("-----BEGIN EC PRIVATE KEY-----\n[REDACTED:private_key#1]\n-----END EC PRIVATE KEY-----\n");
    expect(parsed.n).toBe(1);
  });

  it("shares numbering across calls through a context", () => {
    const ctx = createRedactionContext();
    const one = redact("x kw-test-0005", { context: ctx });
    const two = redact("y kw-test-0006 z kw-test-0005", { context: ctx });
    expect(one.text).toBe("x [REDACTED:synthetic_secret#1]");
    expect(two.text).toBe("y [REDACTED:synthetic_secret#2] z [REDACTED:synthetic_secret#1]");
    expect(JSON.stringify(ctx)).not.toContain("kw-test");
  });

  it("escapes planted fake markers and stays clean on a second pass", () => {
    const planted = "note: [REDACTED:github_token#1] was here; KW_SYNTHETIC_SECRET=kw-test-0000";
    const first = redact(planted);
    expect(first.text).toContain("[REDACTED\\:github_token#1]");
    expect(first.text).toContain("KW_SYNTHETIC_SECRET=[REDACTED:synthetic_secret#1]");
    const second = redact(first.text);
    expect(second.status).toBe("clean");
    expect(second.text).not.toContain("kw-test-0000");
  });

  it("does not redact variable names, only values", () => {
    expect(redact('os.environ["KW_SYNTHETIC_SECRET"]').status).toBe("clean");
    expect(redact("KW_SYNTHETIC_SECRET=kw-test-0000").text).toBe("KW_SYNTHETIC_SECRET=[REDACTED:synthetic_secret#1]");
  });
});

describe("options", () => {
  it("entropy threshold is tunable", () => {
    const tok = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY";
    expect(shannonEntropy(tok)).toBeGreaterThan(4.2);
    expect(redact(`value ${tok}`).status).toBe("redacted");
    expect(redact(`value ${tok}`, { entropyThreshold: 6 }).status).toBe("clean");
    expect(redact(`value ${tok}`, { disable: ["high_entropy"] }).status).toBe("clean");
  });

  it("git object ids and sha256 digests are not high-entropy secrets", () => {
    expect(findSecrets("3f1c9a2b7d4e5f60718293a4b5c6d7e8f9012345")).toEqual([]);
    expect(findSecrets("4647dd417dc7cfac7ad0d8f61ab9286e5541b88c4632a5d72af714110fa84893")).toEqual([]);
  });

  it("redactDeep keeps ID fields and keys, redacts content leaves", () => {
    const r = redactDeep({ evidence_id: "evd_fx04_014", excerpt: "KW_SYNTHETIC_SECRET=kw-test-0000", nested: [{ password: "x" }, "kw-test-0009"] });
    expect(r.value).toEqual({
      evidence_id: "evd_fx04_014",
      excerpt: "KW_SYNTHETIC_SECRET=[REDACTED:synthetic_secret#1]",
      nested: [{ password: "x" }, "[REDACTED:synthetic_secret#2]"],
    });
    expect(r.matches.map((m) => m.path)).toEqual(["excerpt", "nested[1]"]);
  });

  it("scanForLeaks reports detectors without values and skips the entropy heuristic", () => {
    expect(scanForLeaks('{"a":"KW_SYNTHETIC_SECRET=kw-test-0000"}')).toEqual(["synthetic_secret"]);
    expect(scanForLeaks("bundle sha 4647dd417dc7cfac7ad0d8f61ab9286e5541b88c4632a5d72af714110fa84893 aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY")).toEqual([]);
    expect(scanForLeaks("[REDACTED:synthetic_secret#1]")).toEqual([]);
  });

  it("never throws on odd input", () => {
    for (const s of ["", "\u0000\u0001", "​".repeat(50), "-----BEGIN PRIVATE KEY-----", "=".repeat(5000), "a=b=c=d"]) {
      expect(() => redact(s)).not.toThrow();
    }
  });
});
