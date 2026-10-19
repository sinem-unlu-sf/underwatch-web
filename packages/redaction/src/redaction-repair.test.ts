/**
 * Regression tests for the ISSUE 3 repair (adversarial review findings). Synthetic KWCANARY values only.
 */
import { describe, expect, it } from "vitest";
import { redact, redactionOptionsFromEnv, safeRedact, withheldTailMarker } from "./index";

const opts = redactionOptionsFromEnv({});
const RND = "KWCANARYq7Zr3Tn6Wy1Xv4Pm8Lk2Hs9Jd5Fb0Gc"; // random-looking, letter-initial (synthetic)
const RND_TAIL = RND.slice(8);
const ANT = "sk-ant-oat01-KWCANARY7fQ2xLm9Pz4Rt8Vw3Ny6Bc1Dk5Hj0GsQe2Wr4Ty6Ui8Op0As3Df5Gh7Jk9Lz1Xc3Vb5Nm7Qw9Er1Ty3Ui5Op7As9D-KWCANARYAA";
const LOW = "KWCANARYlowpass"; // low-entropy synthetic value
const r = (s: string) => redact(s, opts).text;

/** Every 8-char window of the secret body (after the format prefix) must be gone. */
function fragmentsLeft(out: string, secret: string, from = 12): string[] {
  const left: string[] = [];
  for (let i = from; i + 8 <= secret.length; i += 4) if (out.includes(secret.slice(i, i + 8))) left.push(secret.slice(i, i + 8));
  return left;
}

function xxd(s: string): string {
  const b = Buffer.from(s);
  let o = "";
  for (let i = 0; i < b.length; i += 16) {
    const c = b.subarray(i, i + 16);
    const hex = [...c].map((x) => x.toString(16).padStart(2, "0")).join("").match(/.{1,4}/g)!.join(" ");
    const ascii = [...c].map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : ".")).join("");
    o += `${i.toString(16).padStart(8, "0")}: ${hex.padEnd(39)}  ${ascii}\n`;
  }
  return o;
}

function hexdumpC(s: string): string {
  const b = Buffer.from(s);
  let o = "";
  for (let i = 0; i < b.length; i += 16) {
    const c = [...b.subarray(i, i + 16)];
    const h = c.map((x) => x.toString(16).padStart(2, "0"));
    const hex = `${h.slice(0, 8).join(" ")}  ${h.slice(8).join(" ")}`.padEnd(48);
    const ascii = c.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : ".")).join("");
    o += `${i.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|\n`;
  }
  return o;
}

const fold = (s: string, w: number) => s.match(new RegExp(`.{1,${w}}`, "g"))!.join("\n");

describe("contextual secrets with lower-case keys (random-looking values)", () => {
  it("URL query access_token / key / sig", () => {
    expect(r(`GET https://api.example.test/v1?access_token=${RND}&x=1`)).not.toContain(RND_TAIL);
    expect(r(`https://maps.example.test/api?key=${RND}`)).not.toContain(RND_TAIL);
    expect(r(`https://bucket.example.test/o?X-Amz-Signature=${LOW}abc&x=1`)).not.toContain(LOW);
  });
  it(".npmrc _authToken and Cookie / Set-Cookie values", () => {
    expect(r(`//registry.npmjs.org/:_authToken=npm_${RND}`)).not.toContain(RND_TAIL);
    expect(r(`Cookie: session=${RND}; theme=dark`)).not.toContain(RND_TAIL);
    expect(r(`Set-Cookie: sid=${LOW}; Path=/; HttpOnly`)).not.toContain(LOW);
    // names and short attribute values stay readable
    expect(r(`Cookie: session=${RND}; theme=dark`)).toMatch(/^Cookie: session=\[REDACTED:auth_header#1\]; theme=dark$/);
  });
  it("known credential headers redact low-entropy values too (PRIVATE-TOKEN, X-Token, X-Auth-Token)", () => {
    expect(r(`curl -H "PRIVATE-TOKEN: ${LOW}" https://gitlab.example.test/api/v4/projects`)).not.toContain(LOW);
    expect(r(`X-Token: ${LOW}`)).not.toContain(LOW);
    expect(r(`x-auth-token: ${LOW}`)).not.toContain(LOW);
  });
  it("code identifiers under lower-case keys are still NOT redacted (no regression)", () => {
    for (const s of ["token=other_var", "password=self.pw", "api_key=api_key2", "token=getToken", "secret=config_secret_value"]) expect(r(s)).toBe(s);
  });
});

describe("secrets split across lines", () => {
  it("xxd: neither the ASCII column nor the hex column leaks the token", () => {
    const out = r(xxd(`CLAUDE_CODE_OAUTH_TOKEN=${ANT}\n`));
    expect(fragmentsLeft(out, ANT)).toEqual([]);
    const hexOfTail = Buffer.from(ANT.slice(40, 56)).toString("hex");
    expect(out.replace(/ /g, "")).not.toContain(hexOfTail.slice(0, 16));
    expect(out).toContain("CLAUDE_CODE_OAUT"); // unrelated first line kept
  });
  it("hexdump -C ASCII column", () => {
    const out = r(hexdumpC(`token: ${ANT}\n`));
    expect(fragmentsLeft(out, ANT)).toEqual([]);
  });
  it("fold -w 20 and base64 -w 76", () => {
    expect(fragmentsLeft(r(fold(`CLAUDE_CODE_OAUTH_TOKEN=${ANT}`, 20)), ANT)).toEqual([]);
    const b64 = Buffer.from(`ANTHROPIC_API_KEY=${ANT}\nOTHER=1\n`).toString("base64");
    const out = r(fold(b64, 76));
    for (const line of fold(b64, 76).split("\n").slice(0, -1)) expect(out).not.toContain(line);
  });
  it("xxd -p (plain hex lines)", () => {
    const hex = Buffer.from(`key ${ANT}`).toString("hex");
    const out = r(fold(hex, 60));
    expect(out).not.toContain(hex.slice(60, 120));
  });
  it("one-secret-per-line output (env | sort) is not glued across lines", () => {
    const text = `ANTHROPIC_API_KEY=${ANT}\nAPPDATA=/home/dev/appdata\nHOME=/home/dev\n`;
    const out = r(text);
    expect(out).toContain("APPDATA=/home/dev/appdata");
    expect(fragmentsLeft(out, ANT)).toEqual([]);
  });
});

describe("bounded cost (no quadratic backtracking)", () => {
  const big = 200_000;
  const cases: Record<string, string> = {
    identifier_run: "a".repeat(big),
    json_unterminated: `"a": "${"x".repeat(big)}`,
    url_run: `http://${"a".repeat(big)}`,
    dotted: "a.".repeat(big / 2),
    dashed: "a-".repeat(big / 2),
    wrapped_lines: "aaaaaaaaaaaaaaaa\n".repeat(big / 17),
    cookie: `Cookie: ${"a".repeat(big)}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`redact() on 200 KB ${name} finishes in under 1 s`, () => {
      const t = performance.now();
      redact(text, opts);
      expect(performance.now() - t).toBeLessThan(1000);
    });
  }
  it("safeRedact withholds the tail beyond maxLength (fails closed, never stores it)", () => {
    const text = `head ${ANT} ${"word ".repeat(100)}tail-secret-${RND}`;
    const res = safeRedact(text, { ...opts, maxLength: 200 });
    expect(res.status).toBe("redacted");
    expect(res.text).not.toContain(RND_TAIL);
    expect(fragmentsLeft(res.text, ANT)).toEqual([]);
    expect(res.text).toMatch(/\[REDACTION_WITHHELD: \d+ more characters not stored\]$/);
    expect(withheldTailMarker(3)).toBe("[REDACTION_WITHHELD: 3 more characters not stored]");
  });
});
