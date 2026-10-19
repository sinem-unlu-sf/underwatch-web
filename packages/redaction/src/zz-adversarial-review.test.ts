/**
 * ADVERSARIAL REVIEW (ISSUE 3, independent reviewer). Synthetic KWCANARY values only.
 * `it.fails` = confirmed break (asserts the secure outcome; currently fails). Flip to `it` once fixed.
 */
import { describe, expect, it } from "vitest";
import { redact, redactionOptionsFromEnv } from "./index";

const RND = "KWCANARYq7Zr3Tn6Wy1Xv4Pm8Lk2Hs9Jd5Fb0Gc"; // random-looking, letter-initial, alnum (synthetic)
const TAIL = RND.slice(8);
const ANT = "sk-ant-oat01-KWCANARY7fQ2xLm9Pz4Rt8Vw3Ny6Bc1Dk5Hj0GsQe2Wr4Ty6Ui8Op0As3Df5Gh7Jk9Lz1Xc3Vb5Nm7Qw9Er1Ty3Ui5Op7As9D-KWCANARYAA";
const opts = redactionOptionsFromEnv({});
const hexdump = (s: string) => {
  const b = Buffer.from(s);
  let o = "";
  for (let i = 0; i < b.length; i += 16) {
    const c = b.subarray(i, i + 16);
    const hex = [...c].map((x) => x.toString(16).padStart(2, "0")).join("").match(/.{1,4}/g)!.join(" ");
    o += `${i.toString(16).padStart(8, "0")}: ${hex.padEnd(39)}  ${c.toString("latin1")}\n`;
  }
  return o;
};

describe("ADVERSARIAL: contextual secrets with lower-case keys", () => {
  it("URL query ?access_token=<random>", () => expect(redact(`GET https://api.example.test/v1?access_token=${RND}&x=1`, opts).text).not.toContain(TAIL));
  it(".npmrc _authToken=npm_<random>", () => expect(redact(`//registry.npmjs.org/:_authToken=npm_${RND}`, opts).text).not.toContain(TAIL));
  it("Cookie: session=<random>", () => expect(redact(`Cookie: session=${RND}`, opts).text).not.toContain(TAIL));
  it("control: same value with an upper-case env key IS redacted", () => expect(redact(`ACCESS_TOKEN=${RND}`, opts).text).not.toContain(TAIL));
});

describe("ADVERSARIAL: split output (more than a 'short prefix fragment' leaks)", () => {
  it("xxd of a token file: the ASCII column leaks most of the token in 16-char fragments", () => {
    const out = redact(hexdump(`CLAUDE_CODE_OAUTH_TOKEN=${ANT}\n`), opts).text;
    expect(out).not.toContain("Gh7Jk9Lz1Xc3");
  });
});
