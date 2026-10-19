# Underwatch: UI Redesign PRD

> The authoritative UI redesign spec from the user, 2026-10-17, recorded as received. It replaces the earlier draft in [`UI-REDESIGN-BRIEF.md`](./UI-REDESIGN-BRIEF.md). The finding-level features from Addendum C ([`PRD-addendum-judge-feedback.md`](./PRD-addendum-judge-feedback.md)) still apply and are restated at the end: Quick Read | Full Technical Details, a contextual chatbot, and the graph near the top of a finding.

## 1. Product Vision

Redesign the existing Underwatch interface into a futuristic, clean, minimal, and intuitive developer tool that makes AI coding-agent behavior easier to understand, investigate, and secure.

**Core message:** Don't just trust what your coding agent says it did.

Underwatch independently observes coding-agent activity, compares reported actions with observed system events and permissions, investigates discrepancies, and turns verified incidents into tested safeguards.

The interface should make a complex technical system feel clear and approachable without hiding the underlying complexity or compromising its rigor.

## 2. Core Design Principles

### Clarity over decoration
Every element should help users understand system status, navigate information, investigate activity, or take action. Avoid visual elements that do not serve a purpose.

### Technical depth without visual clutter
Present information in a clear hierarchy. Make complex evidence, system events, and technical metadata readable without overwhelming the entire interface.

### Familiar to developers
Use interaction patterns and visual conventions familiar to developers working with modern technical products.

### Evidence first
Make real system data, event history, relationships, and security states easy to find. The UI should distinguish observed information from interpretation and uncertainty.

### Consistency
Use a shared design system across pages, panels, tables, forms, graphs, and interactive components.

## 3. Visual Direction: Linear Meets Vercel

Combine **Linear's clarity and information hierarchy with Vercel's precise, understated, developer-focused aesthetic**.

The result should feel polished, modern, technical, and slightly futuristic. Avoid making it look like a generic AI dashboard or an overly decorative cybersecurity product.

### Reference points

- **Linear:** Clear hierarchy, restrained colors, compact layouts, precise spacing, polished interactions, and low-friction navigation.
- **Vercel:** Monochromatic surfaces, sharp typography, clean technical layouts, subtle borders, and a confident developer-tool aesthetic.
- **Geist design language:** Consistent typography, disciplined spacing, simple shapes, and restrained visual effects.

Use these as design references rather than copying either product's interface directly.

### Color palette

| Role | Color |
|---|---|
| Main background | `#09090B` |
| Standard surfaces | `#111114` |
| Elevated surfaces | `#1A1A1F` |
| Primary text | `#EDEDF0` |
| Secondary text | `#92929D` |
| Accent | `#8B8CF6` |
| Verified or successful | `#47C9A5` |
| Caution or uncertainty | `#F0B85A` |

Use dark neutral surfaces as the foundation. Reserve accent colors for interactive elements, selected states, links, and meaningful status indicators.

Use green and amber only when their meaning is clear. Do not rely on color alone to communicate status.

Avoid excessive gradients, glowing borders, saturated neon colors, and large areas of accent color.

### Typography

- Use **Geist Sans** as the preferred UI font, with Inter as a fallback.
- Use **Geist Mono** for code, commands, event identifiers, timestamps, technical metadata, and other monospaced content.
- Establish a clear hierarchy between page titles, section headings, body text, labels, and metadata.
- Keep technical information compact but comfortably readable.
- Use font weight and spacing rather than oversized text to create hierarchy.

### Spacing and surfaces

- Follow a consistent 4px spacing grid.
- Use subtle borders to separate sections and surfaces.
- Apply modest corner radii consistently.
- Use restrained shadows only when they clarify elevation or layering.
- Prefer structured layouts and whitespace over putting every element inside a card.
- Use compact density where developers need to scan large amounts of information.

**Neumorphism should be restrained.** Use subtle depth only when it improves the distinction between interactive elements and their surroundings. Avoid soft, heavily embossed interfaces.

### Motion and interaction

- Keep most transitions between 120–220ms.
- Use motion to communicate navigation, selection, expansion, loading, and state changes.
- Provide clear hover, focus, pressed, disabled, and selected states.
- Avoid continuous animation or motion that distracts from technical work.
- Respect reduced-motion preferences.

## 4. Application Layout

Create a consistent application shell that feels like a professional developer tool.

### Sidebar

Use a collapsible left sidebar, approximately 232px when expanded and 64px when collapsed.

The sidebar should contain:

- Underwatch logo and product identity
- Primary navigation
- Access to relevant tools and workspaces already supported by the application
- Settings and configuration access
- A clear indication of the current location

Use simple icons with text labels. Icons should be consistent and recognizable, not decorative.

Preserve all existing routes and make sure every existing feature remains accessible, even if it does not fit into the primary navigation.

### Top bar

Use a compact top bar, approximately 56px high, containing relevant contextual information such as:

- Current page or workspace
- Breadcrumbs where useful
- Search, if supported by the existing application
- Relevant page-level actions
- Existing account or workspace controls

Avoid filling the top bar with redundant status indicators or unnecessary controls.

### Main content

- Give the primary content a clear visual starting point.
- Use consistent horizontal and vertical spacing.
- Align page titles, descriptions, actions, and content sections.
- Use the available width efficiently for tables, timelines, graphs, and technical information.
- Avoid unnecessarily narrow content columns for data-heavy views.
- Support responsive layouts without sacrificing important functionality.

### Panels and overlays

Use drawers, popovers, and dialogs for contextual actions where appropriate.

- Keep the underlying page recognizable when a panel is open.
- Avoid opening multiple overlapping layers without a clear reason.
- Make dismissing overlays straightforward.
- Preserve user context when opening and closing panels.

## 5. Navigation and Information Architecture

Preserve all existing routes and navigation behavior.

Where compatible with the current application, organize primary navigation around:

- **Overview**
- **Findings**
- **Agent Runs**
- **Evidence Explorer**
- **Ask Witness**
- **Safeguards**

Keep existing settings, integrations, configuration options, and secondary features accessible through appropriate navigation or contextual controls.

Do not remove or rename existing functionality solely to match this suggested structure. Audit the current application first and adapt the navigation to its actual capabilities.

Navigation should make it easy to understand where the user is, move between related records, and return to previous investigation contexts.

## 6. Page Design

### Overview

Create a clear starting point that helps users understand the current state of Underwatch.

Prioritize relevant activity, findings, system status, and available next actions using existing data.

- Establish a clear hierarchy between important information and secondary details.
- Use compact summaries that link to their underlying records.
- Make timestamps and status labels easy to scan.
- Avoid a wall of KPI cards or decorative statistics.
- Do not introduce metrics that the backend does not actually provide.

### Findings

Present findings in a consistent, scannable layout.

- Make the finding title, status, severity where supported, and relevant metadata easy to identify.
- Distinguish primary information from secondary metadata.
- Keep search, filtering, sorting, and available actions accessible.
- Use consistent status labels and visual treatments.
- Make individual findings easy to open and investigate.

Preserve all existing finding information and workflows.

### Agent Runs

Make agent activity easy to browse and inspect.

- Clearly display available run identifiers, timestamps, status, and associated task information.
- Use compact tables or structured lists when they improve scanning.
- Keep links to related findings and evidence visible where supported.
- Distinguish completed, active, failed, and unavailable states accurately.

### Evidence Explorer

Optimize this area for technical investigation.

- Use readable event lists, timelines, tables, and metadata panels where supported.
- Keep timestamps, event types, sources, and relationships easy to identify.
- Use monospaced typography for technical identifiers and raw values where appropriate.
- Support existing filtering and navigation.
- Make long technical values readable without disrupting the overall layout.

### Ask Witness

Preserve the existing Ask Witness experience and integrations.

The interface should feel like a technical investigation tool, not a generic consumer chatbot.

- Make the conversation readable and easy to navigate.
- Distinguish AI-generated explanations from linked evidence.
- Keep relevant investigation context accessible.
- Render code, technical identifiers, and evidence references clearly.
- Use restrained message styling instead of oversized chat bubbles.
- Provide clear loading, error, and empty states.

### Safeguards

Present existing safeguard and remediation workflows in a structured, understandable format.

- Clearly show the safeguard's purpose and current state.
- Make available configuration, review, testing, and verification information easy to locate.
- Distinguish proposed changes from applied changes.
- Make consequential actions visually clear and require the existing approval mechanisms.
- Preserve all existing enforcement and verification functionality.

## 7. Tables, Technical Data, and Status Indicators

Technical data is central to Underwatch, so tables and structured information must receive the same design attention as the main dashboard.

### Tables

- Use clear column headings and consistent alignment.
- Keep row heights compact without sacrificing readability.
- Apply subtle dividers rather than heavy grid lines.
- Provide clear hover and selected states.
- Preserve existing sorting, filtering, pagination, and row actions.
- Handle long values through wrapping, truncation with accessible full-value access, or horizontal scrolling where appropriate.

### Code and logs

- Use Geist Mono for code and raw technical values.
- Preserve whitespace and formatting where necessary.
- Distinguish source data from explanatory text.
- Make copying values straightforward wherever the existing functionality supports it.
- Avoid syntax colors that reduce readability on dark backgrounds.

### Status indicators

Use consistent labels and symbols for system states, findings, and verification outcomes.

Every status should have a readable text label. Color may reinforce the meaning but must not be the only signal.

Provide distinct states for loading, empty results, errors, stale information, and incomplete data.

## 8. Graphs and Visualizations

Preserve all existing graph functionality, including Neo4j integrations and actual graph relationships.

- Use a dark, low-contrast canvas that keeps relevant nodes and edges readable.
- Reserve the accent color for selected nodes, active paths, or meaningful interactions.
- Use restrained styling for ordinary nodes and relationships.
- Keep labels legible and prevent unnecessary overlap where possible.
- Make selection, hover, zoom, pan, and navigation states clear.
- Allow users to inspect relevant node and edge details where currently supported.
- Provide links to related findings, agent runs, and evidence where available.
- Preserve loading, empty, and error states.

Do not fabricate graph nodes, relationships, counts, or other data to improve the visual appearance. Avoid decorative visualizations that do not represent real system information.

## 9. Forms, Actions, and Feedback

Use consistent patterns for all interactive elements.

### Buttons

- Primary actions should be visually distinct but restrained.
- Secondary actions should not compete with the primary action.
- Destructive actions must be recognizable and use existing confirmation flows where appropriate.
- Use consistent sizing, padding, and corner radii.

### Forms

- Use clear labels and concise supporting text.
- Explain validation errors next to the relevant fields.
- Preserve existing validation and submission behavior.
- Show loading and submission states accurately.
- Never indicate success before the operation has succeeded.

### Notifications

Use unobtrusive notifications for successful operations, warnings, and errors.

Important or unresolved issues should remain visible in the relevant context rather than disappearing into a temporary toast.

## 10. Responsive Design and Accessibility

The application is primarily a desktop developer tool, but layouts should remain usable on smaller screens.

- Collapse or adapt the sidebar on narrow screens.
- Keep primary actions accessible.
- Allow tables and graphs to adapt without hiding essential information.
- Avoid fixed-width layouts that cause unintended overflow.
- Support keyboard navigation and visible focus indicators.
- Use accessible labels for controls and icons.
- Maintain readable contrast.
- Do not communicate important information through color or hover alone.
- Respect reduced-motion settings.

Responsive behavior must not break existing workflows or security-related controls.

## 11. Preserve Existing Functionality

This is a UI redesign, not a rebuild.

Before implementation, audit the existing repository and document its:

- Routes and navigation
- Pages and components
- Backend integrations and data flows
- Authentication and authorization
- Monitoring and event capture
- Findings and investigation workflows
- Graph functionality
- Safeguards and enforcement mechanisms
- Settings and configuration options
- Tests and existing interaction patterns

Reuse existing components and working functionality wherever possible. Adapt the design around the current architecture rather than rebuilding the application unnecessarily.

Do not replace functional features with mock data, static demonstrations, or nonfunctional placeholders.

Preserve background monitoring and security enforcement regardless of which page the user is viewing.

## 12. Implementation Process

### Phase 1: Audit

Inspect the existing application and create a complete feature inventory before changing the UI.

### Phase 2: Design mapping

Map existing pages and workflows to the proposed design system. Identify reusable components and any layout changes required.

### Phase 3: Implement

Implement the redesign within the existing architecture. Establish shared typography, color tokens, spacing, surfaces, controls, and interaction states before applying them across the application.

Prioritize consistency over one-off page styling.

### Phase 4: Verify

Test:

- All existing routes and navigation
- Existing data and backend integrations
- Findings, agent runs, evidence, and graph interactions
- Ask Witness and safeguard workflows
- Authentication and authorization
- Loading, empty, error, and stale-data states
- Responsive layouts and keyboard accessibility
- Existing automated tests and critical user workflows

Fix visual inconsistencies and functional regressions before completion.

### Phase 5: Report

Summarize the UI changes, existing functionality preserved, tests performed, and any known limitations. Do not claim that tests passed unless they were actually run.

## 13. Definition of Done

The redesign is complete when:

- The application has a consistent, polished Linear-meets-Vercel visual identity.
- Typography, colors, spacing, borders, surfaces, and interactions follow a shared design system.
- Navigation and page hierarchy make existing features easier to find.
- Technical information remains readable and easy to investigate.
- Graphs and other visualizations use real data and preserve existing interactions.
- Responsive layouts and accessibility have been considered.
- All existing functionality, routes, integrations, data, and security mechanisms remain intact.
- No functional feature has been replaced with a mock implementation.
- Existing workflows and tests have been checked, and remaining limitations are documented.

**Final instruction:** Make Underwatch feel like a precise, modern developer tool: minimal in appearance, rigorous underneath, and easy to navigate without hiding the technical detail that makes it trustworthy.

---

## Still in force from Addendum C (judge feedback) and the earlier brief

These are product requirements, not part of the UI spec above, and the redesign must keep them:
- **Finding reading modes:** a compact switch `Quick Read | Full Technical Details`. Quick Read is the default and shows Problem / Why it matters / How to fix, with honest status and evidence links. Full Technical Details keeps every existing panel and is organized as Agent report / Observed evidence / Applicable policy / Interpretation.
- **Contextual chatbot:** an "Ask about this issue" entry opens a small contextual panel holding the existing per-finding Ask Witness. It answers concisely by default, offers More detail and Explain simply, and keeps the user's context when closed.
- **Graph discoverability:** the existing Neo4j graph sits near the top of the relevant finding subsection, in this order: heading and one-line explanation, then the graph, then the key relationship explanation, then details. Only real data is used.
