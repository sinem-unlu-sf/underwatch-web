import {
  FileConflictDetails,
  SAFEGUARD_LIFECYCLE_LABELS,
  SECURITY_OUTCOME_LABELS,
  TASK_OUTCOME_LABELS,
  outcomesForRun,
  type FileDiffPreview,
  type SafeguardDetailResponse,
  type SafeguardMutationResponse,
  type WorkspaceFileChange,
} from "@kw/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ApiRequestError, api } from "../../api/client";
import { invalidateAfterSafeguardChange, queryKeys } from "../../api/queries";
import { humanize } from "../../lib/format";
import { Badge, FixtureBadge, SeverityBadge } from "../badges";
import { EvidenceChip } from "../askwitness/EvidenceRef";
import { MutationError } from "../states";
import { Mono, Time } from "../ui";
import { CodeBlock } from "../ds/CodeBlock";
import { DiffView, EnforcementExplainer, MechanismBadge, VerificationStateBadge } from "./parts";
import { VerificationSection } from "./VerificationSection";
import { EnforcementPill, SafeguardWorkflow } from "./Workflow";

type Mode = { kind: "idle" } | { kind: "edit" } | { kind: "reject" } | { kind: "approve"; preview: FileDiffPreview | null } | { kind: "rollback"; change: WorkspaceFileChange };

function conflictOf(err: unknown): FileConflictDetails | null {
  if (!(err instanceof ApiRequestError) || err.code !== "file_conflict") return null;
  const p = FileConflictDetails.safeParse(err.details);
  return p.success ? p.data : null;
}

function SubSection({
  title,
  children,
  aside,
  step,
  description,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
  /** Workflow step number(s) this section belongs to, e.g. "3" or "4-5". */
  step?: string;
  description?: ReactNode;
}) {
  return (
    <section className="space-y-2.5 border-t border-line pt-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-baseline gap-2 text-[13px] font-semibold text-fg-0">
            {step ? <span className="font-mono text-[11px] font-normal text-fg-2">{step}</span> : null}
            {title}
          </h3>
          {description ? <p className="mt-0.5 max-w-[80ch] text-[12px] text-fg-2">{description}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

const TARGET_TEXT: Record<"supervised_run_policy" | "scenario", string> = {
  supervised_run_policy: "Underwatch verification runs and exported config only (not your repository or your own Claude Code settings)",
  scenario: "Stored in Underwatch as a verification scenario (no file is changed)",
};

const APPLIED_TEXT: Record<SafeguardDetailResponse["lifecycle_status"], string> = {
  proposed: "Not applied: awaiting approval",
  rejected: "Not applied: rejected",
  approved: "Approved, not applied yet",
  applied: "Applied",
  application_failed: "Application failed: nothing is in effect",
  rolled_back: "Rolled back: no longer in effect",
};

/** At-a-glance answers to: what does it enforce, is it applied, was it tested, what did the test show, what approval is needed. */
function SafeguardFacts({ detail }: { detail: SafeguardDetailResponse }) {
  const m = detail.mechanism;
  const v = detail.current_version;
  const runs = detail.verification_runs;
  const latest = runs.find((r) => r.verification_status !== "running") ?? null;
  const o = latest ? outcomesForRun(latest) : null;
  const target =
    v?.target.kind === "workspace_file"
      ? detail.workspace && detail.diff_preview?.workspace_id
        ? `${detail.workspace.root_path}/${v.target.rel_path ?? detail.safeguard.target_path ?? ""}`
        : `${v.target.rel_path ?? detail.safeguard.target_path ?? "file"} (no authorized workspace connected)`
      : v
        ? TARGET_TEXT[v.target.kind]
        : (detail.safeguard.target_path ?? "Not specified");
  const rows: Array<[string, ReactNode]> = [
    [
      "Enforces",
      <span className="flex flex-wrap items-center gap-2">
        <EnforcementPill m={m} />
        <span className="text-fg-2">
          {m.kind === "instruction"
            ? "Guides the agent; cannot block an action."
            : m.availability.status === "unavailable"
              ? "Shown as text; Underwatch cannot apply it in this build."
              : m.can_enforce
                ? "Can block matching actions once applied; only verification shows whether it does."
                : "Re-runs the scenario to detect regressions; prevents nothing."}
        </span>
      </span>,
    ],
    [
      "Applied",
      <span className="flex flex-wrap items-center gap-2">
        <Badge tone={detail.lifecycle_status === "applied" ? "neutral" : detail.lifecycle_status === "application_failed" ? "warn" : "muted"}>
          {APPLIED_TEXT[detail.lifecycle_status]}
        </Badge>
        <span className="min-w-0 text-fg-2">
          Target <Mono className="text-[11.5px] text-fg-1">{target}</Mono>
        </span>
      </span>,
    ],
    [
      "Tested",
      <span className="flex flex-wrap items-center gap-2">
        <VerificationStateBadge state={detail.verification_status} />
        <span className="text-fg-2">
          {runs.length === 0 ? "No verification run recorded." : `${runs.length} verification run${runs.length === 1 ? "" : "s"} recorded (details below).`}
        </span>
      </span>,
    ],
    [
      "Latest test showed",
      o ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={o.security_outcome.value === "blocked" ? "verified" : o.security_outcome.value === "allowed" ? "risk" : "unknown"}>
            Security: {SECURITY_OUTCOME_LABELS[o.security_outcome.value]}
          </Badge>
          <Badge tone={o.task_outcome.value === "succeeded" ? "verified" : o.task_outcome.value === "failed" ? "risk" : "unknown"}>
            {TASK_OUTCOME_LABELS[o.task_outcome.value]}
          </Badge>
          <span className="text-[11.5px] text-fg-2">Two separate results; a blocked action says nothing about task success.</span>
        </span>
      ) : (
        <span className="hatch rounded-[5px] px-1.5 py-px text-[11.5px] text-unknown">Nothing tested yet: no result to report</span>
      ),
    ],
    [
      "Approval",
      <span className="text-fg-1">
        {v === null
          ? "Read-only legacy record: cannot be approved here."
          : v.target.kind === "workspace_file"
            ? "You confirm an exact diff first. Underwatch writes only if the file hash still matches and keeps the previous content for rollback."
            : v.target.kind === "supervised_run_policy"
              ? "You confirm first. The rule is recorded in Underwatch only."
              : "You confirm first. Nothing is written to any file."}{" "}
        <span className="text-fg-2">Approval is not verification.</span>
      </span>,
    ],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-5 gap-y-1 rounded-md border border-line bg-surface-1 px-3 py-2.5 text-[12px] sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-y-2" data-testid="safeguard-facts">
      {rows.map(([k, val]) => (
        <div key={k} className="contents">
          <dt className="label pt-0.5 max-sm:mt-1.5">{k}</dt>
          <dd className="min-w-0">{val}</dd>
        </div>
      ))}
    </dl>
  );
}


/**
 * Full review of one safeguard: mechanism + enforcement explainer, rationale, diff, edit / reject / approve with an
 * explicit confirmation stating exactly what will be written where, conflict handling (409 file_conflict shows the
 * regenerated diff and asks for re-approval), copyable patch when no workspace is connected, verification, history.
 */
export function SafeguardReview({ detail, onOpenEvidence }: { detail: SafeguardDetailResponse; onOpenEvidence?: (id: string) => void }) {
  const qc = useQueryClient();
  const sg = detail.safeguard;
  const v = detail.current_version;
  const m = detail.mechanism;
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [draft, setDraft] = useState(v?.content ?? sg.content);
  const [note, setNote] = useState("");
  const [conflict, setConflict] = useState<FileConflictDetails | null>(null);
  const [lastChange, setLastChange] = useState<SafeguardMutationResponse["change"]>(null);
  const [patch, setPatch] = useState<{ text: string; copied: boolean } | null>(null);

  const done = async (next: SafeguardDetailResponse) => {
    qc.setQueryData(queryKeys.safeguard(sg.id), next);
    await invalidateAfterSafeguardChange(qc, sg.id, sg.finding_id);
  };

  const edit = useMutation({
    mutationFn: () => api.editSafeguard(sg.id, { content: draft, note: note.trim() || null }),
    onSuccess: async (res) => {
      setMode({ kind: "idle" });
      setNote("");
      setConflict(null);
      await done(res);
    },
  });
  const reject = useMutation({
    mutationFn: () => api.rejectSafeguard(sg.id, { note: note.trim() }),
    onSuccess: async (res) => {
      setMode({ kind: "idle" });
      setNote("");
      await done(res);
    },
  });
  const approve = useMutation({
    mutationFn: (expected: string | null) =>
      api.approveSafeguard(sg.id, {
        version_id: v!.id,
        workspace_id: detail.workspace?.id ?? null,
        expected_before_sha256: expected,
        confirm: true,
      }),
    onSuccess: async (res) => {
      setMode({ kind: "idle" });
      setConflict(null);
      setLastChange(res.change);
      await done(res.detail);
    },
    onError: async (err) => {
      const c = conflictOf(err);
      if (c) {
        setConflict(c);
        setMode({ kind: "idle" });
        await qc.invalidateQueries({ queryKey: queryKeys.safeguard(sg.id) });
      }
    },
  });
  const rollback = useMutation({
    mutationFn: (changeId: string) => api.rollbackSafeguard(sg.id, { change_id: changeId }),
    onSuccess: async (res) => {
      setMode({ kind: "idle" });
      setLastChange(res.change);
      await done(res.detail);
    },
  });
  const copyPatch = useMutation({
    mutationFn: () => api.safeguardPatch(sg.id, v?.id),
    onSuccess: async (text) => {
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        copied = false;
      }
      setPatch({ text, copied });
    },
  });

  const allowed = detail.allowed_transitions;
  const isFileTarget = v?.target.kind === "workspace_file";
  const preview = detail.diff_preview;
  const workspaceReady = detail.workspace !== null && detail.workspace.status === "active" && preview?.workspace_id != null;
  const unavailable = m.availability.status === "unavailable";
  const canEdit = v !== null && allowed.includes("proposed");
  const canReject = v !== null && allowed.includes("rejected");
  const canApprove = v !== null && allowed.includes("approved") && !unavailable && (!isFileTarget || workspaceReady);
  const busy = edit.isPending || reject.isPending || approve.isPending || rollback.isPending;

  const startApprove = (p: FileDiffPreview | null) => {
    approve.reset();
    setMode({ kind: "approve", preview: p });
  };

  return (
    <div className="space-y-5" data-testid="safeguard-review">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <FixtureBadge isFixture={sg.is_fixture} />
          <MechanismBadge kind={m.kind} />
          <span className="text-[15px] font-semibold tracking-[-0.005em] text-fg-0">{sg.title}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="muted">{SAFEGUARD_LIFECYCLE_LABELS[detail.lifecycle_status]}</Badge>
          {v ? (
            <Badge tone="muted" mono>
              v{v.version} · {v.author === "ai" ? "ai& proposal" : v.author === "template" ? "template proposal (no AI)" : "edited by user"}
            </Badge>
          ) : (
            <Badge tone="unknown">legacy (unversioned)</Badge>
          )}
          <EnforcementPill m={m} />
        </div>
      </div>

      <SafeguardWorkflow
        label="Safeguard status"
        lifecycle={detail.lifecycle_status}
        input={{
          lifecycle: detail.lifecycle_status,
          verification: detail.verification_status,
          testable: !unavailable && v !== null,
          runCount: detail.verification_runs.length,
          proposeDetail: v
            ? `v${v.version} · ${v.author === "ai" ? "ai& proposal" : v.author === "template" ? "template (no AI)" : "edited by you"}`
            : "Legacy record (read-only)",
        }}
      />

      <SafeguardFacts detail={detail} />

      {v === null ? (
        <div className="hatch rounded-md px-3 py-2 text-[12px] text-unknown">
          This safeguard predates versioning (fixture or v1 record). It is shown read-only and cannot be approved or applied here.
        </div>
      ) : null}

      <SubSection step="1" title="Investigate: why this safeguard exists" description="The finding and evidence that motivated the proposal.">
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-2">
          <span>Motivating finding</span>
          <FixtureBadge isFixture={detail.finding.is_fixture} compact />
          <Link to={`/findings/${encodeURIComponent(detail.finding.id)}`} className="text-focus hover:underline">
            {detail.finding.title}
          </Link>
          <SeverityBadge severity={detail.finding.severity} />
        </div>
        <Labeled label="Rationale">{v?.rationale || sg.intended_effect}</Labeled>
        {v && v.evidence_ids.length > 0 ? (
          <div>
            <div className="label mb-1">Evidence cited</div>
            <div className="flex flex-wrap gap-1">
              {v.evidence_ids.map((id) =>
                onOpenEvidence ? (
                  <EvidenceChip key={id} id={id} evidenceRef={undefined} onOpen={onOpenEvidence} />
                ) : (
                  <Mono key={id} className="text-[11px]">
                    {id}
                  </Mono>
                ),
              )}
            </div>
          </div>
        ) : null}
      </SubSection>

      <SubSection step="2" title="Propose: what it does and what it cannot do" description="The exact content, the mechanism it uses, and that mechanism's limits.">
        <EnforcementExplainer m={m} />
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-2.5">
            <Labeled label="Intended effect">{v?.intended_effect ?? sg.intended_effect}</Labeled>
            <Labeled label="Impact on legitimate workflows">{sg.legitimate_workflow_impact || <span className="text-fg-2">Not recorded.</span>}</Labeled>
            {v && v.limitations.length > 0 ? (
              <div>
                <div className="label mb-1">Limitations</div>
                <ul className="list-inside list-disc space-y-0.5 text-[12px] text-fg-1">
                  {v.limitations.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {v?.author === "ai" ? (
              <div className="text-[11px] text-fg-2">
                Proposed by ai& (<Mono>{v.model ?? "unknown model"}</Mono>, prompt <Mono>{v.prompt_version ?? "?"}</Mono>). A proposal, not a verified control.
              </div>
            ) : null}
          </div>
          <div className="min-w-0">
            <CodeBlock
              title={`Proposed ${m.kind === "instruction" ? "instruction" : m.kind === "permission control" ? "rule" : m.kind === "hook" ? "hook (text only)" : "test scenario"}`}
              code={v?.content ?? sg.content}
              wrap
              maxHeight="16rem"
            />
            {v && v.target.kind !== "workspace_file" ? (
              <p className="mt-1.5 text-[11px] text-fg-2">
                Target: {v.target.kind === "supervised_run_policy" ? "Underwatch verification runs and exported config only. In this build it does not change later supervised runs, your repository or your own Claude Code settings" : "stored in Underwatch as a verification scenario (nothing written)"}
              </p>
            ) : null}
          </div>
        </div>
      </SubSection>

      {isFileTarget ? (
        <SubSection step="3" title="Review: CLAUDE.md change (before / after)" description="Exactly what would be written, compared with the file as it is now.">
          {conflict ? (
            <div role="alert" className="space-y-1.5 rounded-md border border-warn/50 bg-warn/8 p-3">
              <div className="font-medium text-warn">The file changed since you reviewed the diff. Nothing was written.</div>
              <p className="text-[12px] text-fg-1">
                Expected hash <Mono>{conflict.expected_before_sha256?.slice(0, 12) ?? "none (no file)"}</Mono>, found{" "}
                <Mono>{conflict.current_sha256?.slice(0, 12) ?? "none (file missing)"}</Mono>. Review the regenerated diff below and approve again if it is
                still what you want.
              </p>
              <DiffView preview={conflict.diff_preview} workspace={detail.workspace} />
              <button type="button" className="btn btn-primary" onClick={() => startApprove(conflict.diff_preview)} disabled={busy}>
                Review and approve again
              </button>
            </div>
          ) : preview ? (
            <DiffView preview={preview} workspace={detail.workspace} />
          ) : (
            <div className="hatch rounded-md px-2 py-1.5 text-[12px] text-unknown">No diff preview available.</div>
          )}
          {!workspaceReady ? (
            <div className="space-y-1.5 rounded-md border border-line bg-surface-1 p-3 text-[12px]">
              <div className="text-fg-1">
                No authorized workspace is connected to this proposal, so Underwatch will not write any file. Copy the patch and apply it yourself, or
                create the demo workspace in{" "}
                <Link to="/settings" className="text-focus hover:underline">
                  Settings
                </Link>{" "}
                and create a new proposal for it.
              </div>
              <button type="button" className="btn" onClick={() => copyPatch.mutate()} disabled={copyPatch.isPending || v === null}>
                {copyPatch.isPending ? "Preparing patch…" : "Copy patch"}
              </button>
              <MutationError error={copyPatch.error} what="Exporting the patch" />
              {patch ? (
                <div className="space-y-1">
                  <div className="text-[11px] text-fg-2">
                    {patch.copied ? "Patch copied to the clipboard. It has not been applied." : "Clipboard unavailable: select and copy the patch below. It has not been applied."}
                  </div>
                  <pre className="max-h-64 overflow-auto rounded-md border border-line bg-surface-0 p-2 font-mono text-[11px] whitespace-pre select-all">{patch.text}</pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </SubSection>
      ) : null}

      <SubSection
        step="3"
        title="Review: approve, edit or reject"
        description={isFileTarget ? "Approving writes the diff above after a confirmation. Nothing is written without it." : "Approving records the decision after a confirmation."}
      >
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className="btn btn-primary" disabled={!canApprove || busy} onClick={() => startApprove(preview)}>
            Approve{isFileTarget ? " and write" : ""}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!canEdit || busy}
            onClick={() => {
              setDraft(v?.content ?? "");
              setNote("");
              setMode({ kind: "edit" });
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn"
            disabled={!canReject || busy}
            onClick={() => {
              setNote("");
              setMode({ kind: "reject" });
            }}
          >
            Reject
          </button>
        </div>
        {!canApprove && v !== null && allowed.includes("approved") ? (
          <p className="text-[11px] text-fg-2">
            {unavailable ? "Approval disabled: this mechanism is unavailable in this build." : "Approval disabled: no authorized workspace (use Copy patch)."}
          </p>
        ) : null}

        {mode.kind === "edit" ? (
          <form
            className="space-y-1.5 rounded-md border border-line-strong bg-surface-1 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) edit.mutate();
            }}
          >
            <div className="text-[12px] text-fg-1">Editing creates version {v ? v.version + 1 : "?"}; the original proposal is kept in the history.</div>
            <textarea aria-label="Safeguard content" className="field min-h-[120px] w-full font-mono" value={draft} maxLength={8000} onChange={(e) => setDraft(e.target.value)} />
            <input aria-label="Edit note" className="field w-full" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
            <div className="flex gap-1.5">
              <button type="submit" className="btn btn-primary" disabled={!draft.trim() || edit.isPending}>
                {edit.isPending ? "Saving…" : "Save new version"}
              </button>
              <button type="button" className="btn" onClick={() => setMode({ kind: "idle" })}>
                Cancel
              </button>
            </div>
            <MutationError error={edit.error} what="Saving the edit" />
          </form>
        ) : null}

        {mode.kind === "reject" ? (
          <form
            className="space-y-1.5 rounded-md border border-line-strong bg-surface-1 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) reject.mutate();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="label">
                Reason <span className="text-warn">(required)</span>
              </span>
              <textarea aria-label="Reject reason" className="field min-h-[60px] font-sans" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
            </label>
            <div className="flex gap-1.5">
              <button type="submit" className="btn btn-danger" disabled={!note.trim() || reject.isPending}>
                {reject.isPending ? "Rejecting…" : "Reject proposal"}
              </button>
              <button type="button" className="btn" onClick={() => setMode({ kind: "idle" })}>
                Cancel
              </button>
            </div>
            <MutationError error={reject.error} what="Rejecting" />
          </form>
        ) : null}

        {mode.kind === "approve" && v ? (
          <div role="dialog" aria-modal="false" aria-label="Confirm approval" className="space-y-1.5 rounded-md border border-focus/60 bg-surface-2 p-3 shadow-[var(--shadow-raised)]">
            <div className="font-medium text-fg-0">Confirm approval of version {v.version}</div>
            {isFileTarget && mode.preview && detail.workspace ? (
              <p className="text-[12px] text-fg-1">
                Underwatch will write the change shown in the diff to <Mono className="text-fg-0">{`${detail.workspace.root_path}/${mode.preview.rel_path}`}</Mono> in
                workspace <span className="text-fg-0">{detail.workspace.label}</span> ({detail.workspace.kind}). It writes only if the file still has hash{" "}
                <Mono>{mode.preview.before_sha256?.slice(0, 12) ?? "none (file absent)"}</Mono>; otherwise nothing is written and you will see a new diff. The
                previous content is stored for rollback.
              </p>
            ) : v.target.kind === "supervised_run_policy" ? (
              <p className="text-[12px] text-fg-1">
                The rule applies to Underwatch verification runs and exported config. In this build it is not merged into later supervised runs.
                Nothing in your repository or your own Claude Code settings changes.
              </p>
            ) : (
              <p className="text-[12px] text-fg-1">The scenario is stored in Underwatch and linked to the finding. Nothing is written to any file.</p>
            )}
            <p className="text-[11px] text-fg-2">Approval does not mean the safeguard works. Only a passing verification run shows that, for the tested scenario.</p>
            <div className="flex gap-1.5">
              <button type="button" className="btn btn-primary" disabled={approve.isPending} onClick={() => approve.mutate(isFileTarget ? (mode.preview?.before_sha256 ?? null) : null)}>
                {approve.isPending ? "Applying…" : isFileTarget ? "Confirm: write to file" : "Confirm approval"}
              </button>
              <button type="button" className="btn" onClick={() => setMode({ kind: "idle" })} disabled={approve.isPending}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {!conflictOf(approve.error) ? <MutationError error={approve.error} what="Approval" /> : null}
        {lastChange ? (
          <div role="status" className="text-[12px] text-fg-1">
            {lastChange.status === "applied" ? "Written" : "Rolled back"}: <Mono>{lastChange.rel_path}</Mono> (hash now{" "}
            <Mono>{(lastChange.status === "applied" ? lastChange.after_sha256 : lastChange.before_sha256)?.slice(0, 12) ?? "file removed"}</Mono>).
          </div>
        ) : null}
      </SubSection>

      {detail.file_changes.length > 0 ? (
        <SubSection step="3" title="Applied file changes" description="Every write Underwatch made for this safeguard. Each can be rolled back if the file was not modified since.">
          <ul className="space-y-1">
            {detail.file_changes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px]">
                <Badge tone={c.status === "applied" ? "neutral" : "muted"}>{humanize(c.status)}</Badge>
                <Mono>{c.rel_path}</Mono>
                <span className="text-fg-2">
                  <Mono>{c.before_sha256?.slice(0, 10) ?? "none"}</Mono> → <Mono>{c.after_sha256.slice(0, 10)}</Mono> · <Time iso={c.applied_at} />
                </span>
                {c.status === "applied" && allowed.includes("rolled_back") ? (
                  <button type="button" className="btn ml-auto" disabled={busy} onClick={() => setMode({ kind: "rollback", change: c })}>
                    Roll back
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {mode.kind === "rollback" ? (
            <div role="dialog" aria-label="Confirm rollback" className="space-y-1.5 rounded-md border border-focus/60 bg-surface-2 p-3 shadow-[var(--shadow-raised)] text-[12px]">
              <div className="text-fg-1">
                Restore <Mono>{mode.change.rel_path}</Mono> to its content before this change (hash <Mono>{mode.change.before_sha256?.slice(0, 12) ?? "none: file is removed"}</Mono>
                )? If the file was modified since, nothing is written.
              </div>
              <div className="flex gap-1.5">
                <button type="button" className="btn btn-danger" disabled={rollback.isPending} onClick={() => rollback.mutate(mode.change.id)}>
                  {rollback.isPending ? "Rolling back…" : "Confirm rollback"}
                </button>
                <button type="button" className="btn" onClick={() => setMode({ kind: "idle" })}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          <MutationError error={rollback.error} what="Rollback" />
        </SubSection>
      ) : null}

      <SubSection
        step="4-5"
        title="Test and verify"
        description="A controlled run in a disposable container. Security outcome and task outcome are reported separately; a pass covers only the tested scenario."
      >
        <VerificationSection detail={detail} />
      </SubSection>

      <SubSection title={`Versions (${detail.versions.length}) and history (${detail.history.length})`}>
        <div className="grid gap-3 lg:grid-cols-2">
          <ol className="space-y-1">
            {detail.versions.map((ver) => (
              <li key={ver.id} className="rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={ver.id === v?.id ? "focus" : "muted"} mono>
                    v{ver.version}
                  </Badge>
                  <span className="text-fg-2">{ver.author}</span>
                  <Time iso={ver.created_at} className="text-fg-2" />
                </div>
                <pre className="mt-1 max-h-24 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-fg-1">{ver.content}</pre>
              </li>
            ))}
            {detail.versions.length === 0 ? <li className="text-[12px] text-fg-2">No versions (legacy record).</li> : null}
          </ol>
          <ol className="space-y-1">
            {detail.history.map((h) => (
              <li key={h.id} className="text-[12px]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={h.action === "conflict_detected" || h.action === "application_failed" ? "warn" : "muted"}>{humanize(h.action)}</Badge>
                  <span className="text-fg-2">
                    {h.actor_type} <Mono>{h.actor}</Mono>
                  </span>
                  <Time iso={h.at} className="text-fg-2" />
                </div>
                {h.note ? <p className="text-fg-1">{h.note}</p> : null}
              </li>
            ))}
            {detail.history.length === 0 ? <li className="text-[12px] text-fg-2">No history recorded.</li> : null}
          </ol>
        </div>
      </SubSection>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="label mb-0.5">{label}</div>
      <p className="text-[12px] whitespace-pre-wrap text-fg-1">{children}</p>
    </div>
  );
}
