# Underwatch: Product Requirements Document (Judge Feedback)

> Addendum C to [`PRD.md`](./PRD.md). Added 2026-10-17 from a hackathon judge review; recorded as received. Implementation notes are in [`JUDGE-FEEDBACK.md`](./JUDGE-FEEDBACK.md).

## 1. Product Vision

Underwatch helps developers independently verify what AI coding agents actually do, investigate discrepancies between reported and observed behavior, and turn verified incidents into tested safeguards.

The core principle is: **AI can explain the evidence, but it must not decide what happened.**

The product should help developers understand potential issues quickly, investigate them rigorously when necessary, and take informed action without sacrificing technical depth or evidence integrity.

## 2. Critical Requirement: Preserve All Existing Features

This project extends and improves the existing Underwatch product. It is not a rebuild or a replacement.

Before making changes, inspect the existing repository and document all current features, routes, workflows, integrations, backend services, data models, monitoring mechanisms, and security controls.

The following requirements are mandatory:

- Preserve all existing features and capabilities, including those not explicitly mentioned in this PRD.
- Preserve existing backend logic, API contracts, database behavior, integrations, authentication, authorization, permissions, and data flows.
- Preserve existing agent monitoring, event capture, evidence collection, policy enforcement, and safeguard mechanisms.
- Do not replace functional features with mock data, placeholders, static demonstrations, or nonfunctional alternatives.
- Extend existing functionality wherever possible rather than duplicating or rebuilding it unnecessarily.
- Do not remove or weaken existing capabilities to simplify the product.
- Seek approval before making breaking changes or removing existing functionality.

After implementation, compare the result against the original feature inventory, verify that existing workflows still work, and document any regressions or incomplete functionality.

**Priority: preserve existing functionality first, improve usability second, and add new capabilities third.**

## 3. New Requirement: Two Levels of Detail for Findings

### Problem

Reviewing the complete findings and technical investigation can take too long. Developers need to understand an issue quickly, but they must also retain access to the detailed evidence required to investigate it properly.

### Requirement

Every applicable finding must support two levels of detail:

**A. Concise explanation**

Provide a short, easy-to-understand explanation organized around three questions:

- **Problem:** What happened or what potential issue was identified?
- **Why it matters:** What are the implications, risks, or consequences?
- **How to fix it:** What specific action should the developer take next?

The concise explanation should prioritize the most important information and use plain language. Technical terminology should be explained when necessary.

Where relevant, it should identify the affected agent, task, resource, or permission; summarize the evidence supporting the finding; and disclose important uncertainty.

Recommendations must be actionable and specific to the issue. Clearly distinguish proposed actions from actions that have actually been performed, tested, or verified.

The objective is to let a developer understand the essential issue and determine the next step without reading the entire technical report.

**B. Full technical details**

Preserve the existing detailed investigation experience, including its information, evidence, and functionality.

This includes all applicable agent reports, observed events, technical logs, policies, permissions, timelines, AI analyses, investigation history, graph relationships, security outcomes, task outcomes, safeguard details, and verification results.

The full version must not lose, omit, or silently rewrite existing information as part of introducing the concise explanation.

### Data consistency

Both levels of detail must rely on the same underlying findings and evidence. The concise explanation is a different level of presentation, not a separate source of truth.

The concise version must not introduce unsupported conclusions, conceal important qualifications, or imply certainty beyond what the evidence establishes.

The full technical report must remain available to authorized users.

## 4. New Requirement: On-Demand Explanations Through a Contextual Chatbot

### Problem

Even a concise explanation may not answer every developer's questions. Some developers will want additional context, simpler explanations, or guidance on interpreting the evidence without having to read the entire technical investigation.

### Requirement

Provide an optional chatbot that allows developers to ask follow-up questions about a specific finding.

The chatbot must understand the context of the current finding and help users explore the issue incrementally.

It should be able to answer questions such as:

- Why is this a problem?
- Can you explain this in simpler terms?
- What evidence supports this conclusion?
- What could happen if this issue is ignored?
- Why does the agent's report differ from the observed behavior?
- How should I fix this issue?
- How can I verify that the fix works?
- What additional technical details should I know?

Responses should be concise by default, with additional depth provided when requested.

### Evidence and accuracy requirements

The chatbot must:

- Ground explanations in the existing finding, evidence, policies, and investigation data.
- Distinguish observed facts from interpretations and recommendations.
- Acknowledge missing information and uncertainty.
- Reference supporting evidence when available.
- Never fabricate events, evidence, citations, test results, or remediation outcomes.
- Never claim that an action was performed or a safeguard was verified unless the underlying system confirms it.
- Respect existing authentication, authorization, permissions, and sensitive-data handling rules.

The chatbot should complement the concise explanation and full technical report, not replace either of them.

Reuse existing AI integrations and investigation capabilities where possible. Do not introduce a disconnected mock chatbot or duplicate existing functionality unnecessarily.

## 5. Improvement to Existing Neo4j Graph Exploration

### Problem

The existing Neo4j graphs are a valuable part of Underwatch because they help developers understand relationships among events, agents, resources, and other relevant entities. However, developers should be able to discover and benefit from these relationships without having to navigate through extensive technical explanations first.

### Requirement

Make the existing Neo4j graph information easier to access within the relevant finding or investigation.

Developers should be able to understand the important relationships associated with an issue and investigate the underlying connections when useful.

Preserve existing graph functionality, data connections, relationships, and interactions. Continue using actual Neo4j data rather than fabricated or illustrative relationships.

Where supported by the existing implementation, developers should be able to inspect relevant entities and relationships and navigate to associated findings, agent runs, and evidence.

### Graph integrity

- Do not invent graph nodes, relationships, or statistics.
- Do not remove existing graph capabilities as part of this improvement.
- Clearly distinguish actual relationships from inferred interpretations.
- Preserve access controls and sensitive-data protections.
- Handle unavailable, incomplete, or failed graph data honestly.
- Ensure that the graph supports investigation rather than presenting relationships as proof of an event without supporting evidence.

The purpose of this change is to improve access to an existing capability, not to replace the graph system or change its underlying data model unnecessarily.

## 6. Findings and Investigation

Underwatch must continue to help developers compare what an AI coding agent reported with what the system independently observed.

Each applicable investigation should preserve the distinction between:

- **Agent report:** What the agent claims it did.
- **Observed evidence:** What the system independently recorded.
- **Applicable policy:** Which rules and permissions applied.
- **Interpretation:** What the available evidence may mean.

The product should support investigation from an initial finding through the underlying evidence and any resulting remediation.

Security outcomes and task outcomes must remain separate. For example, blocking a potentially unsafe action does not automatically establish that the legitimate task succeeded.

When evidence is insufficient, the system must communicate that the outcome is unknown or inconclusive rather than infer success from the agent's own report.

All existing findings, filtering, searching, sorting, investigation history, evidence navigation, and related capabilities must be preserved.

## 7. Findings Organization and Refresh Behavior

Preserve the three findings views established in the existing product requirements:

1. **Daily Digest:** A summary of meaningful activity and findings over a defined period.
2. **Task-Based Findings:** Findings organized around an agent run, coding task, or investigation.
3. **Current State / On-Demand Refresh:** The latest available system snapshot, updated when the user requests a refresh.

These are separate from the two levels of detail described in Section 3. They determine how findings are organized or refreshed, not whether the underlying information is available.

Selecting a view or changing the level of detail must not disable, pause, or alter background monitoring, event capture, evidence collection, or security enforcement.

Refresh operations must accurately report their status and must not present stale or incomplete information as current.

Preserve existing filters, selection state, and investigation context wherever practical.

## 8. Safeguards and Remediation

Underwatch should continue helping developers turn verified incidents into preventive measures.

Preserve existing safeguard functionality, including applicable configuration changes, coding-agent instructions, permission rules, hooks, policy checks, regression tests, and verification workflows.

Where supported, remediation should follow the progression:

**Investigate → Propose → Review → Test → Verify**

For each safeguard, developers should be able to determine:

- Which issue it addresses.
- What evidence supports the proposed change.
- What the safeguard actually enforces.
- Whether it has been tested.
- What the test demonstrated.
- Whether the safeguard has been applied and verified.

A written instruction must not be presented as equivalent to technical enforcement. The system must not claim a safeguard is active or effective without supporting confirmation.

Preserve appropriate approval requirements for consequential changes.

## 9. Data Integrity, Privacy, and Security

All new and existing functionality must respect Underwatch's security and data-handling requirements.

- Preserve authentication, authorization, and access controls.
- Apply appropriate sensitive-data handling and redaction.
- Do not expose secrets through findings, evidence, graph exploration, or chatbot responses.
- Keep observed events distinct from AI-generated interpretations.
- Maintain provenance for evidence and conclusions wherever supported.
- Communicate missing, stale, incomplete, or unavailable information honestly.
- Do not weaken monitoring or enforcement mechanisms to accommodate new features.

New explanations and summaries must not be treated as independent evidence. They must remain traceable to the underlying records that support them.

## 10. Implementation and Verification Requirements

Before implementation, audit the existing repository and identify the current architecture, features, integrations, data flows, and tests.

Then implement the changes as extensions to the existing product.

Verify that:

- The concise explanation covers the problem, why it matters, and how to fix it.
- The original detailed investigation remains available and retains its existing functionality.
- Both levels of detail use consistent underlying evidence.
- The chatbot answers questions in the context of the selected finding and follows evidence and security requirements.
- The existing Neo4j graphs remain functional and are easier to discover during investigations.
- Findings organization and refresh behavior continue to work.
- Monitoring, evidence collection, enforcement, and safeguards remain operational.
- Existing routes, integrations, permissions, and workflows have not regressed.
- Relevant automated tests and new functionality tests pass when actually executed.

Report any regressions, incomplete integrations, or limitations honestly. Do not claim successful verification when a test has not been performed.

## 11. Definition of Done

The changes are complete when:

1. Developers can understand the essential problem, its significance, and the recommended fix quickly.
2. The original detailed investigation remains intact and accessible.
3. Developers can request further explanations through a contextual chatbot without losing access to the underlying evidence.
4. Existing Neo4j graph information is easier to discover and investigate.
5. Summaries and chatbot responses remain grounded in the same evidence as the full investigation.
6. Existing features, integrations, routes, workflows, and security mechanisms are preserved.
7. The new functionality has been tested, and remaining limitations are documented.

**Final principle:** Make Underwatch faster to understand without making it less rigorous. Developers should be able to get the essential answer quickly, explore further when needed, and retain full access to the evidence and functionality that make the product trustworthy.
