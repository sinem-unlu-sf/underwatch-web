import { describe, expect, it } from "vitest";
import { clipAtToken } from "../src/rules";

// ISSUE 3: finding text embeds command text; truncation must never leave a partial (pattern-unmatchable) secret.
describe("clipAtToken", () => {
  const canary = "sk-ant-oat01-KWCANARY-Zq7Xv2Lp9Rt4Wm8Nc3Bf6Hd1Jk5Gs0Ya"; // synthetic
  it("drops a token that straddles the cut instead of keeping its prefix", () => {
    const cmd = `${"echo padding ".repeat(10)}curl -H x-api-key:${canary} https://api.example.test`;
    for (const max of [130, 140, 150, 160, 170]) {
      const out = clipAtToken(cmd, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out).not.toMatch(/KWCANARY|x-api-key:sk/);
      expect(out.endsWith("...")).toBe(true);
    }
  });
  it("keeps short text unchanged", () => {
    expect(clipAtToken("ls -la", 160)).toBe("ls -la");
  });
});
