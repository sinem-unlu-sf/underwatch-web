# Underwatch PRD: Ask Witness + Safeguard Generation

> Addendum A to [`PRD.md`](./PRD.md). Added 2026-10-17. Implementation notes, including how local `CLAUDE.md` access works, are in [`ASK-WITNESS.md`](./ASK-WITNESS.md).

## 1. Overview

### Product context

Underwatch helps developers investigate AI coding-agent activity by connecting agent-reported actions with independently observed system events, applicable policies, findings, and safeguards.

This PRD adds two connected capabilities:

1. **Ask Witness:** An interactive, evidence-grounded incident investigator that lets developers ask questions about a specific finding and understand what happened, what is known, and what remains uncertain.
2. **Safeguard Generation:** A workflow that turns an investigated finding into a proposed `CLAUDE.md` update, permission rule, hook, or regression test, with user approval and verification.

The features must work with the existing Underwatch application. Extend the current implementation instead of rebuilding it.

### Core user value

Developers should be able to move from a confusing incident to an understandable explanation and a tested improvement without manually piecing together logs or writing every safeguard from scratch.

### Design principle

AI helps interpret evidence and propose improvements. It does not independently establish what happened, enforce security policies, or certify that a safeguard works.

- Neo4j connects the evidence.
- Deterministic application logic retrieves and validates the evidence.
- ai& powers the interactive investigation and generates candidate safeguards.
- The user reviews and approves changes.
- Existing enforcement mechanisms and controlled tests determine whether a safeguard works.

---

## 2. Goals and non-goals

### Goals

- Allow natural-language questions about an individual finding.
- Provide answers grounded in evidence associated with that finding.
- Clearly distinguish verified observations, hypotheses, and unknowns.
- Let users inspect the evidence supporting an answer.
- Generate context-specific safeguards based on an investigated finding.
- Support proposing and reviewing updates to `CLAUDE.md`.
- Support other enforcement mechanisms where the existing architecture permits them.
- Show diffs before changing files.
- Require explicit approval before modifying files or enforcement settings.
- Test approved safeguards in a controlled environment.
- Record the investigation, safeguard, and verification outcome.
- Preserve the existing application architecture, design system, and functionality.

### Non-goals

- Replacing the existing dashboard or redesigning the whole application.
- Allowing an AI model to run arbitrary shell commands, edit files, or modify security policies autonomously.
- Treating every discrepancy as malicious behavior.
- Claiming that `CLAUDE.md` instructions guarantee enforcement.
- Claiming that an incident is resolved merely because an AI generated a recommendation.
- Implementing comprehensive autonomous security remediation.
- Building an unrestricted chatbot that can access arbitrary repositories or unrelated user data.

---

## 3. Feature A: Ask Witness

### 3.1 User story

As a developer investigating a finding, I want to ask questions in natural language and receive an explanation linked to the underlying evidence, so that I can understand what happened without manually inspecting every event.

### 3.2 Entry point

Add an Ask Witness panel to the existing finding detail page.

The panel must know which finding and agent run the user is investigating. Users should not need to copy IDs or manually provide context.

Include suggested questions such as:

- Why was this finding flagged?
- Did the agent actually access the file, or was the attempt blocked?
- Which evidence supports this conclusion?
- What happened immediately before and after this event?
- Is there another plausible explanation?
- What information is still missing?
- Have similar findings occurred in other runs?
- What safeguard would reduce the chance of recurrence?

Allow users to submit their own questions.

### 3.3 Investigation context

When the user asks a question, the backend must retrieve relevant context from the existing data stores.

Use Neo4j to traverse the relationships among:

- The finding being investigated.
- The associated agent run.
- Agent-reported actions.
- Independently observed events.
- Relevant files, processes, or other resources.
- Applicable policies and permission decisions.
- Existing safeguards and their verification results.
- Related findings, when relevant to the question.

Retrieve detailed evidence payloads from the existing evidence store when necessary.

Do not send the entire graph, every log, or an entire repository to the model by default. Retrieve the smallest evidence bundle sufficient to answer the question.

Every evidence item sent to the model should include, where available:

- Stable evidence ID.
- Source and source type.
- Timestamp.
- Event or action type.
- Target resource.
- Reported or observed outcome.
- Relevant policy context.
- Collection limitations or uncertainty.
- A reference back to the underlying record.

Agent-reported actions and independently observed events must remain distinguishable throughout the pipeline.

### 3.4 ai& integration

Use the ai& Inference API through a server-side integration compatible with the existing backend.

Before implementation, inspect the current code and verify the applicable ai& API documentation, authentication requirements, supported models, and structured-output capabilities.

Use environment variables for credentials and model configuration. Never expose API keys to the frontend.

The model should receive:

1. The user's question.
2. The finding's relevant evidence bundle.
3. Relevant policies and safeguard context.
4. Instructions to distinguish facts, hypotheses, and unknowns.
5. A response schema supported by the selected model and API configuration.

The backend, not the model, controls database access and evidence retrieval. Do not allow the model to execute arbitrary Cypher or select unrestricted records directly.

### 3.5 Response format

Define and validate a structured response with these fields:

- `summary`: concise answer to the user's question.
- `verified_facts`: claims directly supported by the retrieved evidence.
- `hypotheses`: plausible explanations that are not confirmed.
- `unknowns`: questions the current evidence cannot resolve.
- `evidence_references`: IDs of supporting records.
- `recommended_next_steps`: useful investigation actions.
- `recommended_safeguards`: candidate improvements, if relevant.

Each fact or hypothesis should reference supporting evidence IDs where available.

The backend must verify that every returned evidence ID exists in the evidence bundle supplied to the model. Reject, remove, or flag unsupported references.

Valid JSON does not prove a statement is true. The UI must not label a claim as verified solely because the model returned it in the `verified_facts` field. Apply application-level validation before assigning that label.

If evidence is insufficient, the response should say so instead of inventing a definitive explanation.

### 3.6 Evidence-grounded conversation

Support follow-up questions within the same investigation.

Follow-up questions should preserve the current finding context without automatically expanding access to unrelated runs or repositories.

The interface should make it possible to inspect the referenced evidence directly, such as by opening an event detail panel or highlighting an item in the existing evidence graph.

When the user asks about evidence that is not available, explain the limitation and suggest what additional information would help.

Do not present a model-generated explanation as an event record. Store AI responses separately from the underlying observations.

### 3.7 UI requirements

Add an Ask Witness panel to the existing finding detail view.

It should include:

- Suggested question chips.
- A natural-language input.
- Conversation history for the current investigation.
- A loading indicator.
- Clear error states when ai& is unavailable.
- A structured answer with separate sections for facts, hypotheses, and unknowns.
- Clickable evidence references.
- A way to proceed to safeguard generation.

Keep the interface consistent with the existing Underwatch design system. Do not redesign unrelated pages.

---

## 4. Feature B: Safeguard Generation and `CLAUDE.md` Updates

### 4.1 User story

As a developer who has investigated an incident, I want to turn the findings into a proposed improvement to my coding-agent instructions or security controls, review the exact changes, and test them before relying on them.

### 4.2 Entry point

Add a **Create safeguard** action to the finding detail page and the Ask Witness panel.

The user should be able to start from the investigated finding and see a proposed safeguard based on its evidence and relevant project context.

### 4.3 Safeguard types

Support these safeguard types, ordered by implementation priority:

**Type 1: `CLAUDE.md` update**

Generate a proposed instruction for the relevant project-level or directory-level `CLAUDE.md` file.

Examples include instructions to:

- Avoid reading credential files unless explicitly necessary and authorized.
- Ask for approval before performing a particular sensitive operation.
- Avoid unrelated files or actions outside the task's scope.
- Run a required test before claiming that a change is complete.
- Report failed, blocked, or unverified operations accurately.

The proposed instruction must be specific to the finding. Do not generate generic security advice unrelated to the incident.

**Type 2: Permission rule or hook**

Where supported by the existing integration, propose a Claude Code permission rule or hook that provides a more enforceable control than a natural-language instruction.

Inspect the current Claude Code documentation and existing project configuration before implementing these mechanisms.

Do not assume that a particular hook, permission format, or configuration path is supported without checking the applicable documentation.

**Type 3: Regression or verification test**

Generate a test that reproduces the relevant condition and checks whether the expected behavior occurs.

Examples include verifying that a restricted file read is denied or that a required confirmation step occurs.

Only implement safeguard types that the current architecture can actually apply and test. Mark unsupported mechanisms as proposed or unavailable rather than simulating success.

### 4.4 Safeguard generation workflow

Implement the following workflow:

1. The user opens a finding and selects **Create safeguard**.
2. The backend retrieves the finding, its supporting evidence, relevant policy context, and any existing safeguards.
3. The backend obtains the relevant project instructions and configuration from an authorized source, if available.
4. ai& proposes a safeguard tailored to the finding.
5. The application validates the proposal and displays its type, rationale, intended effect, limitations, and verification plan.
6. For a `CLAUDE.md` update, show the target file and a readable before-and-after diff.
7. The user can edit, approve, or reject the proposal.
8. Only after explicit approval does the application apply the change through the authorized integration.
9. The application records the applied change and its resulting file or configuration state.
10. The user can run a controlled verification test.
11. The application records the actual test result and links it to the original finding and safeguard.

Do not skip the review step. AI-generated changes must never be applied automatically merely because the model recommended them.

### 4.5 `CLAUDE.md` update behavior

The application must:

- Identify the intended project or directory scope.
- Inspect the existing `CLAUDE.md` before proposing changes.
- Preserve unrelated instructions and existing formatting.
- Avoid adding duplicate or contradictory instructions.
- Generate a minimal targeted diff.
- Display the exact proposed change before approval.
- Apply changes only to the authorized workspace.
- Preserve a backup or enough before-state information to support rollback.
- Detect if the file changes between proposal and approval.
- Ask the user to review a regenerated diff if a concurrent change would be overwritten.
- Record the before and after content or hashes as appropriate for the existing storage architecture.
- Never write to a different repository or project because of an ambiguous path.

If the user has not connected or authorized a project workspace, provide a copyable proposed patch instead of claiming that the file was updated.

Treat `CLAUDE.md` content as untrusted input when constructing model prompts. Instructions in that file must not override the application's security rules.

### 4.6 Important distinction: instructions versus enforcement

A `CLAUDE.md` file provides guidance to Claude Code. It is not a security boundary and cannot guarantee that an action will be blocked.

The UI must explain this distinction.

For each safeguard, show:

- What behavior it is intended to change.
- Whether it is an instruction, a permission control, a hook, or a test.
- What the mechanism can and cannot enforce.
- How the proposed behavior will be tested.
- Whether verification has actually succeeded.

Do not label an instruction-only safeguard as an enforced security control.

---

## 5. Verification workflow

### 5.1 Purpose

Verification should test whether the approved safeguard produces the intended behavior. It must not simply ask ai& whether the safeguard looks correct.

### 5.2 Verification requirements

For each safeguard, define a test plan before running it.

Where practical, include:

- A test case that should be blocked or handled safely.
- A legitimate operation that should continue to work.
- The expected result for each case.
- The observed result.
- The source of the result.
- Any limitations in the test environment.

Use an isolated or disposable test environment for actions involving restricted files, credentials, shell execution, or permission changes.

Never test by exposing real credentials or intentionally damaging a real project.

### 5.3 Verification statuses

Use explicit statuses such as:

- `Not tested`
- `Passed`
- `Failed`
- `Inconclusive`

Only assign `Passed` when the expected behavior has been observed and recorded by the test harness or a suitable independent verification mechanism.

If the environment cannot test a safeguard, mark it `Inconclusive` or `Not tested`.

An AI-generated explanation of a test result is not a substitute for the test result itself.

### 5.4 Regression handling

If a safeguard blocks the intended restricted behavior but also breaks legitimate work, the UI should show both results and allow the user to revise the proposal.

Do not automatically weaken or remove a security control. Any revision requires review and a new verification run.

---

## 6. Neo4j data integration

Extend the existing graph schema instead of replacing it.

Reuse the existing `Run`, `AgentAction`, `ObservedEvent`, `Resource`, `Policy`, `Finding`, `Safeguard`, and `VerificationRun` nodes where available.

Add a node such as `Investigation` or an equivalent existing record for an Ask Witness session, containing:

- Stable ID.
- Associated finding and run IDs.
- User questions.
- References to evidence used.
- Structured AI response.
- Model identifier and timestamp.
- Investigation status.

Store conversation history and AI responses separately from original event evidence.

Use relationships such as:

- `(Investigation)-[:INVESTIGATES]->(Finding)`
- `(Investigation)-[:USES_EVIDENCE]->(ObservedEvent)`
- `(Investigation)-[:USES_EVIDENCE]->(AgentAction)`
- `(Safeguard)-[:ADDRESSES]->(Finding)`
- `(VerificationRun)-[:TESTS]->(Safeguard)`

Where a proposed safeguard and an approved safeguard need different states, model that distinction explicitly. Do not overwrite the original proposal or evidence when a user edits it.

Store references to file diffs, patches, and test artifacts using the existing evidence storage system where appropriate. Avoid storing secrets or unrestricted file contents in Neo4j.

Every record must retain its provenance and be linked to the correct project, run, and finding.

---

## 7. Security, privacy, and reliability

- Keep ai& API credentials and Neo4j credentials on the server.
- Enforce existing authentication and authorization checks.
- Ensure users can only investigate findings and modify workspaces they are authorized to access.
- Redact secrets and unrelated sensitive information before sending context to ai&.
- Treat event logs, source code, repository instructions, and agent outputs as untrusted data.
- Protect against prompt injection in evidence and project files.
- Do not give the model direct database credentials or unrestricted filesystem access.
- Do not execute model-generated commands without explicit approval and validation.
- Do not apply file changes without a visible diff and user approval.
- Do not expose internal prompts, credentials, or sensitive evidence in frontend error messages.
- Handle API rate limits, timeouts, malformed output, and unavailable services gracefully.
- Preserve the underlying evidence even when an investigation or AI request fails.
- Make AI features optional; the rest of Underwatch must remain usable if ai& is unavailable.

---

## 8. API and integration requirements

Adapt endpoint names to the existing backend conventions.

Potential endpoints include:

- `POST /findings/:id/investigations`
  Start an investigation or submit a question.

- `GET /investigations/:id`
  Retrieve investigation history and structured responses.

- `POST /findings/:id/safeguards/proposals`
  Generate a proposed safeguard.

- `POST /safeguards/:id/approve`
  Approve and apply a safeguard after authorization and validation.

- `POST /safeguards/:id/verification-runs`
  Start a controlled verification run.

- `GET /safeguards/:id`
  Retrieve safeguard details, change history, and verification results.

These are proposed interfaces, not mandatory route names. Reuse existing endpoints and service modules if equivalent functionality already exists.

All mutating endpoints must enforce authentication, authorization, validation, and explicit approval where required.

---

## 9. UI and user experience

Extend the current finding detail page with two connected areas.

### Ask Witness panel

Display:

- The current finding and severity.
- A natural-language question input.
- Suggested questions.
- The AI response separated into facts, hypotheses, and unknowns.
- Evidence links and a way to inspect each supporting record.
- A **Create safeguard** action.

### Safeguard panel

Display:

- The finding that motivated the safeguard.
- Safeguard type.
- Proposed instruction, rule, hook, or test.
- Rationale and expected effect.
- Known limitations.
- A before-and-after diff for file changes.
- Approve, edit, and reject actions.
- Verification plan and results.
- A clear distinction between proposed, approved, applied, and verified states.

Use the existing visual style. Favor readable evidence trails and clear status indicators over decorative graph animations.

Include loading, empty, permission-denied, conflict, timeout, and error states.

---

## 10. Acceptance criteria

The implementation is complete when all applicable criteria pass.

### Ask Witness

1. A user can ask a question from a finding detail page.
2. The backend retrieves relevant evidence through the existing data layer.
3. ai& returns a response conforming to the validated schema.
4. Evidence references are checked against the supplied evidence bundle.
5. The UI distinguishes observations, hypotheses, and unknowns.
6. Users can open supporting evidence from the response.
7. Insufficient evidence produces an explicit uncertainty response.
8. API failures do not corrupt or remove the original evidence.
9. The feature respects existing authentication and authorization.
10. The application remains usable when ai& is unavailable.

### Safeguard generation

11. A user can request a safeguard from an investigated finding.
12. The proposal references the finding and relevant evidence.
13. The user can review, edit, and reject the proposal.
14. A `CLAUDE.md` update displays a diff and preserves unrelated content.
15. Applying a change requires explicit approval and correct workspace authorization.
16. Concurrent file modifications are detected rather than silently overwritten.
17. Unsupported safeguard mechanisms are clearly identified.
18. Instructions are not mislabeled as enforceable security controls.

### Verification and persistence

19. A user can start an available controlled verification test.
20. Verification results reflect actual test-harness output.
21. Failed or inconclusive tests are not marked as passed.
22. The investigation, safeguard, and verification result can be retrieved from the application's data layer.
23. Repeated requests do not create duplicate records unintentionally.
24. Tests cover invalid AI responses, nonexistent evidence references, prompt injection, API failures, file conflicts, authorization failures, and verification failures.
25. The implementation documents which components use synthetic data, mocks, or real integrations.

---

## 11. Implementation sequence

Implement incrementally, maintaining a working application at each stage.

### Phase 1: Repository inspection and architecture plan

Inspect the current codebase, Neo4j integration, ai& configuration, finding detail UI, file access mechanisms, and test infrastructure.

Identify reusable components and missing prerequisites before editing.

### Phase 2: Ask Witness backend

Implement evidence retrieval, ai& requests, structured output validation, evidence-reference validation, and error handling.

### Phase 3: Ask Witness UI

Add the investigation panel, suggested questions, answer rendering, and evidence navigation.

### Phase 4: Safeguard proposals

Implement safeguard generation and the review workflow. Start with `CLAUDE.md` proposals and diffs.

### Phase 5: Approved file updates

Integrate authorized file reading and writing, workspace checks, conflict detection, rollback support, and change history.

If the current application has no safe mechanism for accessing a real project workspace, implement proposal and patch export first. Do not pretend a local file was changed.

### Phase 6: Verification

Implement controlled test execution for the safeguard types the architecture can actually support. Persist actual results and display the correct statuses.

### Phase 7: Integration testing

Run the full flow from investigation to safeguard proposal, approval, application, and verification.

Report any remaining mocks, unsupported capabilities, and untested paths.

---

## 12. End-to-end demonstration scenario

Use a clearly labeled synthetic incident until real independent event collection is available.

1. A sample finding concerns an attempted read of `.env`.
2. The evidence bundle records a denied attempt.
3. The user asks Ask Witness whether credentials were accessed.
4. ai& explains that the attempt was denied but that the supplied evidence does not establish whether credentials were accessed through another route.
5. The user asks for a safeguard.
6. ai& proposes a targeted `CLAUDE.md` instruction and, where supported, a stronger permission rule or hook.
7. The application displays the exact proposed changes.
8. The user reviews and approves a change in a disposable test project.
9. A controlled test checks the restricted action and a legitimate operation.
10. Underwatch records the observed results, links them to the safeguard and original finding, and displays whether verification passed, failed, or was inconclusive.

The demonstration must distinguish synthetic data from real observed events and must not claim a security control works without a successful test.

---

## 13. Instructions to the coding agent

This PRD extends an existing application. Do not start from scratch.

First inspect the current repository and report:

- Existing architecture and relevant files.
- Current ai& and Neo4j integrations.
- Existing finding detail and safeguard UI.
- Available mechanisms for reading and updating `CLAUDE.md`.
- Any missing infrastructure or permissions.
- A short implementation plan with the files and modules to change.

Then implement the smallest complete end-to-end version that fits the existing codebase.

Prefer real integrations over mocks where credentials and infrastructure are available. If they are unavailable, implement clearly labeled development mocks and document what remains.

Do not invent API methods, supported hooks, file access capabilities, or successful test results. Verify external API and Claude Code configuration details against current official documentation.

Preserve existing functionality and visual consistency. Run the relevant tests and report their actual outcomes.

At completion, provide a concise summary of what works, how to configure it, how to test the end-to-end flow, and what remains incomplete.
