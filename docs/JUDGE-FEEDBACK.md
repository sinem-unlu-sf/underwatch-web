# Judge feedback (Addendum C): implementation notes (verified 13:00 to 13:13 JST, 2026-10-17)

Addendum C is implemented and the Definition of Done items pass on the running app. Typecheck is clean. Tests: 851 passed, 1 failed, 11 skipped. The one failure is the same live-Neo4j data test that failed before the changes. I found no regression against the inventory. Nothing is committed and there is no new migration. One caveat: a UI redesign was being edited in parallel while I checked, so the page is still changing.

## What changed, by Addendum C section

**Section 3: two levels of detail**
- **Brief API (server):** `GET /api/findings/:id` gains an optional `brief` field. All existing fields are unchanged, and a test checks the response equals the old one. New route `GET /api/findings/:id/brief` returns 200, 404 for an unknown finding, and 401 without the token.
- **How the brief is built:** no AI (`deterministic: true`). It is computed on each read from the stored finding, events, evidence, policy, coverage, safeguards and verification runs, and every copied string is redacted. It is never stored, so it cannot become a second source of truth.
- **Fix statuses:** each fix's status comes only from stored safeguard and verification rows. There is no "done" status. Guidance-only mechanisms (CLAUDE.md) are labelled "not enforced".
- **Uncertainty list:** covers fixture data, confidence below high, partial coverage, lossy kernel capture, unknown security or task outcome, no independent observation, and the finding's missing-information items.
- **Web:** the finding page has a "Level of detail" switch. The concurrent redesign renamed its labels from "Summary | Full technical details" to "Quick Read | Full Technical Details". The URL `?view=summary|full` wins over the remembered browser choice.
  - Quick Read shows the brief card (Problem / Why it matters / How to fix), the safeguard progression, the key or most relevant relationship, the Ask entry, and the Actions, Status history and Run panels.
  - The full view keeps every existing panel.

**Section 4: contextual chatbot**
- This extends the existing Ask Witness; it is not a new chatbot.
- The judge's 8 suggested questions are added. The old 8 are kept under "More investigator questions".
- Optional `depth` (concise/detailed) and `style` (standard/simple) work on all three ask routes. The defaults are concise and standard, so old requests behave as before. Both are stored in the existing `ai_meta` column and are part of the cache key and the duplicate-request check.
- Prompt versions are now `kw.ask-witness@3` and `kw.ask-witness-scoped@2`.
- Every prompt now includes a block saying which actions the records confirm; anything unconfirmed reads "no record". The brief is included too, marked as a presentation of the same records and not citable.
- Every answer has "More detail" and "Explain simply" buttons.

**Section 5: Neo4j graph**
- `GET /api/findings/:id/graph` gains an optional `key_relationships` field, built only from the existing graph response plus stored records.
- New route `GET /api/findings/:id/graph/summary` returns 200, 404 or 401 like the brief route.
- At most 6 relationships are shown. Each carries a basis, and an inferred path says it is "a lead to check, not proof". When Neo4j is unavailable it says so honestly.
- The web shows the key-relationships strip, an "Open graph" button that switches to the full view and outlines the path's nodes, and links to runs, events, findings and safeguards.

**My change during verification**
- One wording fix in `apps/server/src/findings-brief/brief.ts` (`kernelFix`). It used to read "did not stop the the Read tool, then Bash (`cat .env`) bypass"; it now names only the last route: "did not stop the Bash (`cat .env`) bypass".
- The server typechecks, the 7 brief tests pass, and the live API serves the new text.
- I briefly added a `WorkflowLegend` to the Safeguards page. Another agent defined one locally at the same moment, so I reverted mine.

## Definition of Done

1. **Quick understanding: PASS.** In the browser, fx-04 in Quick Read shows Problem (agent, resource, rule R1, run), Why it matters (with terms explained), How to fix (3 fixes with statuses from the records), Evidence, Uncertainty, and the footnote "Built from the same records as the full report (9 events, 9 evidence records, 6 safeguards). Not independent evidence."
2. **Full investigation intact: PASS.** The full view still has Why it was flagged, Agent-reported, Independently observed, Recommended next step, the Evidence graph (Neo4j, 38 nodes / 90 relationships in list view), Ask Witness, Safeguards, Evidence references, Missing information, Policy, Actions, Status history and Run. The choice survives a reload.
   - The redesign moved the "Reported vs observed" panel into "Agent report" and "Observed evidence" sections. Its content is still there; only the heading changed.
3. **Contextual chatbot: PASS.**
   - "Can you explain this in simpler terms?" got a 3-sentence answer labelled "Concise · simple wording" (prompt `kw.ask-witness@3`, model deepseek-v4-flash, real ai& call, 32 evidence items sent).
   - The answer kept "backed by observed evidence" separate from "agent-reported only", with checked `evt_` citations. It correctly said the agent's "no secrets accessed" claim is contradicted.
   - "More detail" added a new turn in the same investigation. This passed twice.
   - The question chips now sit behind the new "Ask about this issue" button, which is why the browser's chip check reported FAIL; asking from there works.
4. **Graph easier to find: PASS.** The relationship section in Quick Read has 18 record links. "Open graph" switches to `view=full` and the graph renders. Fixture fx-04 is served from Neo4j.
5. **Grounded in the same evidence: PASS.** The brief is computed from the same rows as the full view, with no AI and fail-closed redaction. Chatbot claims are citation-checked, uncited claims are moved to unsupported, and unconfirmed actions read "no record".
6. **Existing features preserved: PASS** (details below).
7. **Tested and limitations documented: PASS.** Tests below; limitations at the end.

## Regression check against the inventory

- **GET routes:** all 28 return the same codes as the baseline: 26 are 200, the CLAUDE.md patch export on a non-CLAUDE.md safeguard is 400 (correct refusal), and `/api/verification-runs/none` is 404.
- **New routes:** `/brief` and `/graph/summary` return 200, 404 for unknown findings, and 401 without the token.
- **Pages:** Overview, Agent Runs, run detail (fx-04), Settings, Safeguards list and Safeguard detail (with verification) all render with no page errors and no HTTP 4xx.
- **Findings modes:** Daily Digest, By Task and Current State all work, the mode stays in the URL, and Current State's manual refresh works.
- **Token handling:** the token is removed from the URL after capture.
- **Safeguards page incident:** from about 13:02 to 13:08 the page crashed ("WorkflowLegend is not defined") while another agent was mid-edit. It was fixed by that agent and passes now.
- POST routes, auth controls, monitoring and enforcement code paths were not removed. The server's 223 tests (auth, redaction, safeguards, verification, supervised runs) all pass.

## Test totals

| | Passed | Failed | Skipped |
|---|---|---|---|
| Inventory baseline | 755 | 1 | 11 |
| Now | 851 | 1 | 11 |

- **By package now:** schema 49, redaction 96, adapter-claude-code 90, graph 41 (+1 failed), observer-tetragon 26 (+11 skipped), web 136, analysis 97, inference 93, server 223.
- **Typecheck:** `pnpm -r typecheck` exits 0. The baseline did not run it.
- **The one failure:** `packages/graph/src/graph.live.test.ts`, "cross-run recurrence". It is the same failure as the baseline: the shared live Neo4j has an extra row `[fnd_kwg_env_b, fnd_dc8f41e28de90b270b713277, false]` from a live run. It is a data-isolation issue in the test, not a code bug.

## Limitations and open items

- **Decision for the user:** two findings (fx-04 and the live finding `fnd_ca5a…`) show a fix as "Verified for tested scenario" while its safeguard is still only "Proposed" (not applied). The UI adds a "safeguard not applied" badge and spells out the stored records. If it should read "Safeguard proposed" until applied, that change goes in `apps/server/src/findings-brief/brief.ts`.
- The redesign was still landing during this check (new `components/shell/*`, renamed switch labels, restructured full-view headings). Results are as of 13:13 JST and need a re-check after it finishes.
- Not tested: the Neo4j-unavailable fallback in the browser (only unit-tested), POST routes beyond the two Ask calls, and a phone-width layout.
- Hooks are unavailable in this build, so no fix ever suggests a hook. The kernel and permission-rule fixes only appear when the policy has a deny rule with a concrete path.

Files are in `/private/tmp/claude-501/-Users-oguzkirmizi-Desktop-academics-hackathons-81agents/e12806d6-35d1-4210-8dab-a807163465a2/scratchpad/`:
- **Screenshots, page text and results:** `judge-check/` (15 screenshots, `results.json`, the two chat answers as `02-chat-simple-answer.txt` and `03-chat-more-detail-answer.txt`)
- **Logs:** `judge-check/typecheck2.log`, `judge-check/test2.log`
- **Browser script:** `browser/pw/judge-check.mjs`
