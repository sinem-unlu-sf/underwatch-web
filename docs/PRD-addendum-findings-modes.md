# Underwatch PRD: User-Controlled Findings Update Modes

> Addendum B to [`PRD.md`](./PRD.md). Added 2026-10-17. Implementation notes are in [`FINDINGS-MODES.md`](./FINDINGS-MODES.md).

## Objective

Redesign how Underwatch displays and updates findings so users can choose when they want to receive and view information.

We want the product to feel clean, minimal, deliberate, and user-controlled. Do not continuously populate the screen with new findings, notifications, metrics, activity cards, or other elements simply because data is available.

The user should decide how findings are organized and when the interface refreshes them.

Before implementing anything, inspect the existing repository, findings data model, event ingestion flow, API endpoints, and current UI. Explain what already exists and propose an implementation plan that fits the current architecture. Do not rebuild working functionality unnecessarily.

## 1. Implement three findings update modes

Users should be able to select one of three modes. Present them as a compact segmented control or similarly clear selector in the findings interface.

### Mode A: Daily Digest

**Behavior:** Findings are grouped into a daily summary rather than continuously appearing in the main view.

Requirements:
- Display findings for a clearly defined day and timezone.
- Group related findings where appropriate, without hiding the underlying individual evidence.
- Show a concise summary of what needs attention, what was blocked, and what remains uncertain.
- Allow users to expand individual findings and inspect their supporting evidence.
- Keep the displayed daily snapshot stable during the day unless the user explicitly refreshes it or opens a newer snapshot.
- Clearly indicate the snapshot's last update time and whether newer findings are available.
- Do not imply that the digest is complete if telemetry is missing or ingestion is delayed.
- Do not generate repeated notifications for every event.

The digest should help users understand what happened over a period without requiring them to monitor the application continuously.

### Mode B: Task-Based Findings

**Behavior:** Findings are organized around a specific coding task or agent run, not a continuous stream of unrelated activity.

Requirements:
- Let users select a task, agent run, or project context.
- Show findings associated with that context.
- Group the relevant agent-reported actions, independently observed events, applicable policies, and related evidence.
- Keep unrelated tasks out of the current view.
- Make it easy to switch between tasks and return to a previous investigation.
- Preserve the context when the user opens a finding or uses Ask Witness.
- If a task has no findings, show a clear empty state rather than unrelated global activity.

This should be the default mode for users who want to understand what happened during a particular coding task.

### Mode C: On-Demand / Current State

**Behavior:** Show the latest available findings snapshot, but do not continuously refresh or rearrange the screen. Update the view only when the user explicitly requests it, such as by clicking a Refresh or Update button.

Requirements:
- Show the timestamp of the last successful refresh.
- Provide an obvious but unobtrusive manual refresh action.
- Fetch and display the latest available findings only when requested.
- Preserve the user's current selection, filters, expanded details, and investigation context during refresh whenever possible.
- Show a loading indicator on the refresh control while updating.
- If new findings are available, indicate that the snapshot changed and allow the user to inspect them.
- If nothing changed, say so briefly.
- If refreshing fails, preserve the last successful snapshot and explain the failure.
- Do not silently refresh the page, automatically reorder findings, or interrupt an active investigation.

Important distinction: this mode does not mean displaying every event in real time. It means showing the current state of the findings data as of the last explicit refresh.

## 2. Separate data collection from UI updates

The three modes primarily control how findings are presented and refreshed. They must not accidentally change the underlying monitoring or event-collection behavior.

Keep these concepts separate:

1. **Event collection:** How the system records agent actions and independently observed events.
2. **Finding generation:** How evidence is correlated and a finding is created or updated.
3. **Finding presentation:** Which findings the user sees and how they are grouped.
4. **Snapshot refresh:** When the interface retrieves and displays newer findings.

Do not disable security monitoring, event capture, or policy enforcement when the user selects a less frequent update mode.

If the current architecture does not support these distinctions, identify the gap and propose the smallest safe change before implementing it.

## 3. UI design requirements

Use the existing Underwatch visual direction: Linear-inspired simplicity and Vercel-inspired technical precision.

The findings interface should have:

- A compact, clearly labeled update-mode selector.
- A simple page heading and a small amount of relevant context.
- A clearly visible selected mode.
- A concise last-updated timestamp where relevant.
- A findings list or grouped view that uses available space efficiently.
- Expandable finding details rather than permanently displaying all metadata.
- A dedicated investigation view for detailed evidence.
- Clear empty, loading, error, and stale-data states.

Avoid:
- Constantly moving content.
- Automatically appearing cards or pop-ups.
- Decorative live counters that change independently of user actions.
- Unrequested charts and activity feeds.
- Excessive status badges, glows, shadows, and animation.
- Showing all findings, raw events, and evidence simultaneously.
- Replacing the user's selected view during an investigation.

The page should remain visually stable while the user reads, compares evidence, or asks Witness questions.

## 4. Suggested interaction model

The findings page should have a compact control such as:

`Daily Digest | By Task | Current State`

The labels can be refined for clarity, but their behavior must remain distinct.

- Switching modes changes the organization and refresh behavior of the findings view.
- Switching modes must not discard findings or modify underlying records.
- Persist the user's preference across sessions if the existing application supports user preferences.
- When switching to Daily Digest, select the relevant date or daily snapshot.
- When switching to By Task, prompt for a task or run if one is not already selected.
- When switching to Current State, display the latest snapshot already retrieved and wait for an explicit refresh to retrieve newer data.
- Ask for confirmation before abandoning unsaved investigation work, if applicable.

Do not make the user configure numerous settings just to choose a mode.

## 5. Evidence integrity and data handling

All displayed findings must come from the existing findings and evidence pipeline.

- Do not invent findings or treat example data as production telemetry.
- Clearly label mock or synthetic data in development and demo environments.
- Preserve the distinction between agent-reported actions and independently observed events.
- Distinguish a denied attempt from a successful action.
- Do not interpret missing telemetry as proof that an action did not happen.
- Preserve evidence references and provenance across all three modes.
- Ensure daily summaries and task groupings link back to the original findings and evidence.
- Use existing authorization rules when retrieving data for each view.

If a summary is AI-generated, it must be grounded in retrieved evidence. AI must not determine whether an event occurred independently of the evidence records.

## 6. Architecture and implementation

Before coding, inspect and report:

1. How findings are currently stored and retrieved.
2. Whether findings are generated at ingestion time, queried on demand, or both.
3. How task/run IDs and timestamps are represented.
4. Whether daily summaries or snapshots already exist.
5. Whether the UI currently polls, subscribes to updates, or fetches only on navigation.
6. How user preferences are stored.
7. Which existing components and API routes can be reused.

Then propose the smallest implementation that supports all three modes.

Prefer reusing the existing backend and Neo4j integration. Do not introduce a second findings database, duplicate event pipeline, unnecessary scheduler, or new infrastructure without explaining why it is needed.

For daily digests, determine whether the backend already provides a stable snapshot or whether a lightweight snapshot/version mechanism is required. Do not introduce scheduled jobs unless they are actually needed by the existing architecture.

For manual refresh, use the existing API and ensure the client does not silently fetch newer results in the background.

## 7. Acceptance criteria

The implementation is complete only when:

1. Users can switch between all three modes.
2. Each mode has distinct, documented behavior.
3. Daily Digest groups findings by date and indicates snapshot freshness.
4. Task-Based mode shows only findings relevant to the selected task/run context.
5. Current State remains stable until the user explicitly refreshes it.
6. Refresh preserves the user's investigation context and handles errors without losing the previous snapshot.
7. Changing presentation modes does not disable event collection or enforcement.
8. Every finding links to its supporting evidence.
9. Empty, loading, stale, and error states are understandable.
10. The interface does not automatically inject unrelated cards, pop-ups, or activity into the user's view.
11. Existing functionality and tests continue to work.
12. Tests cover mode switching, filtering, refresh behavior, snapshot consistency, and error handling.

## 8. Required deliverables

Before implementation, provide:
- A brief description of the current findings architecture.
- A comparison of the three modes and their data requirements.
- The proposed UI layout and interaction flow.
- Any required API, database, or schema changes.
- An implementation plan identifying reusable components and files.

After implementation, report:
- Files changed.
- Which behaviors are fully implemented versus mocked.
- Tests run and their actual results.
- Any remaining limitations.

Build a calm, deliberate investigation experience. The user should feel in control of what they see and when the interface changes.
