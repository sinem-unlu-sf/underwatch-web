# Fixtures

Everything in this directory is **synthetic and hand-authored, for UI development only**.

- Fixture runs were not captured from any real agent session or collector. They exist so the interface can be explored
  before the Claude Code adapter and independent observers are built.
- Every record in a fixture file carries `is_fixture: true`, and the UI badges fixture-derived data. Fixture contents
  must never be presented as live telemetry, measured precision/recall, or verification results.
- Format: one JSON file per run in `runs/`, validated by `FixtureRunFile` in `@kw/schema`
  (`packages/schema/src/fixture.ts`). Event IDs must equal `makeEventId(...)`, so files are best produced by a small
  generator script that imports `@kw/schema`.
- Load into the local database with `pnpm seed:fixtures`.

## Runs

| File | PRD §11 case | Coverage | Expected findings (hand-labeled) |
| --- | --- | --- | --- |
| `fx-01-matched-legitimate.json` | 1: reported matches observed | complete | none |
| `fx-02-unreported-change.json` | 2: observed action missing from reports | complete | change_mismatch (medium/high, new), unreported_observed_action (medium/high, new) |
| `fx-03-env-read-blocked.json` | 3-4: forbidden access, blocked | complete | permission_violation (medium/high, confirmed by a reviewer) |
| `fx-04-env-read-via-bash.json` | 3-4: forbidden access, succeeded | complete | permission_violation (high/high, new), outcome_mismatch (high/high, new), plus one proposed permission-rule safeguard |
| `fx-05-telemetry-gap.json` | 7: missing telemetry, uncertain attribution | partial | uncertain_correlation (low/low, unresolved) |

Every run shares the synthetic policy `pol_fx_policy_v1` ("policy-v1"), repository `fixture/demo-repo`, and the synthetic
secret `KW_SYNTHETIC_SECRET=kw-test-0000` (redacted in excerpts). Hook and transcript excerpts copy the field names
of real Claude Code hook payloads (`session_id`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`,
`tool_response`, `duration_ms`, `hookSpecificOutput.permissionDecision`, transcript `toolDenialKind` /
`permissionDecision`), but every value is invented.

## Regenerating and validating

`fixtures/` is not a workspace package, so run its scripts with the server package's `tsx`:

```sh
pnpm --filter @kw/server exec tsx ../../fixtures/generate.ts   # rewrites runs/*.json from scenarios/*.ts
pnpm --filter @kw/server exec tsx ../../fixtures/validate.ts   # schema + cross-file checks, exits 1 on failure
pnpm --filter @kw/server exec tsc -p ../../fixtures/tsconfig.json   # typecheck the scripts
```

Edit `scenarios/fx-0N.ts`, never the JSON by hand. `lib/builder.ts` computes event IDs with `makeEventId` and numbers
evidence lines (`fixture://fx-04/observed.jsonl#L5`); output is deterministic, so regenerating unchanged scenarios
produces byte-identical files.
