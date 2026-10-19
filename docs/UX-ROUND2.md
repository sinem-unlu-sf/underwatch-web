# UX round 2: landing, accounts, short reads, clean Overview, chat UI (verification report)

Round verified with no blockers, so I made no source edits. Typecheck and build pass. The full test suite has one failure, the same live-Neo4j test that already failed in the baseline. Every route and feature in the inventory is still reachable. Nothing is committed.

**1. Tests and build (actual results)**
- `pnpm -r typecheck`: all 9 projects pass.
- `pnpm -r --no-bail test`: 1,003 passed, 1 failed, 11 skipped (inventory baseline was 755 passed, 1 failed, 11 skipped).

| Package | Result |
|---|---|
| schema | 49/49 |
| redaction | 96/96 |
| adapter-claude-code | 90/90 |
| graph | 41 passed, 1 failed |
| observer-tetragon | 26 passed, 11 skipped |
| web | 175/175 (22 files) |
| analysis | 97/97 |
| inference | 93/93 |
| server | 237/237 (28 files, includes `accounts.test.ts`) |

- The one failure is `packages/graph/src/graph.live.test.ts` ("multi-hop: cross-run recurrence"). It fails because the shared live Neo4j contains a real finding (`fnd_dc8f41e28de90b270b713277`) that adds an extra row. The inventory recorded this same failure before this round, so this round's changes did not cause it.
- Web vite build: passes, output in `/private/tmp/claude-501/-Users-oguzkirmizi-Desktop-academics-hackathons-81agents/e12806d6-35d1-4210-8dab-a807163465a2/scratchpad/build-r2`. The only warning is about chunk size.

**2. Preservation (compared with the inventory and the redesign doc)**

| Before | Now | Status |
|---|---|---|
| `/` Overview | `/` is the landing page with no app shell; Overview is at `/overview`. An old `/?token=…` link saves the token and opens `/overview` (checked in the browser). The sidebar, Not Found link and launch URL point to `/overview`. | OK |
| Overview: Recent runs, New discrepancies | Agent Runs list; the Overview's "Needs your attention" shows the top 3 open findings and "All open findings (10)" | OK |
| Overview: Runs needing review | Top section of `/runs`, with real data (checked in the browser) | OK |
| Overview: Safeguards awaiting approval, Confirmed findings, Recent verification results (security vs task outcome) | Top of `/safeguards` (checked in the browser) | OK |
| Overview: Observation health table, data-mode labels | Settings; FIXTURE banner and badges still show | OK |
| Runs filters, Start supervised run, run detail | Unchanged; "Start supervised run" is present | OK |
| Findings: 3 modes | Daily Digest / By Task / Current State all render | OK |
| Finding detail | Quick Read now leads with the short read, "Agent said → Kernel saw" and the most relevant graph relationship; the longer brief sits in a collapsed "Longer explanation". Full Technical Details starts with "Reported vs observed" (Agent reported \| Independently observed) and still has the graph, evidence, missing info, policy R1, actions, status history and run. | OK |
| Safeguards, safeguard detail, Settings, Evidence Explorer, global Ask Witness drawer | All render; no sideways scrolling at 1440 or 400 | OK |
| API, auth and honesty labels | Additive only: new `/api/accounts/*`. The master token still works. Signup requires the master token or a matching setup code. reported/observed/derived labels, "verified for tested scenario" and the FIXTURE badges are all present. | OK |

**3. Browser checks (real headless Chrome, 1440x900 and 400x860; token and password never printed)**
- **Landing page:**
  - All 18 internal links work, with no Not Found: Sign up, Log in, Open the app, Open live demo (`fnd_ca5a…`), the fx-04 link, the footer links and the anchors.
  - Screenshots load (naturalWidth 1800). At 400px the lower ones are lazy-loaded and load on scroll.
  - No sideways scrolling.
- **Accounts:**
  - With a stored token, signup hides the setup-code field.
  - Signup goes to `/overview` with a session token, and the account menu appears.
  - Log out clears the token and goes to `/login`.
  - A wrong password gives the generic "Email or password is incorrect."
  - The right password goes to `/overview` with a session token, and the app pages load with that token alone.
  - `demo+kw@example.com` was created on the first pass. A re-signup now returns 409. Its random password was never printed or saved, so I ran the full flow on `demo+kw-r2b@example.com` instead, and it passed.
- **Overview:**
  - Only "Needs your attention" plus the one-line summaries remain; the old panels are gone.
  - The three short reads are 128, 96 and 117 words as rendered (90, 70, … by the server's count).
  - For all 11 findings, the API's `short_read.word_count` is between 62 and 90, all within the 150 limit.
- **Overview Ask popup:**
  - The per-finding Ask button opens a panel with the short read and 4 suggested questions.
  - It answered a question in 5.5 seconds, with citations and "Sources & reasoning".
  - Esc hides it, and reopening keeps the conversation. Same result at 400px.
- **Finding page:** both Quick Read and Full Technical Details checked as described in the table above.
- **Ask Witness page:**
  - Chat layout with a conversation list and New chat. After New chat, the "What do you want to know?" prompt cards show.
  - It answered in 6.2 seconds. "Sources & reasoning" starts closed and opens on click.
- **Safeguards, Settings, Findings, Evidence:** all render; "Safeguards needing action" is present.
- **Console and network:**
  - No page errors.
  - `GET /api/accounts/me` returns 401 on every page when signed in with the master token rather than an account. This is expected under the contract, but it shows up as console noise.
  - One `502 GET /api/findings/:id/investigations` happened once; the same request returns 200 when retried with curl.
  - The 401s right after logout are expected.

Screenshots are in `/private/tmp/claude-501/-Users-oguzkirmizi-Desktop-academics-hackathons-81agents/e12806d6-35d1-4210-8dab-a807163465a2/scratchpad/r2/` (landing, signup, account-menu, login-done, overview, overview-askpopup and its answer, runs, finding-quick, finding-full, ask-empty, ask-answer, safeguards, settings, findings, evidence, each at 1440 and 400). The logs there are `test2.log`, `build.log` and `browser.log`.

**4. Limitations**
- **Ask page layout (cosmetic, agent F's area):** at 1440, a long answer with "Sources & reasoning" open shows text below the composer and footer. The composer's background doesn't cover the space under it.
- **Test accounts:** there are now 3 test accounts in the local DB: `demo+kw@example.com`, `demo+kw-r2@example.com` and `demo+kw-r2b@example.com`. None of their passwords were saved.
- **Overview anchor links:** "Runs needing review" and "Safeguards awaiting approval" don't scroll to their sections, but both sections are at the top of their pages.
- **Graph live test:** the Neo4j test failure depends on the live data, as before this round.

## Follow-ups applied after this report
- Landing hero simplified: the first view shows only the centred headline "See what your agent is actually doing." and one sentence, with a small drifting glow behind it; the buttons and the screenshot fade in on scroll.
- The "An honest note" section, its nav link, and the "Local build: AI is advisory" strip were removed at the user's request (FIXTURE badges and evidence labels remain).
- "Agent said -> Kernel saw" and the reported-vs-observed panel now also show observations paired by stored matched correlations (labelled as correlator-linked).
- Migration 134 repairs databases that applied an early draft of the accounts migration.
