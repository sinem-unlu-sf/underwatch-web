# Underwatch: UI Redesign and Implementation Prompt

> **Superseded by [`UI-REDESIGN-PRD.md`](./UI-REDESIGN-PRD.md)**, the complete version the user sent minutes later. This draft is kept for history; its finding-level items (Quick Read, contextual chatbot, graph near the top) live on through Addendum C.
>
> The design brief from the user, 2026-10-17, recorded as received. It applies on top of [`PRD.md`](./PRD.md) and its addenda (A, B, C). Where they overlap, Addendum C (judge feedback) and this brief take precedence over the base PRD §6.1 "no unnecessary animations": restrained 120–220ms purposeful transitions are allowed.

## Objective

Redesign the existing Underwatch application into a polished, futuristic, minimal, and intuitive developer tool.

Use the approved product PRD as the source of truth for product requirements. This prompt specifies the visual direction, information architecture, interaction design, and implementation expectations.

The primary goal is to make Underwatch significantly easier to understand and navigate without sacrificing its technical depth, evidence integrity, or existing functionality.

**Before making any changes, inspect the entire existing repository. This is a redesign of the current product, not a rebuild. Preserve every existing feature, integration, workflow, route, backend connection, data model, authentication mechanism, permission, monitoring capability, and security control.**

Do not start by generating a new application or replacing working functionality with a prototype.

## 1. Visual Direction

Combine **Linear's clarity and refinement with Vercel's minimal, technical aesthetic**.

The product should feel like a serious, modern developer tool: futuristic but understated, sophisticated but approachable, and information-dense without feeling overwhelming.

Use restrained neumorphism to add depth where useful, but keep the overall design flat, precise, and clean.

### Color palette

- Main background: `#09090B`
- Standard surfaces: `#111114`
- Elevated surfaces: `#1A1A1F`
- Primary text: `#EDEDF0`
- Secondary text: `#92929D`
- Accent: `#8B8CF6`
- Verified or successful: `#47C9A5`
- Caution or uncertainty: `#F0B85A`

Use neutral colors as the foundation. Reserve accent colors for meaningful actions, selected states, and important information. Never rely on color alone to communicate status.

### Typography

- Use Geist Sans or Inter for general text.
- Use Geist Mono for logs, identifiers, code, timestamps, and technical metadata.
- Establish a clear hierarchy between page titles, section headings, summaries, and supporting details.
- Prioritize readability over oversized typography.

### Spacing and surfaces

- Use a consistent 4px spacing base.
- Common spacing values: 8px, 12px, 16px, 24px, and 32px.
- Use subtle borders, restrained shadows, and modest corner radii.
- Keep cards and panels visually lightweight.
- Use whitespace to separate concepts rather than placing everything inside a card.

Avoid excessive gradients, glowing borders, glassmorphism everywhere, generic AI illustrations, oversized dashboard cards, and decorative charts.

## 2. Preserve the Existing Application

Before implementing the redesign:

1. Inspect the repository structure, framework, dependencies, routes, components, APIs, backend services, database models, and existing tests.
2. Run the current application if possible and understand its existing behavior.
3. Create an inventory of every existing feature and map it to the redesigned application.
4. Identify reusable components and existing functionality that should be retained.
5. Plan the redesign around the existing architecture.

### Non-negotiable rules

- Do not remove or silently simplify existing features.
- Do not replace working functionality with mock data, fake integrations, static demonstrations, or placeholder buttons.
- Do not rewrite the backend merely to accommodate the new design.
- Preserve all existing routes and workflows.
- Preserve authentication, authorization, permissions, monitoring, evidence collection, and security enforcement.
- If a feature does not fit the proposed information architecture, find an appropriate place for it rather than deleting it.
- Ask for approval before making breaking changes.

After implementation, compare the application against the original feature inventory and test the existing workflows.

## 3. Application Shell and Navigation

Create a consistent application shell that supports fast navigation and makes the product feel cohesive.

Where compatible with the existing application, use a collapsible left sidebar with approximately 232px expanded width and 64px collapsed width.

The main navigation should include the following destinations where applicable:

- Overview
- Findings
- Agent Runs
- Evidence Explorer
- Ask Witness
- Safeguards

Preserve existing settings, integrations, configuration pages, and other capabilities, even if they require additional navigation items or secondary navigation.

Use a compact top bar for repository or workspace selection, breadcrumbs, contextual page titles, search, and account controls where these features are supported.

Maintain the user's selected repository, active finding, filters, and investigation context when navigating between related pages.

Do not create routes that lead to empty pages or add controls that do nothing.

## 4. Findings: Two Reading Modes

Implement the two reading modes required by the PRD. They are different ways of presenting the same underlying finding, not separate systems.

### A. Quick Read

Make this the default presentation for applicable findings.

The purpose is to let a developer understand an issue in seconds.

Present three clearly distinguishable sections:

**Problem:** What happened, what was identified, and what is affected?

**Why it matters:** What is the potential impact, what evidence supports the concern, and what remains uncertain?

**How to fix it:** What should the developer do next, and how can the result be verified?

Use concise language, short paragraphs, and clear section labels. Highlight the most relevant facts without hiding important qualifications.

Provide access to supporting evidence wherever relevant. Recommendations must be grounded in the actual finding and must not imply that remediation has already occurred.

Avoid excessive metadata, lengthy logs, or repeated explanations in this mode.

### B. Full Technical Details

Provide a clear way to switch to the complete existing investigation.

Preserve all existing technical information and functionality, including agent reports, observed events, policies, permissions, logs, timelines, AI analyses, investigation history, graph relationships, task outcomes, safeguards, and verification results.

Do not replace the existing detailed report with a newly generated summary. Retain the existing information and behavior.

### Switching between modes

Provide an obvious, compact mode switch labeled:

`Quick Read | Full Technical Details`

Keep the current finding and investigation context when switching. Do not clear filters, lose the selected task, reset evidence navigation, or discard relevant state.

If practical, remember the user's preferred mode across findings. However, always make both modes accessible to authorized users.

Both modes must use the same underlying evidence and data. The concise mode is not a separate source of truth.

## 5. Contextual Chatbot: Read More About This Issue

Add a small, optional chatbot that lets developers ask follow-up questions about the finding they are currently investigating.

It should be available when users want additional explanation without forcing them to read the entire technical report.

Use a compact entry point such as **Ask about this issue** or **Read more**. Open the conversation on demand in a small contextual panel that does not unnecessarily obscure the current investigation.

### Behavior

The chatbot should:

- Automatically receive the context of the selected finding, subject to existing access controls.
- Answer questions in plain language by default.
- Support follow-up questions.
- Explain technical terminology and the significance of an issue.
- Explain the evidence behind a conclusion.
- Recommend relevant next steps.
- Help users understand how a fix can be verified.
- Link to existing evidence and relevant technical details.
- Allow users to close the conversation and return to their investigation without losing context.

Include useful suggested questions when appropriate, but do not overwhelm the user with a long list of prompts.

### Trust and implementation

Use existing AI integrations and investigation functionality wherever possible.

Do not implement a disconnected mock chatbot. Do not fabricate answers, evidence, citations, test results, or remediation outcomes.

The chatbot must distinguish observed facts from interpretations, recommendations, and unknowns. When evidence is insufficient, it should say so.

Respect all existing authentication, authorization, and sensitive-data handling rules.

## 6. Neo4j Graphs: Improve Discoverability

The judge specifically praised the Neo4j graphs and recommended making them easier for developers to discover.

**Place the existing graph near the top of its relevant finding or investigation subsection**, before lengthy technical explanations or logs.

The graph should not be hidden behind multiple navigation steps when it is relevant to understanding the issue.

Use this general information hierarchy where applicable:

1. Subsection heading and a brief explanation.
2. Existing Neo4j graph.
3. A short explanation of the most relevant relationship, when supported by evidence.
4. Supporting technical details and related records.

In Quick Read, show the graph when it meaningfully helps explain the issue. For complex graphs, preserve access to the complete graph and its existing functionality.

Do not force a graph into findings that have no relevant graph data.

### Graph interactions

Preserve existing Neo4j integration and graph behavior.

Where supported:

- Highlight connected nodes on hover.
- Let users select nodes to inspect entity details.
- Let users select relationships to investigate their meaning.
- Link relevant entities to findings, agent runs, and evidence.
- Make large graphs navigable without losing context.

Use actual graph data. Do not invent nodes, edges, relationships, or statistics. Clearly distinguish recorded relationships from inferred interpretations.

## 7. Findings Views

Preserve the three findings organization and refresh modes from the PRD:

- **Daily Digest:** Meaningful activity and important findings over a defined period.
- **Task-Based Findings:** Findings associated with a specific task, agent run, or investigation.
- **Current State / On-Demand Refresh:** The latest available snapshot, refreshed when the user explicitly requests it.

These are separate from the Quick Read and Full Technical Details reading modes.

Make switching between findings views straightforward, while preserving existing filtering, sorting, search, and investigation functionality.

Clearly communicate the last successful refresh, stale data, incomplete information, and failed requests where applicable.

**Important:** These modes only control how findings are organized or refreshed. They must never pause or disable background monitoring, event capture, evidence collection, or security enforcement.

Do not claim a refresh succeeded until the underlying operation confirms success.

## 8. Overview Page

Create a calm, useful overview rather than a dashboard filled with metrics.

The page should help users answer:

- What needs my attention?
- What happened recently?
- What should I investigate next?

Use real data to surface important findings, recent agent runs, relevant system status, and safeguards requiring attention where supported by the existing backend.

Avoid meaningless KPI cards, fabricated statistics, decorative charts, and repetitive information.

Each item should lead to a meaningful next action or the underlying evidence.

## 9. Finding Detail and Evidence

Make it easy to distinguish four information categories:

- **Agent report:** What the agent claims it did.
- **Observed evidence:** What the system independently recorded.
- **Applicable policy:** What rules and permissions applied.
- **Interpretation:** What the evidence may mean.

Preserve the distinction between security outcomes and task outcomes.

A prevented action does not automatically mean the legitimate task succeeded. Use unknown or inconclusive states when evidence does not support a definitive result.

Keep the evidence timeline, supporting records, logs, and related investigation context available. Use progressive disclosure to avoid overwhelming users in Quick Read without removing anything from Full Technical Details.

## 10. Ask Witness

Preserve the existing Ask Witness experience and all its capabilities.

Make it straightforward to investigate evidence, ask follow-up questions, and move between the AI's explanation and the source records.

Responses should distinguish:

- Observed facts
- Interpretations
- Unknowns
- Recommended next steps

Evidence references should open the corresponding records where possible.

The new contextual chatbot should reuse existing capabilities rather than create a redundant investigation system.

## 11. Safeguards and Remediation

Preserve existing safeguard workflows and make their status and supporting evidence understandable.

Where supported, the workflow should remain:

**Investigate → Propose → Review → Test → Verify**

Clearly communicate what a safeguard enforces, whether it has been tested, what the test demonstrated, and whether it has actually been applied.

Do not treat written instructions as equivalent to technically enforced controls.

Preserve existing approval requirements for consequential changes. Do not imply that a safeguard is active or effective without confirmation.

## 12. Motion and Interaction Quality

Make the application feel responsive and polished through restrained, purposeful interactions.

Use transitions generally around 120–220ms for navigation, selection, expansion, and state changes.

Prioritize:

- Clear hover, focus, and selected states
- Expandable evidence details
- Smooth navigation
- Useful tooltips
- Search and filtering where supported
- Keyboard-accessible controls
- Clear feedback for completed and failed actions
- Consistent behavior across related pages

Avoid constant movement, decorative animations, unnecessary popups, and controls that look interactive but do nothing.

Interactions should help users understand the system or accomplish a task.

## 13. Responsive Design and Accessibility

Ensure the application remains usable at different viewport sizes.

- Support keyboard navigation and visible focus states.
- Use readable text sizes and accessible contrast.
- Do not rely on color alone to communicate status.
- Avoid hover-only functionality.
- Keep long technical content navigable.
- Provide accessible alternatives for graph information where feasible.
- Ensure critical actions remain available on smaller screens.

## 14. Data Integrity and Security

The redesign must not weaken the existing product's security posture.

Preserve authentication, authorization, permissions, redaction, monitoring, evidence collection, and enforcement behavior.

Ensure the chatbot, findings summaries, graph exploration, and detailed report respect the same access controls.

Never expose secrets or sensitive information through summaries, logs, graph details, or AI responses.

Display clear loading, empty, error, stale, and incomplete states. Never substitute fabricated data for unavailable backend results.

## 15. Implementation Workflow

### Phase 1: Audit

Inspect the entire existing repository and run the application and tests where possible.

Document all existing routes, features, integrations, data flows, and workflows.

### Phase 2: Plan

Map every existing feature to the redesigned application.

Identify which components can be reused and how the new reading modes, contextual chatbot, and improved graph discoverability fit into the current architecture.

Do not begin a wholesale rewrite.

### Phase 3: Implement

Implement the redesign within the existing architecture.

Connect components to real backend data and existing integrations. Preserve all current functionality.

Avoid unnecessary dependency changes, backend rewrites, and duplicated implementations.

### Phase 4: Verify

Test the new and existing functionality, including:

- Switching between reading modes without losing context
- Accuracy and completeness of concise explanations
- Contextual chatbot answers and evidence references
- Neo4j graph availability, placement, and interactions
- All three findings views and refresh behavior
- Agent runs, monitoring, evidence collection, and security enforcement
- Safeguard workflows
- Authentication, authorization, and sensitive-data handling
- Existing routes, integrations, and automated tests
- Responsive behavior and accessibility

Only report tests as passed when they have actually been executed successfully.

### Phase 5: Report

Summarize the implemented changes, preserved features, tests performed, and any outstanding limitations or regressions.

Do not claim the project is complete if essential existing functionality has been lost or remains nonfunctional.

## 16. Final Acceptance Criteria

The implementation is complete only when:

1. The application has a cohesive Linear + Vercel-inspired visual identity.
2. Developers can understand a finding quickly through Quick Read.
3. The original detailed investigation remains intact and fully accessible.
4. The contextual chatbot provides evidence-grounded explanations and follow-up answers.
5. Existing Neo4j graphs are easier to discover within relevant investigations.
6. All three findings views remain functional and independent of background monitoring.
7. Existing features, routes, integrations, backend behavior, and security mechanisms are preserved.
8. The application uses real data rather than mock implementations.
9. The new and existing functionality has been tested.
10. Any incomplete work or limitations are reported honestly.

**Final instruction:** First understand what already exists. Then improve it. The goal is to make Underwatch easier to understand, more pleasant to use, and more efficient to navigate without sacrificing technical rigor, evidence integrity, security, or any existing capability.
