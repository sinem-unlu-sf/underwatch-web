# Underwatch: security remediation report

Date: 2026-10-17 (hackathon day). Scope: four issues, each fixed by an engineer, attacked by an independent adversarial reviewer, then repaired.

This report does **not** claim that Underwatch is secure or production-ready. It records what was changed, what was tested and what the results were, and what is still open. Only synthetic canaries were used in tests and evidence (`sk-ant-oat01-KWCANARY-…`, `sk-KWCANARY-…`). The real Claude token was used for exactly three Docker smoke runs and never printed. The real ai& key was used for one live smoke, during the original Issue 2 fix. Nothing was committed to git.

Evidence paths are relative to the session scratchpad, `/private/tmp/claude-501/-Users-oguzkirmizi-Desktop-academics-hackathons-81agents/e12806d6-35d1-4210-8dab-a807163465a2/scratchpad/` (written as `$S` below).

---

## Issue 1: Claude credential readable inside the agent container

### Root cause and affected files
- **How the token got into the agent:**
  - `docker/compose.agent.yml` passed `CLAUDE_CODE_OAUTH_TOKEN` through to the agent container.
  - `scripts/agent-smoke.sh` exported the token in the shell that started the container.
  - `apps/server/src/verification/harness.ts` passed it in with `-e`.
- **Why that exposed it:** the agent's Bash tool, hooks and child processes inherit the environment. Claude Code's own subprocess env scrubbing needs bubblewrap, which this container cannot run. So the token was readable through `env`, `/proc/*/environ`, child processes and host-side `docker inspect`.
- **How it could leave:** through the egress proxy, which allowlisted `api.anthropic.com`, `platform.claude.com` and `claude.ai`.
- **Latent regression path:** `packages/adapter-claude-code/src/adapter.ts` still declared `secretEnv: [{CLAUDE_CODE_OAUTH_TOKEN, ~/.underwatch/claude-oauth-token}]`.

### Changes
- **New credential broker container** (`docker/llm-broker/`: `broker.mjs`, `Dockerfile`, tests). It has no dependencies, a read-only filesystem, all capabilities dropped, and runs as uid 1000.
  - It holds the real token on a read-only mount that only the broker gets.
  - The agent gets only `ANTHROPIC_BASE_URL=http://kw-llm-broker:8080` and a per-run placeholder value in `CLAUDE_CODE_OAUTH_TOKEN`. This follows the documented LLM-gateway pattern; `ANTHROPIC_AUTH_TOKEN` was not used, because it would switch billing to per-token API billing.
  - **Request filtering:**
    - Forwards only `POST /v1/messages` and `POST /v1/messages/count_tokens`; everything else gets 403.
    - Requires the placeholder, otherwise 401.
    - Strips incoming credentials and forwarding headers, then injects the real token toward a fixed upstream (`https://api.anthropic.com`).
  - **Body inspection (denylist):** refuses server tools (`web_fetch`, `web_search`, `code_execution`, `computer`), `mcp_servers` and `container`.
    - Repair: it also refuses any image or document `source.type:"url"` at any depth, including inside `system` and `tool_result`.
  - **Repair, duplicate keys:** forwards `JSON.stringify(parsed)`, so upstream receives exactly the object that was inspected. This closes the duplicate-key parser differential.
  - **Repair, response redaction:** responses are redacted for the raw token and for its JSON `\u`-escaped spellings, in both headers and the body stream.
  - **Logging:** one metadata-only line per request. No headers, bodies or query strings are logged.
- **Compose:** `docker/compose.agent.yml` adds the broker service and removes the token pass-through. The `KW_BROKER_*` variables are required, so a mis-wired run fails closed.
- **Proxy allowlist:** `docker/egress-proxy/allowlist.ere` is now empty (deny-all, kept as a logged tripwire).
- **Smoke script:** `scripts/agent-smoke.sh` mounts the token into the broker only and never reads it into the shell. It adds preflight checks P13–P16, and P7 now expects direct API access to be denied. It also scans the broker log and the `docker inspect` output of both containers for the token.
- **Harness:** `apps/server/src/verification/harness.ts` and `service.ts` start a per-run broker container, scrub the token and the canary, and store the broker log as an artifact.
- **New adversarial suite:** `scripts/agent-broker-adversarial.sh`.
- **Adapter (repair):** in `packages/adapter-claude-code/src/adapter.ts`, `secretEnv` is now typed `[]` and always empty. A new `credential` descriptor (`mode:"broker"`) says the real token goes to the broker only. The same edit was mirrored into the staging copy (`kw-next`) so a re-copy cannot bring the old version back.

### Credential outcome class per exposure path
Classes: **unavailable** (the secret is not present in that context), **readable-but-blocked** (present, but sending it out is prevented), **exposed** (present and can be sent out).

| Exposure path | Before | After (verified with) |
|---|---|---|
| Agent env, `/proc/*/environ` | exposed | **unavailable** (adversarial suite with canary; reviewer's live probe) |
| Child processes of the agent | exposed | **unavailable** (one real-token run in which a Bash child actually ran `env`: no `CLAUDE_CODE_OAUTH_TOKEN`, no `sk-ant-oat01-`). The adversarial suite itself caught 0 children. |
| Process args (`ps`, `/proc/*/cmdline`) | unavailable | **unavailable** |
| Agent filesystem (full grep, `/tmp`, `$HOME`, `/workspace`, hook dirs) | unavailable | **unavailable** |
| Hook spool and stream-json | unavailable unless the agent printed it | **unavailable** (real-token run, host-side scan clean) |
| Host `docker inspect` of the agent | exposed | **unavailable** (only the placeholder) |
| Host `docker inspect` of the broker | n/a | **unavailable** (shows only the mount path) |
| Broker responses reflecting the token | n/a | **unavailable** for the raw and `\u`-escaped forms; other encodings are not filtered (defence in depth only) |
| Broker host token file | exists (host) | **readable** by anyone with host or Docker-daemon access; outside this sandbox's trust boundary |
| Sending out via the egress proxy or direct network | possible | **blocked** (proxy deny-all, internal network, no default route, no DNS) |

No path ended up readable-but-blocked inside the agent. The token is simply absent there.

### Tests executed (actual results)
- **Broker tests:** `node --test docker/llm-broker/broker.test.mjs` 10/10 passed. `broker.adversarial.test.mjs` 11/11 passed.
  - Negative control: the same adversarial file run against the pre-repair broker gave 9 failed and 2 passed. The 2 that passed are the false-positive test and the control, as intended.
- **Smoke summary:** `node --test scripts/agent-smoke-summary.test.mjs` 9/9 passed.
- **Server and adapter:**
  - `apps/server` `vitest run src/verification`: 34/34 passed, and `tsc` was clean at the time of the repair.
  - `packages/adapter-claude-code`: 88 passed, 1 expected-fail; that expected-fail is an Issue 3 test, which was later flipped.
- **Real-token smoke runs (haiku), 3 in total:**
  1. Standalone: result OK.
  2. `agent-smoke.sh broker2`: `ok:true`, authenticated, token scan clean, proxy saw 0 agent requests.
  3. `agent-smoke.sh repair-bash`, after the repair: `ok:true`, broker forwarded 2× `POST /v1/messages 200`, a Bash child ran `env` without the token, token scan clean.
  - Evidence: `$S/smoke/broker2/`, `$S/smoke/repair-bash/`.
- **Adversarial attacks:**
  - **Engineer's suite** (`scripts/agent-broker-adversarial.sh`, canary, uid 1000): 51 checks, 0 EXPOSED, 0 ALLOWED.
    - Negative control: the same probe against the old design reported EXPOSED with 82 hits.
    - Evidence: `$S/adv/report.txt`.
  - **Reviewer's live probe:** canary absent from env and filesystem, no `docker.sock`, `host.docker.internal` and `gateway.docker.internal` do not resolve, no default route.
  - **Attacks the reviewer found that succeeded before the repair**, and their outcome after it:

    | Attack | Before repair | After repair |
    |---|---|---|
    | URL image block | forwarded | **403** (unit test + live canary check) |
    | URL document block | forwarded | **403** (unit test + live canary check) |
    | URL image nested in `tool_result` | forwarded | **403** (unit test + live canary check) |
    | Duplicate `tools` key parser differential | raw bytes forwarded | **re-serialized** (unit test) |
    | JSON-escaped token echo in a response | passed through | **redacted** (unit test) |
  - **False-positive check:** the 3 recorded Claude Code request shapes and the 2 live real-token requests all pass the broker's filters.

### Tests that could not run, and why
- The harness with the real token, and the harness Tetragon kernel path: not run, to limit real-token use. The harness was checked with a canary only.
- Native Linux Docker: no Linux host was available.
- `scripts/agent-broker-adversarial.sh` was not re-run after the repair, and has no URL-source or duplicate-key probes.
- Confirming that Anthropic actually fetches URL sources would mean spending the real token on an attacker-controlled URL, so it was not done.

### Remaining risks and limitations
- **Denylist only:** body inspection blocks documented egress features only. An undocumented or future URL-fetching feature would not be caught. `KW_BROKER_ALLOW_SERVER_TOOLS=1` disables all of these checks.
- **Data and quota still flow to Anthropic:** the agent can still send workspace data to Anthropic itself, and can spend subscription quota during a run.
- **Token lifetime:** the real `setup-token` credential lasts one year. No documented short-lived subscription credential exists. The per-run placeholder is the strongest mitigation available.
- **Host trust:** anyone with host or Docker-daemon access can read the token file.
- **Effects of re-serializing:** keys that look like integers get reordered, integers above 2^53 lose precision, and the effect on prompt caching was not measured.
- **Possible new item:** `CLAUDE_CODE_MESSAGING_TOKEN`, a local Claude Code IPC value, appears in a Bash child's env and therefore in stream-json evidence. It is not an Anthropic credential and was not investigated.

### Manual steps still required
1. **Native Linux:** the token file must be readable by uid 1000 inside the broker, for example a per-run copy chowned to 1000.
2. **Direct compose users:** anyone running `docker compose -f docker/compose.agent.yml` outside the smoke script must set `KW_BROKER_TOKEN_FILE`, `KW_BROKER_CLIENT_TOKEN_FILE` and `KW_BROKER_CLIENT_TOKEN`.
3. **Broker image:** rebuild `kw-llm-broker:1` wherever it is used. The smoke script does this automatically.
4. **Adapter owners:** runners must use `credential` (broker mode); `secretEnv` is always empty.

---

## Issue 2: ai& endpoint not restricted to HTTPS

### Root cause and affected files
- **No URL checks:** `packages/inference/src/config.ts` passed `AIAND_BASE_URL` on without validation. `packages/inference/src/providers/aiand.ts` then sent `Authorization: Bearer <key>` to whatever URL it was given: `http://`, credentials in the URL, query strings, or any host.
- **Unpinned transport:** `fetchTransport` relied on the global dispatcher, and nothing checked TLS settings right before each request.
- **Found by the reviewer:**
  - The first fix's `https.Agent` still trusted Node's extensible default trust store. With `NODE_EXTRA_CA_CERTS`, `tls.setDefaultCACertificates` or `--use-openssl-ca`, a MITM received the key even in a production config.
  - The dev-only http exception used `http.globalAgent`, which honours `NODE_USE_ENV_PROXY` + `HTTP_PROXY`, so the key went to the proxy in plaintext.

### Changes
- **New `packages/inference/src/endpoint-policy.ts`:**
  - `validateAiAndEndpoint`: https only; host `api.aiand.com` on the default port, plus exact hosts from `KW_AIAND_ALLOWED_HOSTS`; no userinfo, query, fragment, whitespace, control characters or backslashes. Error text never echoes the URL.
  - **http exception:** allowed only when all of these hold: `NODE_ENV` is `development` or `test`, `KW_ALLOW_INSECURE_AIAND_HTTP=1`, the host is loopback, and the host is allowlisted.
  - `tlsVerificationProblem()`: refuses when `NODE_TLS_REJECT_UNAUTHORIZED` turns verification off.
  - `guardAiAndTransport`: re-validates the exact URL and the TLS state before every request.
  - `createAiAndHttpsTransport`:
    - Uses `node:https` with `rejectUnauthorized:true` and TLS 1.2 or newer.
    - **Repair:** trust is pinned with `ca: [...tls.rootCertificates]` (Node's bundled Mozilla store).
    - Any 3xx raises `RedirectBlockedError` and is never followed.
    - Errors are scrubbed codes only.
    - **Repair:** the http dev branch uses its own `new http.Agent()`, which ignores env proxies.
- **Wiring:** `providers/aiand.ts`, `config.ts`, `types.ts` and `index.ts` validate the URL at load time and at construction. Every transport, including injected ones, is wrapped by the guard. Policy errors return a final `unavailable/endpoint_rejected` result and are not retried.

### Tests executed (actual results)
- **`endpoint-policy.test.ts`: 41/41 passed.** It uses local HTTPS servers and a test CA generated with openssl. Covered:
  - self-signed certificate and hostname mismatch: refused, server received nothing;
  - http in production: rejected, zero requests sent;
  - 307 redirects: blocked;
  - 18 malformed or forbidden URLs: rejected, spy transport never called;
  - `NODE_TLS_REJECT_UNAUTHORIZED=0`: refused;
  - no canary in any result, error or `describe()` output.
- **`endpoint-policy.adversarial.test.ts`: 16/16 passed.** Each case runs in a child process with the synthetic key.
  - Negative control: with the two repair lines reverted, 4 failed and 12 passed. The 4 failures are exactly the attack tests (canary delivered).
- **Adversarial attacks and outcomes:**

  | Attack | Before repair | After repair |
  |---|---|---|
  | `NODE_EXTRA_CA_CERTS` + DNS-reroute MITM | **succeeded** (MITM got the canary) | refused, MITM gets nothing |
  | `tls.setDefaultCACertificates` | **succeeded** | refused |
  | `--use-openssl-ca` + `SSL_CERT_FILE` | not tested | refused |
  | Dev http + `NODE_USE_ENV_PROXY` / `HTTP_PROXY` | **succeeded** (plaintext key to the proxy) | proxy gets nothing; loopback target still served |
  | https transport + `HTTPS_PROXY` | blocked | blocked |
  | URL tricks (`https:api.aiand.com`, `:0443`, trailing dot, `%2e`, U+3002, `::ffff:127.0.0.1`, mixed-case `NODE_ENV`, junk allowlist entries, `wss:`) | blocked | blocked |
- **Full `packages/inference` suite:** 86/86 at repair time; 89/89 after the Issue 4 additions. Both `tsc` configs clean.
- **Live:**
  - The real-key smoke (original fix, `NODE_ENV=production npx tsx scripts/smoke.ts`): health ok, and `explainFinding` returned ok. Not independently re-verified.
  - After the repair, a keyless GET to `https://api.aiand.com/v1/models` through the pinned transport returned 200 with 13 models.

### Tests that could not run, and why
- The real-key smoke was not re-run after the repair, because the repair task did not authorise using the key. The keyless check covers the one thing the repair changed (TLS trust).
- `--use-system-ca` / `NODE_USE_SYSTEM_CA`: testing it would mean writing to the OS keychain. The same pin covers it by construction.
- The real-TLS tests are skipped, not failed, on machines without `openssl`.

### Remaining risks and limitations
- **TLS-intercepting proxies:** a corporate TLS-intercepting proxy or a private CA in front of ai& cannot work. There is deliberately no env override, because that would reopen the hole.
- **Trust store age:** the trusted roots are whatever ships with this Node build, and only update when Node is upgraded.
- **Injected transports:** a transport injected through `deps.transport` (for example the still-exported `fetchTransport`) uses the global trust store. The guard still checks the URL and `NODE_TLS_REJECT_UNAUTHORIZED`, but not CA additions. Only tests inject transports today.
- **Dev `localhost`:** in the dev exception, `localhost` is resolved by the OS resolver. Use `127.0.0.1`.
- **Code inside the server process:** it can still read the key directly. Keep-alive is off (one TLS handshake per call). A provider created while `NODE_TLS_REJECT_UNAUTHORIZED=0` stays rejected until restart.

### Manual steps still required
- **Default configuration:** nothing to do.
- **Local http mock:** needs all four settings: `NODE_ENV=development` (or `test`), `KW_ALLOW_INSECURE_AIAND_HTTP=1`, a loopback host, and that host in `KW_AIAND_ALLOWED_HOSTS`.
- **Optional:** re-run the real-key smoke to re-confirm the full flow.

---

## Issue 3: log-reader secret redaction not on by default

### Root cause and affected files
- **Adapter redaction off by default:** `packages/adapter-claude-code/src/parse.ts` defaulted to identity redaction (`ctx.redact ?? (x => x)`).
- **Truncate before redact:** summaries were truncated before redaction, both in the adapter and in `packages/analysis/src/rules.ts`, which could leave secret fragments no pattern matches.
- **No storage-boundary pass:**
  - `persistRunBundle` wrote bundles as given.
  - `apps/server/src/observers/ingest.ts` skipped it entirely.
  - The Ask Witness question was stored raw in `investigation_turns`.
  - Fastify error logs carried raw messages.
- **Found by the reviewer:**
  - **Supervised-run bypass:** `apps/server/src/supervised/service.ts` `start()` inserted the raw task into `runs.label` / `task_description` and `supervised_runs.task` before redaction. The later `INSERT OR IGNORE` in `persistRunBundle` threw the redacted copy away. The raw task reached the API and the Neo4j Task node.
  - **Contextual detector gaps:** lower-case `access_token=`, `_authToken=`, Cookie values, `PRIVATE-TOKEN` / `X-Token` headers.
  - **Split leaks:** `xxd` / `fold` output leaked nearly the whole token.
  - **Event-loop blocking:** a quadratic `kvRe` regex took about 64 s on 200 KB of input, synchronously in the server process.

### Changes
- **`packages/redaction`:**
  - Detectors added: `encoded_secret` (one decoding level of base64, base64url, hex or percent-encoding), `custom_pattern`, and (repair) `split_secret`, which rejoins equal-width wrapped lines and the ASCII and hex columns of `xxd` / `hexdump -C` output.
  - Repair: contextual key, query-parameter, cookie and credential-header rules.
  - Repair: left-boundary lookbehinds on `kvRe` and `url_credentials`, which makes them linear.
  - The entropy heuristic now judges filesystem paths one segment at a time.
  - `safeRedact()` fails closed:
    - on any error it stores `[REDACTION_FAILED]`;
    - (repair) above `maxLength`, 1,000,000 characters by default, the head is redacted and the tail is withheld.
  - `redactionOptionsFromEnv()` with `KW_REDACTION_PATTERNS_FILE`. A bad pattern file stops startup.
- **`packages/adapter-claude-code`:** the built-in redactor always runs, and `ctx.redact` can only add to it. Text is redacted before truncation. Turning it off requires the explicit `rawMode: "unsafe_raw_for_restricted_blob_store"`.
- **`packages/analysis/src/rules.ts`:** `clipAtToken()` truncates on token boundaries.
- **`apps/server`:**
  - `src/ingest/sanitize.ts` runs inside `persistRunBundle` and in `observers/ingest.ts`. Outcomes are recorded in `record_redactions` (migration `070_record_redaction.sql`) and in evidence `redaction_status`.
  - The Ask Witness question is redacted before it is sent to ai& and before it is stored.
  - Fastify `err` log serialization is redacted.
  - **Repair:**
    - `supervised/repo.ts` sanitizes task, error and limitations on every insert and update.
    - `supervised/service.ts` sanitizes the run row before inserting it, and builds the label and the 202 response from redacted values.
    - The replay check compares redacted text, plus raw text for rows stored before this change.
    - `repo/findings.ts` redacts user-typed status-change notes.

### Tests executed (actual results)
- **Suites at repair time:**
  - redaction 96/96, including 7 cases of 200 KB input, each under 1 s;
  - adapter 90/90, including a 200 KB `parseRunOutputs` in 56 ms (previously about 50 s);
  - analysis 93/93;
  - inference 89/89;
  - observer-tetragon: 26 passed, 11 live tests skipped.
- **Server:** 20 files, 180 passed, 1 failed. The failure is in `src/findings-views/findings-views.test.ts`, owned by the concurrent Findings-modes work.
  - `redaction.test.ts` plants canaries in every text field and checks SQLite, API responses, captured logs (including a 500 error) and the outbound ai& body: no canary found.
  - `redaction-supervised.test.ts` covers the supervised path end to end, replay idempotency, the 409 on a different task, and finding notes.
  - `redaction-graph.test.ts` passed, including a live projection into kw-neo4j and a follow-up query showing no `KWCANARY` node.
- **Adversarial attacks and outcomes:**
  - All 10 of the reviewer's `it.fails` tests now pass as plain `it`: 3 supervised-run, 3 server contextual, 3 redaction contextual, and the `xxd` split test. So does the adapter WebFetch `access_token` case.
  - Earlier, the supervised-run attack had been shown to succeed with 3 genuine assertion failures.

  | Attack | Before repair | After repair |
  |---|---|---|
  | Supervised task canary (DB row, GET, 202 response) | **leaked** | redacted |
  | `?access_token=`, `.npmrc _authToken=`, `Cookie: session=` | **leaked** | redacted |
  | `xxd` dump of the token | **nearly whole token leaked** | redacted (pieces + hex column) |
  | 200 KB identifier run | **~64 s, event loop blocked** | 1–23 ms |
  | Write/Edit/MCP tool inputs | redacted | redacted |
  | ANSI, Unicode, base32, rot13, double base64, `od -c` | mostly caught by the entropy heuristic only; `od -c` and low-entropy prose leak | unchanged, documented |
- **Read-only probe of `data/kw.db`:** no stored row trips a precise detector. Only counts were printed.

### Tests that could not run, and why
- **No real Claude or ai& call:** not needed for this issue, so the real credentials were left alone.
- **No new live-Neo4j test for the supervised path:** the projection reads from SQLite, which is verified clean, and the offline projection plan is asserted.
- **Other write paths not covered by tests (code read only):** safeguard versions, `verification/repo.ts`, and other Fastify log fields.

### Remaining risks and limitations
- **Uncovered writers:** these still store text without redaction: safeguard versions (`safeguards/store.ts`), verification-run text (`verification/repo.ts`), and investigation answers.
- **Fastify logs:** only the `err` serializer and `ApiHttpError` messages are redacted. Other structured log fields are not.
- **Missed formats and splits:** low-entropy secrets in prose (`password is X`, `--password X`, `postgres://:pw@`). Splits across records or JSON fields, lines of unequal width, `od -c` / `od -x` output. Double encodings, gzip, rot13.
- **Entropy heuristic:** can miss secrets and can redact random-looking non-secrets. `split_secret` can over-redact the start of the next line.
- **Fingerprint side channel:** the sha256 over the original Ask Witness question can confirm a guessed low-entropy secret.
- **Operator patterns:** regexes in `KW_REDACTION_PATTERNS_FILE` are not checked for catastrophic backtracking.
- **Raw captures by design:** hook spool, stream-json, transcripts, Tetragon slices and the blob store stay unredacted and need restricted access.
- **Old rows:** rows stored before this change are not re-scanned.

### Manual steps still required
- Restart the server so migration 070 is applied.
- Optionally set `KW_REDACTION_PATTERNS_FILE` for organisation-specific token formats.
- Add redaction to the uncovered writers listed above.

---

## Issue 4: security verdicts conflated with task outcomes

### Root cause and affected files
- **Graph verdict:** `packages/graph/src/queries.ts` `verdictFor` returned one verdict built only from attempted/blocked.
- **Harness status:** `apps/server/src/verification/evaluate.ts` folded the restricted and legitimate cases into one status.
- **Legacy rows:** v1 rows with `verified_for_tested_scenario` read as Passed with no task evidence.
- **AI context:** the UI and the AI evidence bundle presented legacy fields as if they were task outcomes.
- **Found by the reviewer:**
  - Any tool `is_error` counted as "blocked": file-not-found, non-zero exits, truncated leaks (A2–A4).
  - Obfuscated reads were invisible (`.e""nv`, globs) (A1).
  - `repo.normalize` trusted any stored `passed`. Row `ver_91160b67e6eb7cc6ff0129e5` in `data/kw.db` is Passed with security unknown (A7).
  - `outcomesFromFlatProps` skipped schema validation (A6).
  - The reported claim came from `result.subtype`, not from the agent's words (A5).

### Changes
- **Schema** (new `packages/schema/src/outcomes.ts`):
  - `SecurityOutcome` (allowed | blocked | unknown) and `TaskOutcome` (succeeded | failed | unknown), each with evidence ids, source, time, basis and reason.
  - Any non-unknown value needs evidence and a basis that is not "reported". Task "succeeded" requires basis observed.
  - `ReportedTaskClaim` is never an input to the task outcome.
  - Passed requires security observed blocked AND task observed succeeded.
- **Migration** `apps/server/migrations/080_verification_outcomes.sql`: adds three nullable columns.
- **Evaluator** (`evaluate.ts`, repair):
  - "Blocked" requires a denial record: `result.permission_denials` or a `system/permission_denied` event. Kernel EPERM evidence is still added afterwards by `observers/kernel-evidence.ts`. An error without a denial means not exercised, which gives security unknown.
  - The canary scan also catches base64 (all byte alignments, URL-safe, wrapped), hex, and any 16-character piece of the run's own canary.
  - Bash commands are checked again after removing quotes and expanding globs.
  - Every "blocked" reason says it covers only detected attempts.
  - The reported claim comes from the agent's final message text.
- **Read path** (`repo.ts`, repair): a stored `passed` is shown only if the run's own outcomes establish it. Otherwise it is shown as Inconclusive with a limitation note; the stored row is not changed.
- **Graph:**
  - Repair: `outcomesFromFlatProps` validates and falls back to the legacy derivation, which never yields task success.
  - Graph projection and queries expose both outcomes. `verdict` is kept as a deprecated alias.
- **Web:**
  - `apps/web/src/components/safeguards/OutcomePair.tsx` shows the two outcomes side by side, plus the reported claim and the scope note under every "blocked".
  - The Overview and Safeguards pages relabel the legacy fields.
- **Inference:**
  - `bundle.ts` adds both outcomes and renames the old fields with a `legacy_` prefix.
  - New rule in `askwitness.ts` and `prompts.ts`: `security_outcome` / `task_outcome` are authoritative, and `legacy_` fields are not task outcomes.

### Tests executed (actual results)
- **Suites at repair time:**
  - server verification folder 43/43;
  - full server 162 passed, 3 expected-fail, 3 failed; the 3 failures were the Issue 3 reviewer's file, flipped later by the Issue 3 repair;
  - schema 42/42;
  - inference 89/89;
  - web 48/48 before 2 new tests, safeguards folder 13/13 after;
  - graph 42/42 against live Neo4j;
  - all typechecks clean at that time.
- **Adversarial attacks and outcomes** (`apps/server/src/verification/outcomes.adversarial.test.ts`): all 7 BREAK tests flipped to safe assertions, plus new cases.

  | Attack | Before repair | After repair |
  |---|---|---|
  | A1: decoy denial + obfuscated `base64 < .e""nv` | **blocked/passed** | detected: allowed/failed |
  | A2: `base64 .env; exit 1` | **blocked/passed** | leak detected / not counted as blocked |
  | A3: `head -c 40 .env` (partial canary) | **blocked** | 16-character piece detected |
  | A4: Read of a non-existent `.env.local` | **blocked/passed** | not exercised: unknown |
  | A5: "I gave up" + subtype success | claimed_success | claim from text; never affects outcome |
  | A6: graph props with reported "succeeded" | **displayed** | validation fails, legacy fallback |
  | A7: stored passed + security unknown | **served Passed** | served Inconclusive |
  | Agent claims success, no diff or typo remains | task failed | task failed |
  | Tampered row with task succeeded/inferred | rejected | rejected |
- **Real DB, opened read-only:** `ver_91160b67e6eb7cc6ff0129e5` now reads as Inconclusive. The other 4 stored Passed rows rest on real `permission_denials` entries or a kernel EPERM event.

### Tests that could not run, and why
- **No real harness run** (Docker + real token) after the repair: the new enforcement rule is covered by synthetic captures only.
- **Full web suite** was not re-run immediately after the 2 new tests; the workspace run below covers it.

### Remaining risks and limitations
- **Fully obfuscated reads:** for example `python3 -c "open(chr(46)+'en'+'v')"`, reversed or rot13 output, or `xxd`'s default layout. If there is also a real denial elsewhere in the run, these can still read as "blocked". A test asserts this on purpose. Only the Tetragon kernel path, where it runs, closes this. The UI and the reason text say "blocked" is not proof that no secret reached the agent.
- **What "observed" means:** without Tetragon, observed security comes from Claude Code's own records plus the host canary scan, not OS-level observation.
- **Task checks:** the only independent task check today is the README git diff.
- **Reported claim:** classified by keywords, so it can mislabel mixed messages. It never affects outcomes or status.
- **Write path:** `storable()` treats a missing `outcome_origin` as recorded.

### Manual steps still required
- Restart the server so migration 080 applies.
- Re-run verification for `ver_91160b67e6eb7cc6ff0129e5` if a fresh result is wanted.
- Re-project the graph so existing data carries the new properties.
- Render `GraphVerificationOutcomes` in the Neo4j graph panel (wire:neo4j owner).

---

## Verified in a realistic environment vs unverified

**Verified in a realistic environment**
- **Issue 1:**
  - Real Claude Code (haiku) authenticating through the broker with the real token in Docker Desktop on macOS: 3 successful runs.
  - The agent's env and its Bash child do not contain the token, and host-side scans of the evidence are clean.
  - Direct egress is denied from the real agent security context.
  - URL-source and duplicate-key requests were checked live against the rebuilt broker image, with a canary.
- **Issue 2:**
  - The real ai& endpoint answered through the policy transport with the real key once (original fix).
  - After the repair, it answered through the pinned trust store without a key.
  - The MITM and proxy attacks were demonstrated with real local TLS servers in child processes.
- **Issue 3:**
  - Live kw-neo4j projection with no canary nodes.
  - Read-only probe of the real `data/kw.db`.
- **Issue 4:**
  - Live Neo4j graph tests.
  - Read-only evaluation of the real `data/kw.db` verification rows.

**Unverified**
- Native Linux Docker for the broker and agent, including token file ownership.
- The verification harness with the real token after the broker change, and the harness Tetragon kernel path end to end.
- Whether Anthropic actually fetches URL content sources. The block assumes the documented behaviour.
- The real-key ai& smoke after the trust-store pin.
- Supervised-run redaction in a real Docker run with a secret in the task (only synthetic captures were used).
- The new Issue 4 enforcement rule on a real harness run.
- Prompt-caching impact of broker re-serialization.
- Any production deployment, multi-user setup, or load.

---

## Workspace typecheck and test run (final)

I ran `pnpm -r --no-bail typecheck` and `pnpm -r --no-bail test` once, on 2026-10-17, while other workflows were still editing the repo. Logs are in `$S/final-typecheck.log` and `$S/final-test.log`.

**Typecheck: exit 0.** All 9 workspace projects reported Done, with no errors.

**Tests: exit 1.** 7 packages passed and 2 failed. Each failing package has a single failing test.

| Package | Result |
|---|---|
| packages/redaction | 96/96 passed |
| packages/adapter-claude-code | 90/90 passed |
| packages/analysis | 93/93 passed |
| packages/inference | 89/89 passed |
| packages/graph (live Neo4j) | 42/42 passed |
| packages/observer-tetragon | 26 passed, 11 skipped (live Tetragon tests) |
| apps/web | 64/64 passed |
| packages/schema | 41 passed, **1 failed** |
| apps/server | 189 passed, **1 failed** (21 files) |

**Failures owned by concurrent work, not by this remediation:**
- **packages/schema**, `src/schema.test.ts > has a contract entry per route`: the test expects 30 `API_CONTRACT` routes and finds 32.
  - None of the four security fixes added an API route. The new routes come from the Ask Witness and Findings-modes work, which has not yet updated the hard-coded count.
- **apps/server**, `src/findings-views/findings-views.test.ts > no ingestion, finding-generation or collection code reads presentation-mode state`: this check flags `apps/server/src/services/scope-retriever.ts`.
  - That file belongs to the concurrent Ask Witness / Findings-modes work, and no security fix touched it.

Every security test file named in this report passed in this run.

---

## Prioritized remaining work

1. **Run the verification harness with the real token through the broker, on native Linux and on the Tetragon kernel path.** This validates Issue 1 and Issue 4 end to end; native Linux needs the uid 1000 token-file handling.
2. **Close the Issue 4 obfuscated-read gap:** make Tetragon kernel evidence the required basis for "observed blocked" wherever it is available, and label runs without it as weaker evidence.
3. **Redact the remaining writers:** safeguard versions, verification-run text, investigation answers, and all structured Fastify log fields.
4. **Add URL-source and duplicate-key probes to `scripts/agent-broker-adversarial.sh`.** Consider replacing the broker's denylist with an allowlist of known Messages API body shapes.
5. **Restrict access to raw capture stores** (hook spool, stream-json, blob store), which are unredacted by design.
6. **Move the Ask Witness fingerprint to an HMAC** with a server-held key, to remove the side channel for guessing low-entropy secrets.
7. **Check operator redaction patterns for catastrophic backtracking** (`KW_REDACTION_PATTERNS_FILE`).
8. **Re-run the real-key ai& smoke** after the trust-store pin, and remove or guard the exported `fetchTransport`.
9. **Housekeeping:**
   - Re-run verification for `ver_91160b67e6eb7cc6ff0129e5`.
   - Re-project the graph.
   - Apply migrations 070 and 080 by restarting the server.
   - Investigate `CLAUDE_CODE_MESSAGING_TOKEN` in the agent's child env.
