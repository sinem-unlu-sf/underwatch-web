import {
  FINDING_STATUS_LABELS,
  FINDING_STATUS_NOTE_REQUIRED,
  allowedFindingTransitions,
  type FindingStatus,
} from "@kw/schema";
import { useState, type FormEvent } from "react";
import { ApiRequestError } from "../api/client";
import { useUpdateFindingStatus } from "../api/queries";

export const FINDING_ACTIONS: ReadonlyArray<{ to: FindingStatus; label: string }> = [
  { to: "confirmed", label: "Confirm" },
  { to: "under_review", label: "Mark under review" },
  { to: "dismissed", label: "Dismiss" },
  { to: "resolved", label: "Resolve" },
  { to: "unresolved", label: "Mark unresolved" },
];

/** Status buttons are enabled from the shared FINDING_STATUS_TRANSITIONS table; the server enforces the same table. */
export function FindingActions({
  findingId,
  runId,
  status,
  serverAllowed,
}: {
  findingId: string;
  runId: string;
  status: FindingStatus;
  serverAllowed: readonly FindingStatus[];
}) {
  const allowed = allowedFindingTransitions(status);
  const mismatch = allowed.length !== serverAllowed.length || allowed.some((s) => !serverAllowed.includes(s));
  const [target, setTarget] = useState<FindingStatus | null>(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState<FindingStatus | null>(null);
  const mutation = useUpdateFindingStatus(findingId, runId);

  const noteRequired = target !== null && FINDING_STATUS_NOTE_REQUIRED.includes(target);
  const canSubmit = target !== null && (!noteRequired || note.trim().length > 0) && !mutation.isPending;

  const start = (to: FindingStatus) => {
    setTarget(to);
    setNote("");
    setDone(null);
    mutation.reset();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!target || !canSubmit) return;
    const trimmed = note.trim();
    mutation.mutate(
      { to: target, note: trimmed.length > 0 ? trimmed : null },
      {
        onSuccess: (res) => {
          setDone(res.finding.status);
          setTarget(null);
          setNote("");
        },
      },
    );
  };

  const err = mutation.error;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Change finding status">
        {FINDING_ACTIONS.map((a) => {
          const enabled = allowed.includes(a.to);
          const reason = a.to === status ? `Already ${FINDING_STATUS_LABELS[status].toLowerCase()}` : `Not allowed from “${FINDING_STATUS_LABELS[status]}”`;
          return (
            <button
              key={a.to}
              type="button"
              className={`btn ${target === a.to ? "border-focus" : ""}`}
              disabled={!enabled || mutation.isPending}
              title={enabled ? `Change status to ${FINDING_STATUS_LABELS[a.to]}` : reason}
              aria-pressed={target === a.to}
              onClick={() => start(a.to)}
            >
              {a.label}
            </button>
          );
        })}
      </div>

      {target ? (
        <form onSubmit={submit} className="space-y-2 rounded-[3px] border border-line-strong bg-surface-2 p-2">
          <div className="text-[12px] text-fg-1">
            Change status <span className="text-fg-2">{FINDING_STATUS_LABELS[status]}</span> → <span className="font-medium text-fg-0">{FINDING_STATUS_LABELS[target]}</span>
          </div>
          <label className="flex flex-col gap-1">
            <span className="label">
              Note {noteRequired ? <span className="text-warn">(required: explain the decision)</span> : <span>(optional)</span>}
            </span>
            <textarea
              className="field min-h-[64px] font-sans"
              value={note}
              maxLength={2000}
              required={noteRequired}
              onChange={(e) => setNote(e.target.value)}
              placeholder={noteRequired ? "Why is this finding being closed?" : "Context for the status history"}
              autoFocus
            />
          </label>
          <div className="flex gap-1.5">
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              {mutation.isPending ? "Saving…" : `Save: ${FINDING_STATUS_LABELS[target]}`}
            </button>
            <button type="button" className="btn" onClick={() => setTarget(null)} disabled={mutation.isPending}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {err ? (
        <div role="alert" className="rounded-[3px] border border-risk/55 bg-risk/10 p-2 text-[12px] text-fg-1">
          <span className="font-medium text-risk">Status not changed. </span>
          {err instanceof ApiRequestError ? (
            err.kind === "unreachable" ? (
              "The API is not reachable."
            ) : (
              <>
                {err.message}
                {err.code ? <span className="ml-1 font-mono text-[11px] text-fg-2">({err.code})</span> : null}
              </>
            )
          ) : (
            String(err)
          )}
        </div>
      ) : null}

      {done ? (
        <div role="status" className="text-[12px] text-fg-1">
          Saved. Status is now <span className="font-medium text-fg-0">{FINDING_STATUS_LABELS[done]}</span>; the change is recorded in the status history.
        </div>
      ) : null}

      {mismatch ? (
        <div className="text-[11px] text-warn">
          Server-reported allowed transitions ({serverAllowed.join(", ") || "none"}) differ from the shared table. The server decides; a rejected change is
          shown above.
        </div>
      ) : null}
    </div>
  );
}
