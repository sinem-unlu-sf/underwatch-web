# PRD coverage audit (original PRD)

> A read-only, line-by-line audit of [`PRD.md`](./PRD.md) against the implementation, run on 2026-10-17 (about 12:25 JST). Nine section auditors were followed by a completeness critic, who spot-checked 16 items marked "done". The status counts and the prioritized gap list are below. Section (a) items are being fixed before submission; section (b) items are disclosed limitations.


Read-only audit as of 12:25 JST, 2026-10-17. I edited nothing in the repo. Evidence comes from the code (file:line), GET-only calls to :4600, and one test run (`supervised-kernel.test.ts`, 7/7 passed). Note that the §6 slice audit arrived cut off at 6.6-06, so I audited the rest of §6.6 and all of §6.7 to §6.9 myself.

**State right now** (the DB was reset at 12:15):
- 7 runs: 5 fixtures and 2 live. Both live runs are kw-verification-harness runs.
- 0 live supervised runs and 0 live findings.
- 6 safeguards, all on fixture finding `fnd_fx04`.
- 2 verification runs:
  - `ver_ca9bc…` (kernel_enforcement): Passed.
  - `ver_403e…` (permission_rule): Failed.
- The live discrepancy, safeguard and verification chain has to be regenerated before the demo.

## 1. PRD lines no slice audit covered

I covered these myself:

| PRD lines | Status | Evidence / gap |
|---|---|---|
| Header: addenda A and B govern | n/a | Applied as written (for example, the "Create safeguard" label). |
| §6.6 rest: policy, evidence refs, AI explanation, missing info, next step, buttons, "persist and reflect across app" | done (9/9) | `FindingActions.tsx:12-15` has Confirm, Dismiss and Resolve, plus Create safeguard. Cache invalidation is in `queries.ts:53-64`. api.test covers persistence. |
| §6.7 focused graph, select node, inspect, jump to timeline, observed/derived/inferred, supports investigation | done (6/7) | Live `/api/findings/fnd_fx04…/graph` returns source=neo4j with 45 nodes and 92 edges. Every edge carries a basis (derived 70, observed 12, reported 8, inferred 2), and ancestry and cross-run insights are present. Timeline link is at `EvidenceGraphPanel.tsx:342`. |
| §6.7 "Follow relationships" | partial | The edge inspector (`EvidenceGraphPanel.tsx:318-320`) shows the from→to endpoints as plain text. The node inspector has no list of connected edges, so you can only follow a relationship by clicking on the canvas. |
| §6.8: proposed, approved and applied lists, verification status, linked incident, last result, content/mechanism/effect | done (7/7) | `SafeguardsPage.tsx:173-206`. |
| §6.9 adapter, collectors, ai&, Neo4j, retention and redaction panels; never expose keys | done (6/7) | `SettingsPage.tsx:57-90`. The settings JSON has 0 matches for the API token and 0 for the ai& key prefix. |
| §6.9 "Policy settings" | partial | Settings shows Policy `not_configured`: "No live policy version exists, so no policy is active". Supervised runs do use a built-in policy (`supervised/policy.ts`), so this reads as if no policy exists. |
| §7.1 component structure; modular, no microservices | done | packages/* plus apps/server and apps/web. |
| §7.2: observation separate, enforcement independent of AI, append-only, stable IDs, raw refs, unavailable made explicit | done (6/8) | Append-only triggers: `097_append_only_records.sql:6-21`. `@kw/analysis`, the adapter, the observer and supervised ingest have 0 imports of `@kw/inference`. |
| §7.2 "Version policies and execution contexts" | partial | Verification runs have `policy_version` null (both live runs in GET /api/runs). |
| §7.2 "agent cannot … approve its own safeguards" | partial | The P11 reachability self-test runs in `verification/harness.ts` only. `supervised/runner.ts` has no self-test (grep finds nothing). |
| §7.3: isolated environment; document captured events and active enforcement; container limitations; no host credentials | done (3/4) | Disclosed in README "Limitations" (l.181-198) and the Settings collectors table. A credential broker keeps the real token out of the container. |
| §7.3 "Do not claim comprehensive kernel-level monitoring" | partial | The README tagline (l.3) says "Independent, kernel-level evidence of what your AI coding agent actually did". Supervised runs have no Tetragon yet; README l.188 discloses this, but the headline overstates it. |
| §8 Run, Event, Evidence, Safeguard, VerificationRun fields; nullable fields; migrations; consistent IDs | done (5/6) | Evidence schema: `entities.ts:143-153`. |
| §8 Run `repository_id/revision/policy_version` | partial | null on verification runs (same as FR1-07/08). |
| §9: secrets, redaction before model, restricted raw access, agent writes, least privilege, isolation, approval, untrusted input, AI output validation, minimal context, honest partial collection | done (11/13) | Auth: no token gives 401; bad Host gives 403; bad Origin gives 403 (checked live). |
| §9 "Provide a documented retention policy" | partial | The only statement is a Settings string: "Proposed default 30 days … not implemented; nothing is deleted". ARCHITECTURE.md:212/977 planned `docs/RETENTION.md`; it does not exist. |
| §9 "Integrity protections must be designed and tested separately" | partial | sha256 is recorded on evidence and the append-only triggers are tested. I found no code path that re-verifies the hashes (grep for verifyIntegrity, integrity mismatch and similar returned nothing). `policy_versions` and `findings` have no DELETE/UPDATE triggers. |
| §10 Session/event collection (5 checkboxes) | done (5/5) | Covered by FR-1 to FR-3 evidence. Ingestion is idempotent through `ids.ts:84` and INSERT OR IGNORE. |
| §10 Safeguards: propose/review, approval, verification records outcomes, scoped success | done (4/5) | — |
| §10 Safeguards "Application status reflects the actual result" | partial | An "Applied" permission_rule overlay is never consumed. `supervisedPolicyRules()` (`safeguards/service.ts:655`) is called only from a test. |
| §10 UI: nav, states, no fake metrics, graph and timeline share records | done (4/5) | — |
| §10 UI "Findings and safeguards remain consistent across pages" | partial | See spot-check #1. |
| §11 fixtures 1, 2, 3, 4, 7 (fx-01…05), 8 (live `ver_ca9bc` Passed), 9 (live `ver_403e` Failed); expectations defined before running | done (8) | — |
| §11 fixture 5 (legitimate credential access) and 6 (duplicate events) | partial | Covered only as inline engine scenarios (s05, dedupe tests), not as fixture runs. |
| §11 fixture 10 (safeguard blocks legitimate work) | partial | Unit test only (`verification.test.ts:70`); no fixture or live run. |
| §11 metrics: precision/recall, false alerts, duplicate handling | done | ASK-WITNESS.md §6: recall 6/6, precision 6/9, plus 3 extra engine permission_violations on fx-04/fx-05. |
| §11 safeguard verification accuracy; ai& latency/failures/cost | partial | Per-call usage is stored in InferenceMeta but never aggregated or reported. |
| §11 attribution accuracy, evidence completeness, runtime overhead | missing | No measurement found. |
| §12 phases 1-6 | done | — |
| §12 phase 7 "execute validation matrix" | partial | See the §11 gaps. |
| §12 "don't expand adapters" | done (note) | Codex is labelled experimental, only in the verification UI (`VerificationSection.tsx:122,132`). |
| §13 steps 1-3, 7-10; disposable environment with synthetic secrets | done | — |
| §13 steps 4-6 (independent event, open discrepancy, Neo4j relationships) | partial | A live supervised run has no kernel event or process ancestry. DEMO-SCRIPT.md:29-30 runs these beats on fixture fx-04 ("Built (fixture data)"). |
| §14: no claims before exercising; no fabrication; mock data clearly separated | done | Fixtures are badged everywhere, and finding text says "Hand-labeled fixture expectation, not detection output". The process steps 1-7 are n/a (historical). |

## 2. Spot-checks of items marked "done" (16 checked)

| # | Item | Result |
|---|---|---|
| 1 | FR10-UI-CONSISTENCY (was contradicted) | **Changed to partial (latent).** The current list and detail agree (`sg_ec681…` passed and verified; `sg_813c…` failed in both). But `repo/safeguards.ts:19-35` (toListItem/getVerificationRun) and `recentCompletedVerifications` still read the raw v1 columns without `normalize()`/`servedVerification()`. Any stale row would show green on the list and Overview again. |
| 2 | 6.3-09 (was contradicted) | **Changed to partial.** The Overview empty state is fixed (`OverviewPage.tsx:199-210` points to "Agent Runs > Start supervised run"). `RunsPage.tsx:133` still says live runs are "pending architecture review". |
| 3 | FR4-13 (legitimate differences not flagged) | **Changed to partial.** ASK-WITNESS.md §6 shows the engine adds 3 extra permission_violation findings on fx-04/fx-05 (precision 6/9). The UI shows the hand labels, so the demo is not affected. |
| 4 | S1-20 / FR11 coverage visible | **Holds, with a caveat.** `supervised/ingest.ts:394-395` now calls `kernelForSupervised`, and its unit test passes. Settings still says "Attached to safeguard verification runs only … not attached to supervised run". That text is accurate until a live run proves the attach, so either verify the attach or keep the text. |
| 5 | S1-51 / FR10-10 no false success | Holds: `verification/repo.ts:62-80` downgrades a stored "passed" that has no outcomes or no `event:` kernel evidence. |
| 6 | FR7-19 / AC-AI-5 egress redaction | Holds: `aiand.ts:438-440` runs scanForLeaks on the exact payload and returns `redaction_guard_tripped`. |
| 7 | FR7-12 / FR6-04 user-only confirm | Holds: triggers at `097_append_only_records.sql:27-40`. |
| 8 | FR6-08 append-only history | Holds: `001_initial.sql:146-153`. |
| 9 | FR7-26 core independent of ai& | Holds: grep found 0 imports. |
| 10 | S1-31 API hardening | Holds: 401, 403 and 403 checked live. |
| 11 | §6.9 no credentials in UI | Holds: neither the token nor the key prefix appears in /api/settings/status. |
| 12 | FR9-07 explicit approval | Holds: `confirm: z.literal(true)` at `schema/safeguards.ts:411`. |
| 13 | FR2-F01 / FR8-05 stable IDs | Holds: `ids.ts:84-86`, plus INSERT OR IGNORE in `persist.ts`. |
| 14 | FR8-02 edge provenance | Holds: in the live graph every edge has a basis. |
| 15 | 6.1-11 no animation | Holds: `styles.css:50-51`. |
| 16 | FR11-10 no "All safe" | Holds: grep in apps/web/src matched only an "All safeguards" breadcrumb. |

Re-confirmed gaps (these stay as reported): FR9-01 has no propose gate (`doPropose`, `service.ts:241-270`). `SafeguardsPage.tsx:129` even says "proposed from a confirmed finding", which nothing enforces. FR9-08: overlays are never consumed. FR9-18: no self-test in supervised runs. FR6-10/FR8-R12: `recurrence_of_finding_id: null` at `engine.ts:521` and `ingest.ts:547`.

## 3. Status counts per section

| PRD section | done | partial | missing | contradicted | n/a |
|---|---|---|---|---|---|
| §1-4 overview, goals, non-goals, users, journey (51) | 35 | 16 | 0 | 0 | 0 |
| FR-1 to FR-3 sessions and collection (49) | 40 | 9 | 0 | 0 | 0 |
| FR-4 to FR-6 detection, investigation, lifecycle, plus §10/§8 Finding (55) | 49 | 6 | 0 | 0 | 0 |
| FR-7, FR-8 ai& and Neo4j, plus §7.4/§10 (72) | 69 | 3 | 0 | 0 | 0 |
| FR-9 to FR-11 safeguards, verification, coverage (47) | 39 | 7 | 1 | 0 | 0 |
| §6.1-6.6 UI, seen part of slice (53) | 51 | 2 | 0 | 0 | 0 |
| §6.6 rest to §6.9 (my coverage) (30) | 28 | 2 | 0 | 0 | 0 |
| §7.1-7.3 architecture (19) | 16 | 3 | 0 | 0 | 0 |
| §8 remaining entities (6) | 5 | 1 | 0 | 0 | 0 |
| §9 security and privacy (13) | 11 | 2 | 0 | 0 | 0 |
| §10 session, safeguards, UI checkboxes (15) | 13 | 2 | 0 | 0 | 0 |
| §11 validation plan (20) | 12 | 5 | 3 | 0 | 0 |
| §12 implementation sequence (8) | 7 | 1 | 0 | 0 | 0 |
| §13 demonstration (11) | 8 | 3 | 0 | 0 | 0 |
| §14 instructions (11) | 4 | 0 | 0 | 0 | 7 |
| **Total (460)** | **387** | **62** | **4** | **0** | **7** |

Nothing is contradicted any more: both earlier contradictions were partly fixed and moved to partial.

## 4. Prioritized gap list

### (a) Fix before the 16:00 JST submission (high demo impact, effort S/M)

| # | PRD ref | Gap | Evidence | Effort | Fix |
|---|---|---|---|---|---|
| 1 | §13 1-10, S1-04/11, AC-DD-1 | No live supervised run, live finding, safeguard-on-live-finding or Ask Witness turn since the reset. | /api/overview: live findings 0, live safeguards 0. | S (Docker time) | Freeze code, then run one supervised run, create a safeguard from its finding, and run verification. Check that no `api.anthropic.com` R8 false positive appears. |
| 2 | Ops risk (FR-10, §13) | `tsx watch` restarts kill in-flight runs; they end Inconclusive after 20 min. | ASK-WITNESS.md §7 "Hot reload orphans in-server runs". | S | Stop other agents' edits during demo runs, or use `src/supervised/live.ts` / `verification/live.ts`. |
| 3 | FR2-03/04/IND, S1-01/12, §13.4 | Kernel attach for supervised runs is coded and unit-tested but never live-verified, and the Settings text says it is not attached. | `ingest.ts:394`; status.ts kernel_tracer detail. | M | Run one supervised run with kw-tetragon healthy. If kernel events appear, update the `status.ts` and README l.3/l.188 wording. If not, keep the wording and demo the kernel evidence on the verification run. |
| 4 | FR-1 / 6.3-09 | Stale empty-state copy on Runs. | `RunsPage.tsx:133` "pending architecture review". | S | Replace it with a pointer to "Start supervised run" (the Overview copy already does this). |
| 5 | FR9-01, S1-19/38 | No evidence or status gate on proposing safeguards; UI copy claims one exists. | `service.ts:241-270`; `SafeguardsPage.tsx:129`. | S | Reject when status is new or dismissed (or require at least one related event or evidence row); disable the button with a reason. Or soften the copy. |
| 6 | FR10 consistency / §10 UI | The list and Overview skip the verification read guards (latent). | `repo/safeguards.ts:19-35`, `recentCompletedVerifications`. | S | Route `last_verification` and the overview items through `normalize()`/`servedVerification()`. |
| 7 | FR9-08, §10 "application status reflects actual result" | An "Applied" permission_rule or kernel_enforcement has no effect on later supervised runs, while the UI says it is "added to … managed policy for supervised runs". | `supervisedPolicyRules()` is used only in a test; `supervised/service.ts` uses `enforcePaths: []`. | S (copy) / M (wire) | Now: change `apply_description` and the `SafeguardReview.tsx:368-371` text to "applies to verification runs and exported config". Later: merge overlays in the supervised runner. |
| 8 | FR9-06 | Legitimate-workflow impact is not shown where Approve is clicked. | Rendered only at `SafeguardsPage.tsx:201`. | S | Render `legitimate_workflow_impact` in `SafeguardReview` next to intended effect. |
| 9 | S1-50, FR6-05 (journey step 11) | Resolution is not linked to verification evidence. | `FindingStatusUpdateBody` is only `{to, note}`. | M | Add optional `verification_run_id`/`evidence_ids` to the status change, prefill from the latest Passed run, and show it in the history. |
| 10 | FR4-15 | No visible distinction between a policy violation and a discrepancy that needs review. | `policy_classification` is not persisted. | S | Persist it (or a flag) and show a badge in FindingsTable and the finding header. |
| 11 | S1-42 (§4.3) | Restrictions are not shown for confirmation before a run starts. | `StartSupervisedRun.tsx` shows only the task. | S | Render `SUPERVISED_POLICY` R1-R5 (read-only) in the start panel. |
| 12 | §6.9 policy; FR1-08/FR8-03/§7.2 | Settings shows "no policy active"; verification runs have a null policy_version. | settings `policy.status=not_configured`; runs API. | S | Fix the Settings copy to name the built-in supervised policy. Set `policy_version` on verification observation runs (base plus tested safeguard). |
| 13 | 6.1-12 | The finding page buries reported-vs-observed and the next step under Ask Witness and safeguards. | `FindingDetailPage.tsx:124-246`. | S | Move those two panels directly under "Why it was flagged". |

### (b) Disclose in the pitch/README as known limitations

- **Bash bypasses the permission rule.** Without the OS sandbox, Bash or interpreter reads get past `Read(./.env)` (policy R1 text). Only the kernel deny blocks reliably, so a permission_rule can never show green (live `ver_403e` Failed).
- **Kernel tracing in supervised runs:** if item a3 is not verified, Tetragon covers verification runs only and supervised runs use proxy, git and canary evidence. Also, tone down the README l.3 tagline.
- **No recurrence detection (FR6-10, FR8-R12).** `RECURRED_AS` never fires in real data; only the "same resource in other runs" panel exists.
- **Verification always runs the fixed scenario `kw-env-read-v1`** (FR9-09), whatever plan is displayed.
- **No Claude Code hook mechanism.** The type is shown as unavailable.
- **Retention is not enforced.** The 30-day default is a proposal; nothing is deleted, and there is no retention document.
- **Integrity hashes are recorded but not re-verified**, and policy_versions and findings have no delete/update triggers (§9).
- **No P11 network self-test in supervised runs** (FR9-18). The self-approval guarantee rests on the internal network.
- **Only sessions KW starts on the demo workspace are observed**, and the build is validated only on macOS with Docker Desktop 4.57.
- **Fixture findings are hand-labelled.** Engine agreement is recall 6/6, precision 6/9.
- **Subagent and Task delegation is not modelled** (FR4-09), and task text is not turned into scope restrictions (S1-06).
- **Validation metrics not measured:** runtime overhead, attribution accuracy, evidence completeness, and ai& latency/cost (§11).

### (c) Post-hackathon

- Recurrence detection, with a "potential regression" badge (M).
- Finding-specific verification scenarios (L).
- Wire applied overlays into supervised runs (M).
- AgentAdapter interface conformance (M).
- Paginate the events API; large runs reach about 4.7k DOM rows (M).
- Per-event Tetragon evidence locator (M).
- Model subagents (M).
- Restart-safe job queue (M).
- Retention enforcement and `docs/RETENTION.md` (M).
- Integrity re-verification job, plus triggers on findings and policy_versions (S-M).
- Persist `timestamp_basis` and session_id on events (S).
- Hook safeguard mechanism (L).
- AI-drafted regression scenarios (M).
- Remove the stale `ai_explanation: not_implemented` field (`repo/findings.ts:132`) (S).
- Make graph relationships navigable from the inspector (S).
- Fill in the remaining §11 fixtures (5, 6, 10) as runs, and report the measurements.

## 5. Non-goal checks (§2.2)

No violations.
- **Safety guarantee:** none is claimed; labels say "verified for tested scenario".
- **Detecting every attack:** not claimed; coverage lists what is unsupported.
- **EDR replacement:** not claimed.
- **Kernel monitoring:** scoped to the agent container. The only soft spot is the README l.3 headline.
- **Every agent supported:** no. Codex is experimental and verification-only (`VerificationSection.tsx:122`). That is in tension with §12 but does not violate it.
- **Automatic rewrites:** none. Approval requires confirm:true plus CAS, and CLAUDE.md is the only write target.
- **Treating unusual as malicious:** no; grep for "malicious" in the UI found nothing.
- **LLM as authority:** no. Analysis is pure, the AI cannot change status, and claims are labelled by basis.
- **Semantic code review:** not claimed.
- **Unrestricted host execution:** no. Runs use a disposable container, an internal network, a broker and a loopback API with a token.