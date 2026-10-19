# Underwatch: UI redesign report

Verified 13:13–13:24 JST, 2026-10-17. The spec is `docs/UI-REDESIGN-PRD.md`, plus the parts of Addendum C that still apply. This redesign is a restyle of the existing app: no backend routes were rewritten, and no mock data was added. Nothing is committed; the restore point is `407181e`.

## What changed, by PRD section

- **§3 Visual direction.** The Foundation stage added shared design tokens (the palette from the PRD, Geist Sans and Geist Mono, a 4px spacing grid, subtle borders, motion of 120–220ms that respects reduced-motion) and a component set in `apps/web/src/components/ds/`: Button, CodeBlock, DataTable, Icon, Notice, Section, SegmentedControl, StatusPill and Tooltip. Pages use these components.
- **§4 Application layout** (`components/shell/`):
  - **Sidebar.** Measured at 232px expanded and 64px collapsed. The collapsed rail keeps icons, screen-reader labels and tooltips. The `[` key toggles it, and the browser remembers the choice. Below 768px it becomes an overlay that Esc closes.
  - **Top bar (56px).** Workspace popover (from `GET /api/workspaces`), breadcrumbs with the detail-page title, Search with Cmd/Ctrl+K, the existing Ask Witness drawer, API status shown with a symbol and text, and a Local session menu. Clearing the stored token asks for confirmation first.
  - **Banner.** The FIXTURE DATA banner and the "AI is advisory" note now share one compact strip.
- **§5 Navigation.** Overview, Findings, Agent Runs, Evidence Explorer, Ask Witness and Safeguards, with Settings at the bottom. The current item is marked with `aria-current` as well as visually. Each list page's URL filters are kept for the browser session.
  - **Command palette.** Searches only real records: runs through the server's text search; findings (the 500 most recent) and safeguards fetched once and filtered in the browser. It fetches nothing until it is opened.
- **§6 Pages:**
  - **Overview.** Sections are now "Needs your attention", Recent runs, Recent verification results, "Safeguards needing action" and Observation system. Every existing data field is still shown, including the totals and the fixture/live breakdown. There are no new metrics.
  - **Findings.** Daily Digest | By Task | Current State is now the shared segmented switch. Rows are denser and show severity and confidence separately. There are notices for refresh time, older snapshots, possibly stale data and incomplete lists. Refresh happens only when the user presses the button.
  - **Finding.** The switch reads "Quick Read | Full Technical Details", with Quick Read as the default; `?view=full` works and the choice is remembered.
    - **Quick Read** shows Problem, then the most relevant relationship (a small real graph and an "Open full graph" button), then Why it matters, then How to fix.
    - **Full Technical Details** groups the panels under Agent report, Observed evidence, Applicable policy and Interpretation, followed by Safeguards. Observed evidence opens with the Neo4j graph.
    - **"Ask about this issue"** opens a non-modal side panel holding the existing per-finding Ask Witness. It shows 4 suggested questions plus "More questions", and every answer offers More detail and Explain simply. Closing keeps the conversation.
  - **Graph.** Hovering a node highlights its connections. Added Zoom in, Zoom out and Fit buttons, a list of every node and link for keyboard and screen-reader users, and "open run" links. Colours are toned down, and the selected item uses the accent colour.
  - **Agent Runs.** Restyled runs list, run detail, two-lane timeline, evidence inspector, coverage panel and Start supervised run panel. Esc in the inspector now yields to an Ask Witness panel open on top of it, and closing the inspector returns focus to the event that opened it.
  - **Evidence Explorer (`/evidence`, new route, real data).** Pick one run or all runs (at most the 20 most recent, which the page says). Filter events by basis, source, outcome, event type and text, with the filters kept in the URL. Clicking an event opens the existing inspector. A Graph tab shows a chosen finding's evidence graph.
  - **Ask Witness (`/ask`, new route).** Choose a scope (all findings, one run, or one finding) and use the existing conversation and investigation history. Each history entry now shows its last question; that needed one additive `last_question` parser field in `api/scopedAsk.ts`, which the server already sends.
  - **Safeguards and Settings.** Restyled, with every panel kept. `components/safeguards/Workflow.tsx` adds a workflow legend.
- **§7 Status indicators.** Status pills always combine a symbol and text, and green is used only for "Verified for tested scenario".
- **§10 Responsive design and accessibility.** All 11 routes were checked at 400px with no horizontal overflow, and focus rings are visible (both measured in the browser).

## Fixes made during this verification

1. `components/askwitness/AskAboutIssuePanel.tsx`: after a suggested question was asked, its button unmounted and focus fell to `<body>`, so **Esc no longer closed the Ask panel**. I added a window-level Esc fallback that runs only when focus is on `<body>` and the evidence inspector isn't open. Verified in the browser: Esc now closes the panel, and reopening it keeps the conversation.
2. `components/askwitness/EvidenceRef.tsx`: long `evt_…` citation ids ran past the edge of the 420px Ask panel. They now wrap (`max-w-full break-all`). Verified: 0px overflow across 89 chips.

## Feature preservation

| Route / feature | Preserved? | Evidence |
|---|---|---|
| `/` Overview: recent runs, runs needing review, new and confirmed findings, safeguards awaiting approval, verification results (security vs task outcome), observation health, fixture/live labelling | Yes, sections renamed or merged | Every `data.*` field from the old page is still read; browser check found the sections and FIXTURE labelling |
| `/runs`: URL filters (q, agent, status, dates, has_findings, fixture), Start supervised run | Yes | `RunPages.test.tsx` 7/7; browser found Start supervised run and run links |
| `/runs/:id`: summary, task, policy, coverage, supervised run panel, findings table, timeline filters, inspector, Ask Witness at run scope, `?event=` deep link | Yes | Component usage confirmed in code; browser opened the inspector by click and closed it with Esc; "Ask about this run" present |
| `/findings`: three modes, refresh only on request, completeness notices, URL mode | Yes | Browser selected all three modes; Current State says it does not update on its own; Findings tests 15/15 |
| `/findings/:id`: every earlier panel (why flagged, reported vs observed cards, next step, graph, Ask Witness, safeguards, evidence refs, missing info, policy, actions, status history, run) | Yes, regrouped | Browser found all 11 headings in Full view; graph canvas and Neo4j source present; zoom and Fit work; view kept across reload |
| Neo4j graph | Yes, plus hover, zoom/fit, node and link list | `EvidenceGraphPanel.test.tsx` passes; canvas renders from a real Neo4j response |
| `/safeguards`: filters on approval, application and verification status and fixture; safeguard cards | Yes | Code confirmed; browser found safeguard links |
| `/safeguards/:id`: diff, edit as new version, reject, confirm-approve, rollback, verification (security vs task, "tested scenario") | Yes | Browser found verification, "tested scenario" and task-outcome wording |
| `/settings`: component panels, event collection, retention and redaction, data mode, credentials, workspaces | Yes | `SettingsPage.test.tsx` passes; browser found Neo4j, Event collection and Data mode |
| `*` NotFound | Yes | Route still in `App.tsx` |
| Global Ask Witness drawer | Yes | Still in Layout and the top bar |
| Auth: `?token=` capture, Bearer token, permission-denied state | Yes | Token removed from the URL after capture (browser); `Shell.test.tsx` covers clearing the token and the permission-denied path |
| New routes `/evidence`, `/ask` | Added, real data | Both render with no errors; tests 12/12 |

Routes in `App.tsx` before: `/`, `runs`, `runs/:id`, `findings`, `findings/:id`, `safeguards`, `safeguards/:id`, `settings`, `*`. After: the same, plus `evidence` and `ask`. No regressions were found.

## PRD sections 1–10

| § | Result | Evidence |
|---|---|---|
| 1 Vision | Pass | The "reported vs observed" message stays central: honesty labels, Agent report / Observed evidence split, FIXTURE badges |
| 2 Principles | Pass | Shared components; observed, derived and inferred stay distinct |
| 3 Visual direction | Pass | Palette and Geist from shared tokens; screenshots d01–d15 |
| 4 Layout | Pass | Sidebar measured 232/64px; top bar 56px; non-modal Ask panel and inspector |
| 5 Navigation | Pass | All 7 nav links, `aria-current`, Cmd+K: a search for "env" returned 18 real results and Enter opened the finding |
| 6 Pages | Pass | All pages render with 0 console errors and 0 HTTP 4xx/5xx responses |
| 7 Tables and status | Pass | Status shown as symbol plus text; long values truncated with the full text on hover |
| 8 Graphs | Pass | Real Neo4j data; hover, zoom, Fit, inspector and node/link list; no invented nodes |
| 9 Forms and actions | Pass, existing flows unchanged | Confirm dialogs for approve, rollback and clear token kept |
| 10 Responsive and accessibility | Pass | No horizontal overflow on any of 11 routes at 400px; mobile nav opens and Esc closes it; every Tab stop showed a focus ring |

Addendum C items still in force:
- **Quick Read | Full Technical Details:** pass.
- **Contextual chatbot:** pass. A live question was answered in the panel with citations, and More detail and Explain simply were offered.
- **Graph near the top:** pass. In Quick Read the graph is the second block, starting about 527px from the top at 1440×900. In Full view it is the first item under Observed evidence.

## Test totals (all actually run)

- **Typecheck (`pnpm -r typecheck`):** all 9 packages pass, rerun at 13:23 after my fixes.
- **Web tests (`apps/web`, vitest):** 17 files, 136/136 pass, rerun at 13:23. The baseline before Addendum C was 64 tests in 8 files.
- **Full suite (`pnpm -r --no-bail test`):**

  | Package | Result |
  |---|---|
  | schema | 49 pass |
  | redaction | 96 pass |
  | adapter-claude-code | 90 pass |
  | graph | 41 pass, 1 fail |
  | observer-tetragon | 26 pass, 11 skipped |
  | web | 136 pass |
  | analysis | 97 pass |
  | inference | 93 pass |
  | server | 222 pass, 1 fail |

- **The two failures:**
  - **`packages/graph/src/graph.live.test.ts`** (cross-run recurrence) was already failing in the baseline before Addendum C. The shared live Neo4j holds a real finding, `fnd_dc8f41e28de90b270b713277`, that adds a recurrence row the test doesn't expect. `packages/graph` is unchanged since `407181e`.
  - **`apps/server/src/test/graph-key-relationships.test.ts`** failed only when it ran in parallel with the graph live test against the same Neo4j. Run on its own it passes 5/5.
- **Build (`vite build`, output to `scratchpad/build-verify`; `dist` untouched):** succeeds. The main JS file is 1,230.56 kB (362 kB gzipped), which triggers the existing over-500 kB warning.
- **Headless Chrome check (`scratchpad/browser/pw/ui-verify.mjs`):** 17 steps and 113 checks, all passing after the fixes above, with 0 page errors, 0 console errors and 0 HTTP 4xx/5xx responses. The token was passed with `?token=` and never printed or saved.

## Screenshots

In `/private/tmp/claude-501/-Users-oguzkirmizi-Desktop-academics-hackathons-81agents/e12806d6-35d1-4210-8dab-a807163465a2/scratchpad/ui-redesign/`.

**1440×900:**
- Overview: `d01-overview.png`
- Findings: `d02-findings-{digest,task,current}.png`
- Finding, Quick Read: `d03-finding-quick.png`, `d03-finding-quick-fold.png`
- Ask about this issue: `d04-finding-ask-panel.png`, `d04-ask-answer.txt`, `d04b-ask-panel-long-ids.png`
- Finding, Full Technical Details: `d05-finding-full.png`
- Agent Runs: `d06-runs.png`, `d07-run-detail.png`, `d07b-run-inspector.png`
- Evidence Explorer: `d08-evidence.png`
- Ask Witness page: `d09-ask.png`
- Safeguards: `d10-safeguards.png`, `d11-safeguard-detail.png`
- Settings: `d12-settings.png`
- Sidebar collapsed: `d13-sidebar-collapsed.png`
- Command palette: `d14-cmdk.png`
- Keyboard focus: `d15-focus.png`

**400×860:** `m01-overview` to `m11-settings` (every route), plus `m12-nav-open.png`. The page scrolls inside the main area, so these show the first screen only.

Results are in `results-merged.json`.

## Limitations and open decisions

- **Reported vs observed comparison.** The old side-by-side "Reported vs observed" panel is now split: the agent's events are under Agent report, the observed events under Observed evidence, and derived events under Interpretation. The wording and records are the same, but the side-by-side comparison, the core demo message, is no longer on one screen. The finding-page agent offered to put the old panel back at the top of Full view. **This needs your decision.**
- **Sampling limits.** The command palette searches only the 500 most recent findings, and Evidence Explorer's "All runs" loads at most 20 runs. Both say so on screen.
- **Bundle size.** The main JS file is still 1.23 MB; code splitting was not attempted.
- **Not exercised.** Approving, rolling back or verifying a safeguard and starting a supervised run were not clicked in this pass, because they change real data. Their code paths are unchanged and covered by unit tests.
- **Concurrent edits.** The Overview and Safeguards/Settings agents (workflow `wf_de0e915c`) may still be editing. A typecheck, test and build rerun is needed just before committing.

Files I changed in this pass:
- `/Users/oguzkirmizi/Desktop/academics/hackathons/81agents/apps/web/src/components/askwitness/AskAboutIssuePanel.tsx`
- `/Users/oguzkirmizi/Desktop/academics/hackathons/81agents/apps/web/src/components/askwitness/EvidenceRef.tsx`
