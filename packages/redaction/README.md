# @kw/redaction

Pattern-based secret redaction for everything Underwatch reads out of agent logs. It is pure: no I/O, no network,
no DOM or Node types. Configuration loading takes an injected file reader.

## Where it runs (redaction is the default)

| Boundary | What is redacted | Code |
| --- | --- | --- |
| Claude Code adapter (parse time) | Every free-text field copied out of hook, transcript and stream-json records: prompt, assistant text, final report, error text, Bash command / tool target, summaries, `detail.extra`, permission reason. The built-in redactor always runs. `ParseContext.redact` can only add more redaction. Only `rawMode: "unsafe_raw_for_restricted_blob_store"` turns it off. | `packages/adapter-claude-code/src/parse.ts` (`redactorFor`) |
| Tetragon observer (parse time) | argv (`process.arguments`), raw record JSON, raw summary | `packages/observer-tetragon/src/parser.ts` |
| Storage boundary (defense in depth) | All free text on runs, evidence (`excerpt`, `source_reference`), events (`summary`, `raw_summary`, `target_resource`, `process_name`, `limitations`), correlations, findings (`title`, `description`, `recommended_next_step`, `missing_information`), status-history notes, safeguards, and verification runs. This pass covers observed argv inside analysis finding text and any source that skips the adapters. | `apps/server/src/ingest/sanitize.ts`, called by `persistRunBundle` and by the Tetragon `ingestKernelObservation` |
| Supervised runs (`POST /api/runs`) | The task (stored in `runs.label` / `task_description` and `supervised_runs.task`), `supervised_runs.error` and `limitations` (harness / runner stderr text), the 202 response and the error log lines. The raw task is only handed to the executor in memory. | `apps/server/src/supervised/service.ts` (`start`), `apps/server/src/supervised/repo.ts` (`insertSupervised` / `updateSupervised`) |
| Finding status-change notes | The user-typed note | `apps/server/src/repo/findings.ts` |
| Ask Witness question | Redacted before it is sent to ai& and before it is stored | `apps/server/src/investigations/service.ts` |
| AI evidence bundle | Every untrusted string is redacted again, then truncated | `packages/inference/src/bundle.ts` |
| AI egress guard | The exact outbound payload is scanned with `scanForLeaks`; a request with a hit is not sent | `packages/inference/src/providers/aiand.ts` |

The Neo4j projection (`apps/server/src/graph/bundle-from-db.ts`) and the run/finding API read the stored rows, which
have passed one of the boundaries above. Text written by a path not listed above is not covered (see limit 6).

### Bounded cost

All built-in detector regexes are linear-time (the `key = "value"` and `scheme://user:pw@` scanners anchor at a word
start; before the repair they rescanned long identifier runs from every offset, which took about 64 s for 200 KB).
`safeRedact()` additionally caps one call at `maxLength` (default 1,000,000 UTF-16 units): the head is redacted and
the tail is withheld as `[REDACTION_WITHHELD: N more characters not stored]`, never stored raw. Operator patterns
(`KW_REDACTION_PATTERNS_FILE`) are not checked for catastrophic backtracking.

### Fail closed

`safeRedact()` never throws. If a detector throws, or the input is not a string, the result is `[REDACTION_FAILED]`
with status `"failed"`. The original is never returned. The storage sanitizer then:
- stores `[REDACTION_FAILED]` in the field;
- writes the per-record outcome to `record_redactions` (`clean` / `redacted` / `failed`, detector ids, field names, never values);
- for evidence, sets `redaction_status` to `withheld`;
- logs `table`, `id`, `field` and the error class name only.

IDs, timestamps, source, basis and hashes are never modified.

### Raw data

Raw records stay in the host-side capture files: hook spool, stream-json, transcripts and Tetragon slices. The
content-addressed blob store also holds raw data. The integrity hashes in evidence rows are computed over these raw
bytes. None of these locations is served by the API, projected to the graph or sent to AI. They are not redacted, so
access to `data/` and the capture directories must be restricted (file mode 0600 for blobs).

## Configuration

- `KW_REDACTION_PATTERNS_FILE`: path to a JSON file with extra patterns and extra known-secret env names:

  ```json
  {
    "patterns": [{ "name": "acme_token", "regex": "acme_live_[A-Za-z0-9]{16}", "flags": "i", "group": 0 }],
    "known_secret_env": ["ACME_SIGNING_SECRET"]
  }
  ```

  A bare array of regex strings is also accepted. Matches are reported as the `custom_pattern` detector. An invalid
  file throws `RedactionConfigError`, so a misconfiguration stops the process instead of silently storing data
  unredacted. Allowed flags are `i m s u`. A pattern that matches the empty string is rejected.
  Patterns are trusted operator input: a catastrophic-backtracking regex will slow ingestion.
- Known secrets: the values of `AIAND_API_KEY`, `NEO4J_PASSWORD`, `CLAUDE_CODE_OAUTH_TOKEN`, `KW_API_TOKEN`,
  `ANTHROPIC_API_KEY` (plus `known_secret_env`) are always redacted, including their base64, base64url, hex,
  URL-encoded, JSON-escaped and reversed forms. Values shorter than 8 characters are ignored.

`redactionOptionsFromEnv(env, readFile)` builds the options. The server caches them per process.

## Detectors

`synthetic_secret`, `known_secret` (exact), `private_key`, `jwt`, `aws_access_key`, `aws_secret_key`, `github_token`,
`gitlab_token`, `anthropic_key`, `openai_style_key`, `slack_token`, `url_credentials`, `auth_header`,
`env_secret_value` (`NAME=value`, `"key": "value"`, YAML `key: value` with a secret-ish name), `encoded_secret`,
`custom_pattern`, `split_secret`, and `high_entropy` (heuristic).

Contextual coverage: lower-case keys (`access_token=`, `_authToken=`, `password=`) are exempt only when the value looks
like a code identifier (no digits, dotted access, `name2`, word compounds); random-looking values are redacted. URL
query parameters `?sig= ?key= ?code= ?auth= X-Amz-Signature=` and secret-ish names, `Cookie:` / `Set-Cookie:` values of
8+ characters, and the headers `PRIVATE-TOKEN`, `X-Token`, `X-Auth-Token`, `X-Access-Token`, `X-Api-Token`,
`X-Gitlab-Token`, `X-Vault-Token`, `Api-Key`, `X-Goog-Api-Key`, `X-Amz-Security-Token` are redacted at any entropy.

`split_secret` rejoins wrapped output and re-runs the format detectors (and `encoded_secret`) on the joined text:
fixed-width lines (`fold -w N`, `base64 -w 76`, `xxd -p`) and the ASCII columns of `xxd` / `hexdump -C` dumps. Every
piece of a match is redacted; for dump lines the hex column of each affected line is redacted too. To avoid gluing
unrelated lines (`env` output) it only accepts matches over lines of equal width.

`encoded_secret` decodes one level of base64, base64url, hex (with or without `0x`) and percent-encoding. It covers
tokens of 20 characters or more, including the value after `name=`. If the decoded text matches any non-heuristic
detector, it redacts the encoded token. The AI egress guard therefore also blocks base64- or hex-wrapped keys.

Placeholders look like `[REDACTED:<detector>#<n>]`. Numbering is per redaction context. Text outside a match
(keys, quotes, newlines, JSON structure) is preserved.

## Limits of pattern-based redaction (read this)

Redaction lowers the risk of storing or forwarding a secret. It does not guarantee that no secret is stored. Known gaps:

1. **Unknown formats.** A credential with no recognizable prefix, assigned to an innocuous name, and with low
   character entropy is not detected. Examples: `pass_phrase_word horse-battery-staple-river`, a short PIN, or a
   password inside prose ("the password is tulip42"). The test suite asserts one such case as a known miss.
2. **Split secrets.** Wrapped output of equal-width lines and `xxd`/`hexdump -C` dumps of format-recognizable
   secrets are rejoined (`split_secret`). Still NOT covered: a value split across lines of unequal width, across log
   records, JSON fields or tool calls; `od -c` / `od -x` output (characters separated by spaces); JSON-escaped `\n`
   inside a single line; secrets that only `env_secret_value` or `high_entropy` would catch (key=value or unknown
   format) when split. In those cases a random tail usually trips `high_entropy`, but a fragment (for example the
   `sk-ant-oat01-KWCANAR` prefix) is left in place; the suite asserts one such case. Truncation is made safe: the
   adapter, the analysis engine (`clipAtToken`) and the AI bundle redact before cutting, or cut on token boundaries.
3. **Encodings.** Only one decoding level, and only base64/base64url/hex/percent-encoding of ASCII text. The scanner
   does not see gzip+base64, double base64, ROT13, XOR, Unicode escapes (`sk-...`), char-code arrays,
   concatenations (`"sk-" + "ant..."`) or encrypted blobs. Exact *known* secrets are matched in their common encoded
   forms regardless of format.
4. **High-entropy false negatives.** The heuristic needs at least 24 characters, a mix of letters and digits, and
   entropy at or above 4.2 bits/char (3.5 for pure hex of 32 characters or more). Exact 40/64-character hex values
   (git and sha256 ids), UUIDs and `toolu_`/`msg_`/`req_` ids are exempt by design. A secret that looks like one of
   these is missed.
5. **High-entropy false positives.** Random-looking non-secrets can be redacted: cache keys, nonces, content hashes
   of other lengths, minified identifiers. Filesystem paths are judged per segment, so `/tmp/<uuid>/notes.txt` is
   kept, but a random-looking path segment is still redacted. This can hide a resource name from correlation.
   Correlation keys (ids, timestamps, sources) are never touched.
6. **Only the pass that ran.** Text written before this change, or written by a code path that bypasses the
   boundaries in the table, is not covered. Known uncovered writers: safeguard versions (`safeguards/store.ts`, AI- or
   user-authored content), verification runs written by `verification/repo.ts`, workspace file changes and
   investigation answers (built from already-redacted inputs, not re-scanned at storage). Policy rule patterns and
   coverage reports are KW-authored and not scanned. Fastify log redaction covers the `err` serializer and
   `ApiHttpError` messages/details only; other structured log fields are not redacted by construction.
7. **Hash side channel.** The Ask Witness request fingerprint is a sha256 over the original question. This lets an
   identical retry replay. A low-entropy secret typed into a question could be confirmed by guessing.

## Tests

- `src/redact.test.ts`: corpus of detector positives and negatives.
- `src/canary.test.ts`: synthetic canaries (`sk-ant-oat01-KWCANARY-...`, `sk-KWCANARY-...`) in command output,
  `env | sort` dumps, multiline logs, single/double quotes, JSON-escaped, `Authorization` headers, base64, base64url,
  hex, URL-encoded and URL credentials. Also fail-closed behavior, operator patterns, and the documented misses.
- Downstream assertions live with their consumers:
  - `packages/adapter-claude-code/test/redaction.test.ts`
  - `packages/analysis/test/clip-redaction.test.ts`
  - `apps/server/src/test/redaction.test.ts` (SQLite, API, logs, Ask Witness outbound body)
  - `apps/server/src/test/redaction-graph.test.ts` (projection plan plus live kw-neo4j when reachable)
  - `apps/server/src/test/redaction-supervised.test.ts` (supervised runs: SQLite, API, logs, projection plan; finding notes)
- `src/redaction-repair.test.ts`: contextual lower-case keys, cookies, credential headers, split/wrapped output
  (`xxd`, `hexdump -C`, `fold`, `base64 -w 76`, `xxd -p`), no gluing of `env` lines, 200 KB performance bounds and the
  `maxLength` withheld tail.
