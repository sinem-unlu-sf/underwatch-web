/**
 * Live smoke test: one explanation for the synthetic fixture finding fx-04, sent to ai& ONLY if
 *   (a) an ai& key is configured (AIAND_API_KEY in env, or in KW_ENV_FILE / <workspace root>/.env.local), and
 *   (b) the provider's API surface is verified (AIAND_API_SURFACE.verification !== "unverified").
 * Otherwise prints why it skipped and exits 0. Never prints the key. Sends only redacted synthetic fixture data.
 *
 *   pnpm --filter @kw/inference smoke
 *   KW_ENV_FILE=/path/to/.env.local pnpm --filter @kw/inference smoke
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Event, Evidence, Finding, PolicyVersion } from "@kw/schema";
import { AIAND_API_SURFACE, AiAndProvider, buildEvidenceBundle, loadAiAndConfig } from "../src/index";

function line(s: string) {
  process.stdout.write(`${s}\n`);
}

async function main() {
  const loaded = loadAiAndConfig();
  line(`[smoke] env file: ${loaded.env_file ?? "(none)"} (${loaded.env_file_exists ? "exists" : "missing"})`);
  line(`[smoke] ai& API surface verification: ${AIAND_API_SURFACE.verification}`);
  if (!loaded.config.apiKey) {
    line(`[smoke] SKIPPED: ai& not configured (no ${AIAND_API_SURFACE.key_env_var} in the process env or the env file).`);
    return;
  }
  if (AIAND_API_SURFACE.verification === "unverified") {
    line("[smoke] SKIPPED: ai& API surface is not verified; refusing to call guessed endpoints.");
    return;
  }
  line(`[smoke] key: configured via ${loaded.key_source}`);
  const provider = new AiAndProvider({ ...loaded.config, cacheDir: null, maxRetries: 1 });
  line(`[smoke] provider: ${JSON.stringify(provider.describe())}`);

  const health = await provider.health();
  line(`[smoke] health: ${health.status} ${health.status === "ok" ? health.value.detail : "detail" in health ? health.detail : ""}`);

  const fx = JSON.parse(readFileSync(fileURLToPath(new URL("../src/__fixtures__/fx-04-env-read-via-bash.json", import.meta.url)), "utf8")) as {
    events: Event[];
    evidence: Evidence[];
    findings: Finding[];
    policy_version: PolicyVersion;
  };
  const bundle = buildEvidenceBundle({
    finding: fx.findings[0]!,
    events: fx.events,
    evidence: fx.evidence,
    policy: fx.policy_version,
    redaction: { knownSecrets: [loaded.config.apiKey] },
  });
  line(`[smoke] bundle: finding ${bundle.finding_id}, ${bundle.items.length} items, sha256 ${bundle.sha256.slice(0, 16)}…, placeholders ${bundle.redaction_summary.total_placeholders}`);

  const r = await provider.explainFinding(bundle, { bypassCache: true });
  const m = r.meta;
  line(
    `[smoke] explainFinding: status=${r.status} model=${m.model} served_model=${m.served_model ?? "null"} prompt_version=${m.prompt_version} ` +
      `mode=${m.structured_mode} attempts=${m.attempts} repair=${m.repair_attempted} finish=${m.finish_reason ?? "null"} latency_ms=${m.latency_ms} request_id=${m.request_id ?? "null"}`,
  );
  if (m.usage) line(`[smoke] usage: ${JSON.stringify(m.usage)}`);
  if (r.status === "ok") {
    line(`[smoke] summary: ${r.value.summary}`);
    for (const c of r.value.claims) line(`[smoke]   [${c.citation_status}${c.unsupported_reason ? `:${c.unsupported_reason}` : ""}] ${c.text} <- ${c.evidence_ids.join(", ") || "(none)"}`);
    line(`[smoke] insufficient_evidence=${r.value.insufficient_evidence} cited=${r.value.citation_check.cited_claims} unsupported=${r.value.citation_check.unsupported_claims}`);
  } else if (r.status === "invalid_output") {
    line(`[smoke] errors: ${r.errors.join(" | ")}`);
  } else if ("detail" in r) {
    line(`[smoke] detail: ${r.detail}`);
  }
}

main().catch((e: unknown) => {
  // Should be unreachable (providers never throw); print only the error class, not its message, to avoid echoing config.
  line(`[smoke] unexpected failure: ${e instanceof Error ? e.name : "error"}`);
  process.exitCode = 1;
});
