# Findings Modes: implementation notes and post-implementation report

> Implements [Addendum B](./PRD-addendum-findings-modes.md) (user-controlled findings update modes). Status as of 2026-10-17 11:40 JST. Everything below was checked against the code and test runs on that date.

## 1. Architecture before this change

| Question (Addendum B section 6) | Answer |
| --- | --- |
| How findings are stored and retrieved | Rows in the `findings` table (SQLite via `node:sqlite`), linked to `events` and `evidence` by id arrays. Read through `repo/findings.ts` (`queryFindingList`) and the `/api/findings`, `/api/runs/:id/findings` and `/api/findings/:id` routes. |
| Generated at ingestion or on demand | At ingestion/analysis time: fixture import, live analysis and observer ingest save findings. Queries read the stored rows. |
| Task/run ids and timestamps | Each run has an id, `task_description`, `repository_id` and `started_at`/`ended_at` (ISO UTC). There is no task id, so a task is identified by `taskContextKey(repository_id, task_description)`. |
| Existing daily summaries/snapshots | None. Migration `090_findings_snapshots.sql` adds a small append-only table for digest versions. |
| Polling/subscriptions | No subscriptions. TanStack Query defaults used to refetch on window focus and reconnect. The only timed polling is the verification-run poll on the safeguard page, which starts only when the user starts a verification. |
| User preferences | No per-user preference store. The mode is kept in the URL (`?mode=`) and per browser in `localStorage` (`kw.findings.mode`). |
| Reused pieces | `PageHeader`, `Panel`, badges, `EmptyState`/`ErrorState`/`Skeleton*`, the API client, and the `/api/runs/:id`, `/api/runs/:id/findings` and `/api/findings/:id` routes. |

The four concepts stay separate:
1. **Event collection** (ingest and observers): not touched.
2. **Finding generation** (analysis): not touched.
3. **Finding presentation** (the three modes): this work.
4. **Snapshot refresh** (explicit user actions only): this work.

There is no server-side "mode". No route accepts a mode parameter. No ingestion, analysis, enforcement or observer code reads `finding_snapshots` or the mode. Tests enforce both.

## 2. The three modes

The selector is a compact segmented control in the Findings page header: `Daily Digest | By Task | Current State`. The mode and the current selection live in the URL. The preference is also saved in localStorage, so a new session opens the last mode used. Old links still work: `?status=` opens Current State with that filter, and `?run_id=` opens By Task on that run.

| | Daily Digest | By Task (default) | Current State |
| --- | --- | --- | --- |
| Organizes by | One day in a named IANA time zone. A run belongs to the day its `started_at` falls in. | One task (runs with the same repo and task description), optionally narrowed to one run | All saved findings, filtered in the browser |
| Data source | `GET /api/digests/:date?tz=` (stored, versioned snapshot) | `GET /api/tasks` plus the existing run, run-findings and finding-detail routes | `GET /api/findings/snapshot` (computed each time, never stored) |
| When it changes | Only on an explicit **Refresh** (adds version N+1 only if the content changed), or when the user opens another version or day | When the user picks another task or run, or presses the Tasks panel **Refresh** | Only on **Refresh** |
| How fresh it is | "Snapshot vN from <time>", "Newer findings available (N new, M updated)", and a notice when viewing an older version | Run status and coverage for each run | "Last refreshed <time>", then "No changes since your last refresh" or "N new, M updated since your last refresh", with markers on those rows |
| Completeness | Notes from coverage reports, collector errors, run status and "day not over yet". The best case reads "no known coverage gaps … not proof of full coverage", never "complete". | "Coverage unknown" when no coverage report was recorded. An empty task says missing telemetry does not mean nothing happened. | The same completeness notice, for the runs behind the findings shown |

All modes:
- Rows are compact. Details open in place and stay open across a refresh.
- **Open investigation** goes to `/findings/:id?from=<current view>`. The finding page, where Ask Witness lives, shows "Back to <view>". That link only accepts `/findings…` addresses in this app.
- **Linked events in run timeline** goes to `/runs/:run?finding_id=:id`.
- Reported and observed outcomes always appear on separate lines. "denied/blocked" carries the note "an attempt that was prevented, not a success".
- Fixture data carries a FIXTURE badge on rows, on tasks, and on any digest or snapshot that contains it.

Digest summary buckets are computed by code from stored rows, with no AI:
- **needs_attention**: findings with an open status.
- **blocked**: a denied or blocked attempt is linked, and the linked evidence does not show the action succeeding. Observed events decide over reported ones, so a denied Read followed by an observed successful `cat .env` is not counted as blocked.
- **uncertain**: the uncertain-correlation category, low confidence, or an `unknown` outcome.
- **coverage caveats**: the completeness notes.

## 3. API and database changes

The contract is `FINDINGS_VIEWS_CONTRACT` in `packages/schema/src/findings-views.ts`, exported from `@kw/schema`. All routes are behind the existing local Bearer-token guard. The POST also needs the `x-kw-client` header.

| Route | Behavior |
| --- | --- |
| `GET /api/findings/snapshot` | Read-only and never stored. `snapshot_id` is a hash of `{findings, total, completeness}`. Capped at 500 findings, with `truncated` set when the cap applies. |
| `GET /api/tasks?q=&fixture=` | Tasks, most recent activity first. |
| `GET /api/digests/:date?tz=&version=` | Returns the latest version, creating v1 the first time a day is opened (no scheduler). With `version` it never creates anything and returns 404 if that version doesn't exist. `newer_available` and `changes` are worked out on each request by rebuilding the digest from current rows; nothing is stored for them. |
| `POST /api/digests/:date/refresh?tz=` | Adds a version only if the content hash changed. Runs inside an IMMEDIATE transaction. |
| `GET /api/digests/:date/versions?tz=` | Lists versions, newest first. |

`090_findings_snapshots.sql` adds one table, `finding_snapshots`:
- It stores references only: finding ids with their status and severity at snapshot time, plus grouping and summary.
- It is append-only; triggers reject UPDATE and DELETE.
- It has a `contains_fixture_data` flag.
- The migration runner explicitly allows gaps in numbering.

This is not a second findings database. `findings`, `events` and `evidence` remain the source of truth.

## 4. Files changed

**New files** (owned by this feature):
- `packages/schema/src/findings-views.ts`, `findings-views.test.ts`
- `apps/server/migrations/090_findings_snapshots.sql`
- `apps/server/src/findings-views/{index,routes,current,digest,tasks,snapshot-findings}.ts`, `findings-views.test.ts`
- `apps/web/src/api/findingsViews.ts`
- `apps/web/src/components/findings-modes/{useFindingsMode.ts, ModeSwitcher, FindingRow, SnapshotFindingDetail, CompletenessNotice, CurrentStateMode, DigestMode, TaskMode, BackToFindings}.tsx`, `FindingsModes.test.tsx`
- `docs/FINDINGS-MODES.md`

**Rewritten:** `apps/web/src/pages/FindingsPage.tsx`

**Small additions to shared files:**
- `packages/schema/src/index.ts`: one export line.
- `apps/server/src/app.ts`: an import and `registerFindingsViewsRoutes(app, ctx)`.
- `apps/web/src/main.tsx`: app-wide `refetchOnWindowFocus: false` and `refetchOnReconnect: false`. This applies to every page, on purpose.
- `apps/web/src/api/client.ts`: `export { request as requestJson }`.
- `apps/web/src/pages/FindingDetailPage.tsx`: a `<BackToFindings>` line and its import.

**Changed during verification:**
1. `digest.ts` (and the schema comment): the "blocked" bucket counted fx-04 (denied Read, then `cat .env` observed succeeding). It now uses `wasBlocked()`, where observed outcomes decide over reported ones. A unit test and a fixture check were added.
2. `TaskMode.tsx`: By Task had no way to pick up new runs short of a page reload, and a failed refetch would have replaced the loaded list with an error. It now has an explicit Refresh on the Tasks panel that reloads tasks and the open task's runs and findings. It never runs in the background, and on failure it keeps the previous list and shows the error.
3. `FindingsModes.test.tsx`: 4 tests added (By Task refresh and no background fetching; By Task refresh failure; Current State keeping filters and open rows across refresh and reusing the loaded snapshot on mode switch; Digest load error and no refetch on focus).

## 5. Fully implemented vs mocked

- **Fully implemented against real data:** all five endpoints and the snapshot table; all three modes, with URL state, the saved preference, explicit refresh, newer-findings detection, completeness notes, evidence links and the link back from a finding.
- **Mocked:** nothing in the product. The web tests use a mocked `fetch`, but every mocked response is validated against the shared Zod contract, so the tests can't drift from the real response shapes.
- **No AI:** digest summaries are computed by code from stored rows.

## 6. Tests run (actual results, 2026-10-17 around 11:37 JST)

| Command | Result |
| --- | --- |
| `apps/server`: `vitest run` (full suite) | 13 files, 130/130 passed (14 in `findings-views.test.ts`) |
| `apps/server`: `tsc` | clean |
| `apps/web`: `vitest run` (full suite) | 6 files, 44/44 passed (15 in `FindingsModes.test.tsx`) |
| `apps/web`: `tsc` | clean |
| `apps/web`: `vite build` | succeeds; warns that the whole-app bundle is over 500 kB (already true before this work) |
| `packages/schema`: `vitest run` / `tsc` | 4 files, 42/42 passed / clean |

Some earlier runs failed because other workstreams were mid-edit: `supervised/ingest.ts` imported a package that wasn't installed yet, and `services/registry.ts` imported a file that didn't exist yet. Both cleared without changes from this feature.

**End-to-end check on a copy of the real `data/kw.db`** (5 labeled fixture runs), using `buildApp` and `app.inject` with real auth headers:
- `/api/findings/snapshot`: 6 findings, all labeled fixture, `has_gaps` (fx-05 has partial coverage and collector errors). Every finding has at least one evidence id. Two calls in a row return the same `snapshot_id`.
- `/api/tasks`: 5 tasks; `q=env` returns 2; `fixture=exclude` returns 0.
- `2026-10-16` in Asia/Tokyo: fx-01 and fx-02, `no_known_gaps`.
- `2026-10-17` in Asia/Tokyo: fx-03, fx-04 and fx-05 (4 findings), `has_gaps` including `day_in_progress`.
- `2026-10-10`: `no_runs`.
- A second GET returns the same v1. Refresh with no changes returns `created: false`.
- Refresh without `x-kw-client` returns 403. A missing version returns 404. A bad time zone or date returns 400. No token returns 401.
- After the "blocked" fix, the v1 stored earlier for 2026-10-17 kept its old content and the API reported `newer_available: true`, which shows stored snapshots stay put until an explicit refresh.
- Row counts for runs, events, findings, evidence and coverage_reports were the same before and after. The findings rows (id, status, updated_at) were identical.
- `DELETE FROM finding_snapshots` was rejected as append-only.

**Live dev server on port 4600** (token from `data/auth-token`):
- `/api/findings/snapshot` and `/api/tasks` return 200; without the token, 401.
- Refresh without the client header returns 403.
- The Vite proxy on 4601 returns 200.
- Live database counts did not change (`finding_snapshots` is still 0, because I opened no digest day on the live database).

**Code checks:**
- `grep` finds `finding_snapshots` and the mode only in `findings-views/`, `app.ts`, the schema and the web findings-modes components.
- The findings views contain no `refetchInterval`, `setInterval`, EventSource/WebSocket or toast code. The only `refetchInterval` in the web app is the user-started verification poll on the safeguard page.

## 7. Remaining limitations

- **Default time zone:** when `tz` is missing, the digest uses UTC (the contract's default). The web client always sends the browser's time zone.
- **Today's digest:** it carries a "day not over yet" note, so a digest opened during the day reports `newer_available` once the day ends.
- **GET has a side effect:** the first digest GET for a day and time zone creates v1. This is deliberate (no scheduler), but opening a day writes to the database.
- **Version selector:** it lists v1 to vN without creation times and doesn't call `/versions`.
- **Current State cap:** at most 500 findings, with `truncated` shown. Older findings are still reachable through By Task and Daily Digest.
- **By Task requests:** one run-detail and one run-findings request per run in the selected task. These queries still reload on mount after the user's own status change on the finding page, but never on focus, reconnect or a timer.
- **Refresh messages:** "No changes" and "Created vN" disappear when you navigate away.
- **No confirmation on mode switch:** the findings page holds no unsaved work. Ask Witness drafts live on the finding page, which a mode switch doesn't touch.
- **Preference scope:** saved per browser in localStorage, not per user, because the app has no user-preference store.
- **No manual browser check:** the UI was verified with component tests and the production build only.

## 8. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Users can switch between all three modes | Pass | `ModeSwitcher.tsx` (radio group). Test "defaults to By Task, switching updates the URL and persists the preference". |
| 2 | Each mode has distinct, documented behavior | Pass | Section 2. The `MODE_HINT` text is shown under the page title. |
| 3 | Daily Digest groups by date and shows snapshot freshness | Pass | `digest.ts` (day boundaries, versions, `newer_available`, `changes`). Server tests for the Tokyo/UTC midnight boundary, stable v1 with `newer_available`, and refresh creating v2. Web test for the newer-findings notice and "Snapshot vN from". End-to-end check above. |
| 4 | Task mode shows only the selected task or run's findings | Pass | `TaskMode.tsx`, `tasks.ts`. Web test for the selected task or run only (asserts no requests for other runs). Server test that a task's run lists only its own findings. Empty-task state test. |
| 5 | Current State stays stable until an explicit refresh | Pass | `CALM_QUERY` settings (no refetch on focus, reconnect or timer). The test fires focus, visibility and online events and advances 30 minutes under the most refetch-prone client settings: 1 request, then 2 after Refresh. The web builder confirmed the test fails when refetching is turned back on. |
| 6 | Refresh keeps context; errors keep the previous snapshot | Pass | Tests for Current State refresh failure, Current State keeping filters and open rows, and By Task refresh failure (confirmed to fail without the fix). The `?from=` link plus `BackToFindings` keeps context when opening a finding or Ask Witness. |
| 7 | Changing modes does not turn off collection or enforcement | Pass | No server-side mode. Tests for no mode parameter on any route, a source scan showing no collection or generation code reads the mode, and identical ingestion with or without snapshots. End-to-end row counts unchanged. |
| 8 | Every finding links to its evidence | Pass | Every row links to `/findings/:id` (the investigation view with evidence) and, when opened, to `/runs/:run?finding_id=`. Snapshot rows show evidence counts. By Task lists evidence records inline. End-to-end: every fixture finding has evidence ids. |
| 9 | Empty, loading, stale and error states are understandable | Pass | Loading skeletons. Empty states for a task with no findings, a day with no runs and filters with no matches, each saying this is not proof nothing happened. Older-version and newer-findings notices. Error tests for all three modes. |
| 10 | No cards, pop-ups or activity injected automatically | Pass | No timers, intervals, toasts or subscriptions in the findings views. Markers and notices appear only after a user action or on first load. Digest and Current State cache keys are kept apart from the app's after-status-change invalidation. |
| 11 | Existing functionality and tests keep working | Pass | Server 130/130, web 44/44, schema 42/42. Typechecks clean, build succeeds. Old `?status=` and `?run_id=` links still work. |
| 12 | Tests cover mode switching, filtering, refresh, snapshot consistency and errors | Pass | Web: 15 tests in `FindingsModes.test.tsx`. Server: 14 in `findings-views.test.ts`. Schema: hashing, diffs, time zones (including a daylight-saving day) and the contract. |
