# Underwatch
## Product Requirements Document (PRD)

**Product type:** AI coding-agent supervision and security tool  
**Primary user:** Software developers and engineers using AI coding agents  
**Initial integration:** Claude Code  
**Required sponsor technologies:** Neo4j and ai& Inference  
**Status:** Product specification; the Phase-1 foundation is implemented (see README)

**Addenda:**
- **A: Ask Witness + Safeguard Generation** ([`PRD-addendum-ask-witness.md`](./PRD-addendum-ask-witness.md), added 2026-10-17). It extends FR-7 (ai& explanations), FR-9 (safeguard generation) and FR-10 (verification runs) with an interactive investigator for each finding, `CLAUDE.md` / permission-rule / hook / regression-test safeguards applied to an authorized local workspace, and controlled verification. Where the addendum is more specific than this document, the addendum governs.
- **B: User-Controlled Findings Update Modes** ([`PRD-addendum-findings-modes.md`](./PRD-addendum-findings-modes.md), added 2026-10-17). The Findings view gets three presentation and refresh modes: Daily Digest, By Task (the default) and Current State, the last refreshing only when the user asks. Collection, finding generation and enforcement are explicitly decoupled from presentation. It refines §6.3 to §6.6: no auto-populating content, and the user decides when the view changes.
- **C: Judge feedback: two levels of detail, contextual chatbot, easier graph access** ([`PRD-addendum-judge-feedback.md`](./PRD-addendum-judge-feedback.md), added 2026-10-17 after a judge review). Every finding gets a concise Problem / Why it matters / How to fix explanation built on the same evidence, with the full technical investigation kept intact. A contextual per-finding chatbot answers concise-by-default follow-ups. Neo4j relationships are easier to discover inside a finding. All existing features are preserved (inventory before and after).

---

## 1. Product Overview

### 1.1 What is Underwatch?

Underwatch is a developer tool that independently observes the actions of AI coding agents, compares observed behavior against the agent's own reported activity and applicable permissions, and helps developers investigate discrepancies.

When an incident is verified, developers can turn it into a reusable safeguard and test whether that safeguard prevents the same problem from recurring.

### 1.2 Problem Statement

AI coding agents can read files, execute commands, modify repositories, and interact with external services. Developers have access to agent transcripts, tool logs, terminal output, and other monitoring tools, but these sources do not necessarily provide one reliable, connected account of what happened.

A developer may struggle to determine:
- What the agent attempted versus what actually happened.
- Which actions were permitted, denied, or outside the task's authorized scope.
- Which files or processes were affected.
- Whether the agent's report accurately describes the observed activity.
- How to prevent a verified incident from recurring.

Underwatch aims to reduce the effort required to answer these questions.

### 1.3 Product Vision

Give developers an independent, evidence-backed way to understand and supervise AI coding-agent activity without relying exclusively on the agent's own account.

### 1.4 Core Value Proposition

**Don't just trust what your coding agent says it did. Inspect the evidence, understand the discrepancy, and turn verified incidents into safeguards.**

---

## 2. Goals and Non-Goals

### 2.1 Goals

1. Capture relevant coding-agent activity independently of its final response.
2. Compare agent-reported actions with independently observed events.
3. Distinguish attempted, blocked, completed, and unverified actions.
4. Connect events to relevant files, processes, permissions, and task context.
5. Present discrepancies in a clear, evidence-linked investigation interface.
6. Use Neo4j to support connected incident investigations.
7. Use ai& Inference to generate evidence-grounded explanations.
8. Allow developers to create, review, and test safeguards based on verified incidents.
9. Make the observation coverage and limitations of the system visible.
10. Keep the system useful even when the AI explanation service is unavailable.

### 2.2 Non-Goals

The initial product is not intended to:
- Guarantee that an AI agent is safe.
- Detect every possible malicious action.
- Replace established endpoint detection or security monitoring products.
- Perform unrestricted kernel-level monitoring across every operating system.
- Support every coding agent from day one.
- Automatically rewrite agent instructions without user approval.
- Treat every unusual action as malicious.
- Use an LLM as the authority for determining whether an action occurred.
- Provide a complete semantic correctness review of every code change.
- Run on a developer's unrestricted host environment without an explicit security design.

---

## 3. Target Users and Use Cases

### Primary user: Developer using Claude Code

The developer wants to understand what happened during a coding session, especially when an agent behaves unexpectedly.

### Secondary user: AI platform or security engineer

The engineer wants traceable evidence of agent actions and a repeatable way to test restrictions.

### Core use cases

**UC-1: Review an agent run**

A developer opens a run and reviews its timeline, tool calls, observed system events, and discrepancies.

**UC-2: Investigate an unexpected action**

An agent attempts to access a sensitive file. The developer wants to understand the attempted action, whether it succeeded, which policy applied, and what evidence supports the finding.

**UC-3: Compare reported and observed activity**

The agent reports that it only modified a test file, while the independently collected evidence shows an additional file modification.

**UC-4: Understand an incident**

The developer requests an explanation of a discrepancy. The system summarizes the evidence without replacing it with an unsupported AI conclusion.

**UC-5: Create a safeguard**

The developer reviews a verified incident and generates a proposed instruction, permission rule, or other supported safeguard.

**UC-6: Test a safeguard**

The developer reruns a controlled scenario to check whether the safeguard prevents the problematic action and whether legitimate work still succeeds.

---

## 4. Core User Journey

1. The developer starts a supervised coding-agent session.
2. Underwatch records the session's available tool activity and independently observes supported system events.
3. The developer provides or confirms the task context and applicable restrictions.
4. The system correlates reported actions with observed events.
5. Potential discrepancies appear in the run timeline.
6. The developer opens a finding and inspects its evidence.
7. ai& optionally generates an explanation and recommended correction.
8. The developer creates and reviews a proposed safeguard.
9. The safeguard is applied through an appropriate supported mechanism.
10. A controlled rerun verifies whether the safeguard works.
11. The incident's status is updated using the new evidence.

The product must never report that a safeguard was successfully enforced or tested unless the corresponding action or test actually succeeded.

---

## 5. Functional Requirements

### FR-1: Supervised Agent Sessions

The system must support creating and reviewing supervised sessions.

Each session should contain:
- Unique run ID.
- Agent and adapter name.
- Start and end timestamps.
- User task description.
- Repository identifier and relevant revision.
- Applicable policy version.
- Observation coverage status.
- Event and finding counts.
- Run status.

The initial adapter should target Claude Code. Use documented integration points where possible, and isolate agent-specific logic behind an adapter interface.

### FR-2: Independent Event Collection

The system must collect supported events from sources independent of the agent's final narrative.

Potential event categories:
- Tool calls and their results.
- Process execution and subprocess relationships.
- File access attempts and supported file-change events.
- File modifications, including before/after state where available.
- Network connection attempts and outcomes where observable.
- Permission decisions.
- Agent-reported actions.
- Relevant repository changes.

For each event, store:
- Event ID.
- Run ID.
- Timestamp.
- Event source.
- Event type.
- Process or tool attribution, if known.
- Target resource, if known.
- Observed outcome.
- Evidence reference.
- Collection status and limitations.

**Important:** The implementation must not claim more than its telemetry establishes.

Examples:
- A file-open event does not necessarily prove the file contents were read.
- A connection attempt does not prove that data was transmitted.
- A successful write event does not prove that the file remained unchanged afterward.
- An event missing from the collected logs is not automatically proof that it never occurred.

Use a controlled execution environment where practical. Prefer independent observation and enforceable boundaries over relying exclusively on tool wrappers.

### FR-3: Agent Log Collection

Capture available agent-session events and tool-call records.

Normalize supported events into a common schema while retaining the original source and raw evidence reference.

The system should support:
- Reported tool calls.
- Reported action results.
- Reported file changes, where available.
- Final agent response.
- Relevant timestamps and identifiers.

If an event source does not expose a particular field, record it as unavailable rather than inventing it.

### FR-4: Discrepancy Detection

Compare reported activity with observed evidence.

Initial discrepancy categories:

1. **Unreported observed action:** An observed action has no matching agent-reported event.
2. **Outcome mismatch:** The agent reports success, but available independent evidence indicates failure or denial.
3. **Change mismatch:** Reported file changes do not match the repository changes observed.
4. **Permission violation:** An observed action conflicts with an applicable, explicit policy.
5. **Uncertain correlation:** Related events cannot be matched confidently.

Discrepancy detection must account for:
- Timestamp differences.
- Different event granularity.
- Subprocesses and delegated actions.
- Missing telemetry.
- Duplicate event records.
- Concurrent activity.
- Legitimate differences between an agent's high-level report and low-level system events.

Do not label every unmatched event as malicious. The system should distinguish a confirmed policy violation from a discrepancy that needs review.

Each finding must include:
- Finding ID.
- Category.
- Short title and explanation.
- Related event IDs.
- Applicable policy, if any.
- Evidence supporting the finding.
- Confidence level.
- Severity.
- Current status.
- Recommended next step.

Confidence and severity must be separate fields.

### FR-5: Incident Investigation

Selecting a finding opens an investigation view containing:

- Summary of the discrepancy.
- Agent-reported event.
- Corresponding independently observed event.
- Timestamp and outcome.
- Relevant process, file, or resource.
- Applicable permission or policy.
- Links to the supporting evidence.
- Explanation of missing or incomplete evidence.
- Recommended investigation steps.

The user must be able to inspect the underlying evidence rather than being forced to trust an AI-generated summary.

### FR-6: Incident Lifecycle

Findings must have explicit statuses:

- **New:** A potential issue was detected.
- **Under review:** The developer is investigating.
- **Confirmed:** Evidence supports the finding.
- **Resolved:** New evidence establishes that the issue was addressed.
- **Dismissed:** The finding was reviewed and determined not to represent a violation.
- **Unresolved:** Available evidence is insufficient to determine the outcome.

A dismissed finding must retain its history. A resolved finding must not disappear from historical records.

A later recurrence should be identifiable as a potential regression.

### FR-7: AI-Assisted Explanation Using ai&

Integrate ai& Inference for evidence-grounded incident explanations.

The AI may:
- Summarize a discrepancy.
- Explain why an event may matter.
- Compare relevant agent reports and observed evidence.
- Identify missing evidence.
- Suggest next investigative steps.
- Propose a safeguard.
- Generate a controlled regression scenario.

The AI must not:
- Invent observed events.
- Modify the underlying evidence.
- Override deterministic permission decisions.
- Mark a finding confirmed solely because its own analysis says so.
- Claim a prevention or verification test passed without an actual result.

AI explanations must reference existing evidence IDs or other verifiable references. If the evidence is insufficient, the explanation should explicitly say so.

Implementation requirements:
- Use the current official ai& API documentation and a supported model.
- Keep provider-specific integration behind an interface.
- Validate structured responses against a defined schema.
- Redact secrets before sending context to the inference service.
- Limit context to relevant evidence.
- Handle timeouts, rate limits, malformed responses, and unavailable services.
- Cache repeatable analyses when the underlying evidence and prompt version are unchanged.
- Record model and prompt versions for reproducibility.
- Treat repository files, logs, and tool output as untrusted data.

AI analysis must be optional. Core event collection, discrepancy detection, and enforcement must not depend on ai& being available.

### FR-8: Neo4j Evidence Graph

Neo4j must support useful investigations rather than serving solely as a visualization database.

Initial node types:
- `Run`
- `Task`
- `Policy`
- `AgentEvent`
- `ObservedEvent`
- `Process`
- `Resource`
- `Finding`
- `Evidence`
- `Safeguard`
- `VerificationRun`

Initial relationships:
- `HAS_TASK`
- `HAS_EVENT`
- `REPORTS`
- `OBSERVED_AS`
- `SPAWNED`
- `TARGETS`
- `VIOLATES`
- `SUPPORTED_BY`
- `CONTRADICTS`
- `PROPOSED_AS`
- `VERIFIED_BY`
- `RECURRED_AS`

Relationships must distinguish direct observation from inferred correlation.

The graph should answer questions such as:
- Which observed events support this finding?
- Which agent report was compared against each observed event?
- Which process generated a particular event?
- Which policy was in effect when the action occurred?
- Which safeguard was created from an incident?
- Did a subsequent verification run reproduce or prevent the behavior?

Every run must retain its own policy version and evidence references. Later changes must not silently rewrite historical conclusions.

Use a stable event ID to deduplicate records and make ingestion idempotent.

Detailed event payloads may be stored separately, with the graph holding structured metadata and relationships. Do not store every large raw log directly in Neo4j without a reason.

### FR-9: Safeguard Generation

Provide an action called **Turn incident into a safeguard**.

The workflow should:

1. Require a finding with sufficient evidence.
2. Show the relevant incident and supporting evidence.
3. Generate a proposed safeguard.
4. Identify the mechanism through which it could be applied.
5. Explain what behavior it intends to prevent.
6. Identify possible effects on legitimate workflows.
7. Require developer review and approval.
8. Apply the safeguard only through a supported, authorized mechanism.
9. Offer a controlled verification run.

Supported safeguard types may include:
- A project instruction added to `CLAUDE.md`.
- A Claude Code permission configuration.
- A supported hook or policy check.
- A regression test.

Do not present all these mechanisms as interchangeable. Project instructions influence model behavior; permissions and enforcement controls can impose stronger boundaries; tests verify specific outcomes.

For the initial version, prioritize proposing and applying a reviewed project instruction and a supported permission rule. Only implement additional safeguard mechanisms when their behavior is documented and testable.

Never silently change security policies or allow the supervised agent to approve its own proposed changes.

### FR-10: Verification Runs

A verification run should record:
- The original finding.
- The safeguard under test.
- The execution environment.
- The scenario being tested.
- The observed events.
- Whether the prohibited behavior was attempted.
- Whether it was blocked.
- Whether legitimate behavior still worked.
- Test results and evidence references.

A safeguard is not verified merely because the agent claims to comply.

The UI must distinguish:
- Proposed.
- Applied.
- Test pending.
- Verified for the tested scenario.
- Failed verification.
- Verification inconclusive.

Do not generalize a successful test to all possible attacks or environments.

### FR-11: Coverage and Health

Show the observation coverage for each run.

Display:
- Active event sources.
- Available event categories.
- Unsupported capabilities.
- Collection errors.
- Missing telemetry.
- Whether process attribution is available.
- Whether network outcomes can be observed.
- Whether the run's final state is complete.

The product must not display an unqualified “All safe” result when important telemetry is unavailable or analysis is incomplete.

---

## 6. User Interface Requirements

### 6.1 Design Direction

Create a polished, developer-oriented security interface.

Visual direction:
- Charcoal or near-black background.
- Off-white text.
- Restrained amber for warnings.
- Red for meaningful security risks.
- Green for verified positive outcomes.
- Clear typography and compact information density.
- Minimal decorative elements.
- No chatbot-first homepage.
- No oversized empty dashboard cards.
- No unnecessary animations.

The primary visual hierarchy should emphasize the incident, its evidence, and the next useful action.

### 6.2 Application Navigation

Initial navigation:
1. Overview
2. Agent Runs
3. Findings
4. Safeguards
5. Settings

### 6.3 Overview Page

Display:
- Recent runs.
- Runs needing review.
- New discrepancies.
- Confirmed findings.
- Safeguards awaiting approval.
- Recent verification results.
- Observation system health.

Every metric must come from actual persisted data. Do not use hardcoded production-looking counts.

Empty states should explain how to create the first supervised run.

### 6.4 Agent Runs Page

Provide a searchable, filterable list of runs.

Each row should show:
- Run ID or readable label.
- Agent.
- Task summary.
- Start time.
- Number of captured events.
- Number of findings.
- Coverage status.
- Run status.

Filters should include agent, status, time range, and findings.

### 6.5 Run Detail Page

This is the main workspace.

Include:
- Run summary.
- Task and applicable policies.
- Event timeline.
- Reported-versus-observed comparison.
- Finding list.
- Observation coverage.
- Evidence inspection.

Users should be able to filter by event type, outcome, process, and finding.

### 6.6 Finding Detail Page

Include:
- Finding title and status.
- Severity and confidence as separate attributes.
- Why it was flagged.
- Reported event.
- Observed event.
- Relevant policy.
- Evidence references.
- AI-generated explanation, if available.
- Missing information.
- Recommended next step.
- Buttons to confirm, dismiss, resolve, or propose a safeguard.

Each status-changing action must persist and be reflected across the application.

### 6.7 Evidence Graph

Display a focused graph of the entities connected to the selected finding.

Users should be able to:
- Select a node.
- Inspect its details.
- Follow relationships.
- Jump to the relevant timeline event.
- See whether a relationship was observed, derived, or inferred.

The graph must support investigation, not merely look impressive.

### 6.8 Safeguards Page

Display:
- Proposed safeguards.
- Approved safeguards.
- Applied safeguards.
- Verification status.
- Linked incident.
- Last verification result.

For each safeguard, show the actual configuration or instruction that will be applied, the mechanism used, and the expected effect.

### 6.9 Settings Page

Include:
- Agent adapter status.
- Event collection configuration.
- Policy settings.
- ai& configuration status.
- Neo4j connection status.
- Data retention and redaction settings.

Never expose API keys or credentials in the UI.

---

## 7. Technical Architecture

### 7.1 Recommended Structure

Separate the application into the following components:

**Frontend**
- Application navigation and investigation UI.
- Run timeline and evidence comparison.
- Finding management.
- Graph visualization.
- Safeguard review and verification.

**Backend API**
- Session management.
- Event ingestion and normalization.
- Finding lifecycle.
- Policy evaluation.
- Evidence retrieval.
- Safeguard workflow.
- Verification-run orchestration.

**Agent adapter**
- Claude Code integration.
- Session and tool-event collection.
- Agent-specific event normalization.
- Capability reporting.

**Observation layer**
- Supported runtime event capture.
- Repository and file-change observation.
- Process attribution where available.
- Sandbox integration and enforcement.

**Analysis layer**
- Deterministic event correlation.
- Policy checks.
- ai& explanations and recommendations.
- Verification orchestration.

**Data layer**
- Neo4j for relationships and investigations.
- Structured persistence for application entities and detailed event records as appropriate.
- Protected evidence storage for raw logs or snapshots where needed.

Keep components modular. Avoid unnecessary microservices for the initial implementation.

### 7.2 Architectural Principles

- Keep observation separate from agent-reported logs.
- Keep policy enforcement independent of AI.
- Keep evidence immutable or append-only wherever practical.
- Version policies and execution contexts.
- Use stable identifiers and idempotent ingestion.
- Preserve raw evidence references.
- Make unavailable capabilities explicit.
- Ensure the agent cannot modify its own authoritative evidence or approve its own safeguards.

### 7.3 Execution Environment

Prefer running the initial supervised agent in an isolated environment that Underwatch can observe and control.

Document exactly which events are captured and which enforcement mechanisms are active.

Do not claim comprehensive kernel-level monitoring unless the implementation genuinely provides it.

If the initial integration uses a container, explicitly document its limitations and avoid exposing the host's credentials or sensitive files.

### 7.4 Sponsor Integration Requirements

**Neo4j**
- Persist and query the evidence graph.
- Support investigation queries and historical relationships.
- Demonstrate at least one investigation that would be materially harder with a flat event list.

**ai& Inference**
- Generate structured, evidence-grounded explanations.
- Propose a safeguard from a verified incident.
- Operate behind a provider abstraction.
- Fail gracefully when unavailable.

Verify current API endpoints, authentication, supported models, rate limits, and structured-output capabilities against official documentation before implementation.

Do not invent SDK methods or assume every advertised model supports every API feature.

---

## 8. Data Model

Core entities:

### Run
- `id`
- `agent_type`
- `task_description`
- `repository_id`
- `repository_revision`
- `policy_version`
- `started_at`
- `ended_at`
- `status`
- `coverage_status`

### Event
- `id`
- `run_id`
- `source`
- `event_type`
- `timestamp`
- `process_id`
- `parent_process_id`
- `target_resource`
- `outcome`
- `evidence_reference`
- `attribution_confidence`

Unavailable fields must be nullable rather than fabricated.

### Finding
- `id`
- `run_id`
- `category`
- `title`
- `description`
- `severity`
- `confidence`
- `status`
- `policy_id`
- `created_at`
- `updated_at`

### Evidence
- `id`
- `source_type`
- `source_reference`
- `timestamp`
- `integrity_metadata`
- `redaction_status`

### Safeguard
- `id`
- `finding_id`
- `type`
- `content`
- `application_mechanism`
- `approval_status`
- `application_status`
- `created_at`
- `approved_at`

### VerificationRun
- `id`
- `safeguard_id`
- `scenario_id`
- `environment_id`
- `result`
- `evidence_references`
- `started_at`
- `ended_at`

Use migrations or versioned schema changes. Keep identifiers consistent across the application database, graph, and evidence records.

---

## 9. Security and Privacy Requirements

- Never log secret values unnecessarily.
- Redact credentials before model requests.
- Restrict access to raw logs and repository contents.
- Keep agent-controlled writes away from authoritative evidence and policy storage.
- Use least-privilege execution permissions.
- Isolate verification runs from production environments.
- Require explicit approval before applying safeguards.
- Record policy and safeguard changes.
- Treat repository files and tool output as untrusted input.
- Do not execute AI-generated commands or policies without appropriate validation and approval.
- Avoid sending entire repositories to an external inference service when a small evidence subset suffices.
- Handle failed or partial collection honestly.
- Provide a documented retention policy.

The system should not assume that a graph database or append-only application design alone guarantees tamper-proof evidence. Integrity protections must be designed and tested separately.

---

## 10. Acceptance Criteria

The product is not considered complete merely because its pages render.

### Session and event collection
- [ ] A supported Claude Code session can be associated with a Underwatch run.
- [ ] Agent-reported events and independently observed events retain distinct provenance.
- [ ] Supported events are normalized and persisted.
- [ ] Duplicate ingestion does not create duplicate logical events.
- [ ] Missing telemetry is visible.

### Discrepancy detection
- [ ] A seeded discrepancy produces the expected finding.
- [ ] A legitimate matched action does not automatically produce a violation.
- [ ] Blocked and completed actions are distinguishable where evidence supports that distinction.
- [ ] Findings link to their supporting evidence.
- [ ] Confidence and severity are independent.

### Investigation
- [ ] A developer can inspect the agent report, observed event, relevant policy, and evidence.
- [ ] Neo4j supports at least one multi-step investigation query.
- [ ] Historical findings preserve their original run and policy context.
- [ ] Finding status changes persist.

### ai& integration
- [ ] The system produces a structured explanation for a supported finding.
- [ ] Explanation references resolve to actual evidence.
- [ ] Invalid or unsupported claims are not treated as verified facts.
- [ ] API failure does not disable deterministic detection or evidence access.
- [ ] Sensitive values are redacted before external model requests.

### Safeguards
- [ ] A developer can propose and review a safeguard from a finding.
- [ ] Applying a safeguard requires explicit approval.
- [ ] Application status reflects the actual result.
- [ ] A controlled verification run records observed outcomes.
- [ ] A successful test is reported only for the tested scenario.

### UI
- [ ] Every primary navigation item works.
- [ ] Loading, empty, error, and populated states are implemented.
- [ ] Findings and safeguards remain consistent across pages.
- [ ] No fake production metrics are displayed.
- [ ] The evidence graph and timeline link to the same underlying records.

---

## 11. Validation Plan

Create controlled fixtures for:

1. Agent-reported activity matching observed activity.
2. An observed action missing from agent-reported logs.
3. An explicitly forbidden file-access attempt.
4. A blocked action versus a successful action.
5. A legitimate credential access permitted by policy.
6. Duplicate events from multiple collection sources.
7. Missing telemetry and uncertain event attribution.
8. A safeguard that blocks the seeded scenario.
9. A safeguard that fails to block the scenario.
10. A safeguard that blocks legitimate behavior unexpectedly.

For every fixture, define expected events, findings, evidence, and status before running the test.

Measure:
- Precision and recall on labeled discrepancy fixtures.
- False alerts on legitimate behavior.
- Event attribution accuracy.
- Evidence completeness.
- Duplicate-event handling.
- Safeguard verification accuracy.
- Runtime overhead.
- ai& latency, failures, and cost.

These are planned tests, not claimed results. Report actual outcomes only after execution.

---

## 12. Implementation Sequence

### Phase 1: Foundation
- Establish the repository structure and architecture.
- Define event, run, finding, and policy schemas.
- Build the backend and persistence layer.
- Implement the core UI shell and navigation.

### Phase 2: First supervised agent
- Implement the Claude Code adapter.
- Capture supported session events.
- Add independent observation in a controlled environment.
- Display event provenance and coverage.

### Phase 3: Discrepancy engine
- Normalize and correlate events.
- Implement deterministic policy checks.
- Persist findings and evidence references.
- Add the investigation timeline.

### Phase 4: Neo4j
- Implement the evidence graph.
- Add investigation queries.
- Link graph entities to timeline events and findings.

### Phase 5: ai& inference
- Implement evidence-grounded explanations.
- Validate structured responses.
- Add safeguard suggestions and error handling.

### Phase 6: Safeguard workflow
- Add review and approval.
- Apply supported instructions or permission controls.
- Run controlled verification scenarios.
- Track verification outcomes.

### Phase 7: Validation and polish
- Execute the validation matrix.
- Fix false alerts and attribution issues.
- Verify the complete user journey.
- Improve error, loading, and empty states.
- Document coverage and known limitations.

Do not expand to more agent adapters until the first adapter's observation and enforcement capabilities are documented and tested.

---

## 13. Required Demonstration Scenario

The product should support a reproducible demonstration:

1. Start a supervised coding-agent run.
2. Ask the agent to perform a legitimate coding task.
3. Include a controlled scenario where the agent attempts a restricted action.
4. Show the independent event and the corresponding permission outcome.
5. Open the discrepancy in Underwatch.
6. Inspect the evidence and Neo4j relationships.
7. Request an ai& explanation.
8. Generate and approve a safeguard.
9. Rerun the controlled scenario.
10. Show whether the safeguard actually prevented the action and whether the legitimate task still works.

The demonstration must use a disposable environment, synthetic secrets, and controlled scenarios. It must not rely on real credential exposure or unrestricted network access.

---

## 14. Instructions to the Coding Agent

Before implementing:

1. Inspect the existing repository, dependencies, and project conventions.
2. Identify the current framework, database setup, and existing functionality.
3. Compare the repository against this PRD.
4. Propose a concrete implementation plan and identify unresolved technical dependencies.
5. Verify the current official documentation for Claude Code integration, Neo4j, and ai&.
6. Identify which runtime events can genuinely be observed and which actions can genuinely be blocked in the chosen environment.
7. Report any conflicts between the existing repository and the PRD.

Do not claim that an integration works until it has been exercised and verified.

Do not fabricate API responses, monitoring results, evidence, or test outcomes. Mock data may be used for UI development, but it must be clearly separated from live functionality.

Preserve existing working functionality unless a change is justified and approved.

**Do not begin implementation until the architecture, observation boundary, and integration approach have been reviewed.**

The final deliverable should be a working, testable application with traceable evidence, not merely a visually convincing prototype.
