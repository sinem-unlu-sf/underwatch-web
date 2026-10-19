import { ASK_WITNESS_INVESTIGATOR_QUESTIONS, ASK_WITNESS_SUGGESTED_QUESTIONS, type BundleEvidenceRef, type Severity } from "@kw/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiRequestError, api, newClientRequestId } from "../../api/client";
import { queryKeys, useFindingInvestigations, useInvestigation } from "../../api/queries";
import { FixtureBadge, SeverityBadge } from "../badges";
import { ErrorState, MutationError, SkeletonBlock } from "../states";
import { Panel } from "../ui";
import { TurnView, type EvidenceLookup, type FollowUpMode } from "./AnswerView";
import { AI_FOOTNOTE, ChatComposer, PendingTurn } from "./ChatParts";
import { EvidenceRefDrawer } from "./EvidenceRef";

/** Addendum C: two of the judge's questions imply a mode (plain language / more depth); the rest are concise. */
export const SUGGESTION_MODE: Readonly<Record<string, FollowUpMode>> = {
  "Can you explain this in simpler terms?": { style: "simple" },
  "What additional technical details should I know?": { depth: "detailed" },
};

export interface AskWitnessFinding {
  id: string;
  title: string;
  severity: Severity;
  is_fixture: boolean;
}

interface Pending {
  question: string;
  clientRequestId: string;
  investigationId: string | null;
  /** Addendum C: omitted = concise / standard. */
  mode?: FollowUpMode;
}

/**
 * Ask Witness (addendum Feature A). The finding context is implicit: the server retrieves the evidence bundle for this
 * finding only. Every question carries a client_request_id; a network-level retry reuses it, so the server returns the
 * stored turn instead of recording a duplicate.
 */
export function AskWitnessPanel({
  finding,
  onCreateSafeguard,
  compact = false,
  embedded = false,
  maxSuggestions,
}: {
  finding: AskWitnessFinding;
  onCreateSafeguard: (investigationId: string | null) => void;
  /** Addendum C summary view: show only the input + suggested questions until the user asks or opens the history. */
  compact?: boolean;
  /** Inside the "Ask about this issue" side panel: no card chrome (the side panel supplies the heading). */
  embedded?: boolean;
  /** Show only the first N suggested questions; the rest move under "More questions". */
  maxSuggestions?: number;
}) {
  const qc = useQueryClient();
  const list = useFindingInvestigations(finding.id);
  const [selected, setSelected] = useState<string | null | "new">(null);
  const latest = useMemo(() => {
    const items = list.data?.items ?? [];
    return items.length === 0 ? null : [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]!.id;
  }, [list.data]);
  const investigationId = selected === "new" ? null : (selected ?? latest);
  const detail = useInvestigation(investigationId);

  const [input, setInput] = useState("");
  const [expanded, setExpanded] = useState(!compact);
  const [pending, setPending] = useState<Pending | null>(null);
  const [extraIndex, setExtraIndex] = useState<BundleEvidenceRef[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const ask = useMutation({
    mutationFn: (p: Pending) =>
      api.askWitness(finding.id, {
        question: p.question,
        client_request_id: p.clientRequestId,
        ...(p.investigationId ? { investigation_id: p.investigationId } : {}),
        ...(p.mode?.depth && p.mode.depth !== "concise" ? { depth: p.mode.depth } : {}),
        ...(p.mode?.style && p.mode.style !== "standard" ? { style: p.mode.style } : {}),
      }),
    onSuccess: async (res) => {
      setExtraIndex(res.evidence_index);
      setSelected(res.investigation.id);
      setPending(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.investigation(res.investigation.id) }),
        qc.invalidateQueries({ queryKey: queryKeys.findingInvestigations(finding.id) }),
      ]);
    },
  });

  const submit = (question: string, mode?: FollowUpMode) => {
    const q = question.trim();
    if (!q || ask.isPending) return;
    const p: Pending = { question: q, clientRequestId: newClientRequestId(), investigationId, ...(mode ? { mode } : {}) };
    setPending(p);
    setInput("");
    setExpanded(true);
    ask.mutate(p);
  };

  /** Same request again: reuse the key unless the server said the key conflicts. */
  const retryPending = () => {
    if (!pending) return;
    const conflict = ask.error instanceof ApiRequestError && ask.error.code === "conflict";
    const p = conflict ? { ...pending, clientRequestId: newClientRequestId() } : pending;
    setPending(p);
    ask.mutate(p);
  };


  const turns = detail.data?.turns ?? [];
  const index = useMemo(() => {
    const m = new Map<string, BundleEvidenceRef>();
    for (const r of detail.data?.evidence_index ?? []) m.set(r.evidence_id, r);
    for (const r of extraIndex) if (!m.has(r.evidence_id)) m.set(r.evidence_id, r);
    return m;
  }, [detail.data, extraIndex]);
  const ev: EvidenceLookup = { index, onOpen: setOpenId };

  // Scroll to the newest turn only after the user asked something on this page; a stored (pre-warmed) answer must not
  // pull the finding page down on load.
  const askedHere = useRef(false);
  useEffect(() => {
    if (pending) askedHere.current = true;
    if (!askedHere.current) return;
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [turns.length, pending]);

  const ai = detail.data?.ai;
  const items = list.data?.items ?? [];
  const limit = maxSuggestions ?? ASK_WITNESS_SUGGESTED_QUESTIONS.length;
  const shownSuggestions = ASK_WITNESS_SUGGESTED_QUESTIONS.slice(0, limit);
  const moreSuggestions = ASK_WITNESS_SUGGESTED_QUESTIONS.slice(limit);

  const asideContent = (
    <>
      <span className="text-[11px]">ai& · advisory</span>
      <button type="button" className="btn" onClick={() => onCreateSafeguard(investigationId)}>
        Create safeguard
      </button>
    </>
  );
  // A plain function (not a component) so the subtree keeps its identity across renders (input focus survives typing).
  const wrap = (children: ReactNode) =>
    embedded ? (
      <div className="flex flex-col">
        <div className="mb-2 flex flex-wrap items-center justify-end gap-2 text-fg-2">{asideContent}</div>
        {children}
      </div>
    ) : (
      <Panel id="ask-witness" title="Ask Witness" aside={asideContent}>
        {children}
      </Panel>
    );

  return wrap(
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="label">Investigating</span>
        <FixtureBadge isFixture={finding.is_fixture} compact />
        <span className="font-medium text-fg-0">{finding.title}</span>
        <SeverityBadge severity={finding.severity} />
        {items.length > 0 && expanded ? (
          <span className="ml-auto flex items-center gap-1.5">
            <select
              aria-label="Investigation"
              className="field"
              value={investigationId ?? "new"}
              onChange={(e) => setSelected(e.target.value === "new" ? "new" : e.target.value)}
            >
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.last_question ? `${it.last_question.slice(0, 40)}${it.last_question.length > 40 ? "…" : ""}` : it.id} ({it.turn_count})
                </option>
              ))}
              <option value="new">New investigation</option>
            </select>
          </span>
        ) : null}
      </div>

      {ai && !ai.available ? (
        <div role="status" className="hatch mb-2 rounded-[3px] px-2 py-1.5 text-[12px] text-unknown">
          ai& unavailable: {ai.detail} Questions are still recorded, marked unanswered.
        </div>
      ) : null}

      {!expanded ? (
        <p className="text-[12px] text-fg-2">
          {items.length > 0
            ? `${items.length} earlier investigation${items.length === 1 ? "" : "s"} on this finding. `
            : "No questions asked about this finding yet. "}
          {items.length > 0 ? (
            <button type="button" className="text-focus hover:underline" onClick={() => setExpanded(true)}>
              Show previous answers
            </button>
          ) : null}
        </p>
      ) : null}
      <div className={`flex flex-col gap-5 ${expanded ? "" : "hidden"}`}>
        {list.isPending ? (
          <SkeletonBlock lines={3} />
        ) : list.isError ? (
          <ErrorState error={list.error} what="Ask Witness investigations" />
        ) : investigationId && detail.isPending ? (
          <SkeletonBlock lines={4} />
        ) : investigationId && detail.isError ? (
          <ErrorState error={detail.error} what="this investigation" />
        ) : turns.length === 0 && !pending ? (
          <p className="text-[12px] text-fg-2">No questions yet.</p>
        ) : null}

        {turns.map((t) => (
          <TurnView
            key={t.id}
            turn={t}
            ev={ev}
            onRetry={submit}
            onFollowUp={submit}
            retrying={ask.isPending}
            onCreateSafeguard={() => onCreateSafeguard(investigationId)}
          />
        ))}

        {pending ? (
          <PendingTurn
            question={pending.question}
            sending={ask.isPending}
            error={ask.isError ? <MutationError error={ask.error} what="Asking Witness" /> : null}
            onRetry={retryPending}
            onEdit={() => {
              setInput(pending.question);
              setPending(null);
              ask.reset();
            }}
          />
        ) : null}
        <div ref={endRef} />
      </div>

      <div className="mt-3 border-t border-line pt-3">
        <div className="mb-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Suggested questions">
          {shownSuggestions.map((q) => (
            <button
              key={q}
              type="button"
              className="rounded-full border border-line-strong bg-surface-2 px-2.5 py-0.5 text-left text-[11.5px] text-fg-1 hover:bg-surface-3 disabled:text-fg-disabled"
              disabled={ask.isPending}
              onClick={() => submit(q, SUGGESTION_MODE[q])}
            >
              {q}
            </button>
          ))}
        </div>
        <details className="mb-1.5">
          <summary className="cursor-pointer text-[11px] text-fg-2">
            {moreSuggestions.length > 0 ? `More questions (${moreSuggestions.length + ASK_WITNESS_INVESTIGATOR_QUESTIONS.length})` : "More investigator questions"}
          </summary>
          {moreSuggestions.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="More suggested questions">
              {moreSuggestions.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="rounded-full border border-line-strong bg-surface-2 px-2.5 py-0.5 text-left text-[11.5px] text-fg-1 hover:bg-surface-3 disabled:text-fg-disabled"
                  disabled={ask.isPending}
                  onClick={() => submit(q, SUGGESTION_MODE[q])}
                >
                  {q}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Investigator questions">
            {ASK_WITNESS_INVESTIGATOR_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                className="rounded-full border border-line-strong bg-surface-2 px-2.5 py-0.5 text-left text-[11.5px] text-fg-1 hover:bg-surface-3 disabled:text-fg-disabled"
                disabled={ask.isPending}
                onClick={() => submit(q)}
              >
                {q}
              </button>
            ))}
          </div>
        </details>
        <ChatComposer
          value={input}
          onChange={setInput}
          onSubmit={() => submit(input)}
          label="Ask a question about this finding"
          placeholder={investigationId ? "Ask a follow-up…" : "Ask about this finding…"}
          sending={ask.isPending}
        />
        <p className="mt-1.5 text-center text-[11px] text-fg-2">{AI_FOOTNOTE}</p>
      </div>

      {openId ? <EvidenceRefDrawer id={openId} evidenceRef={index.get(openId)} onClose={() => setOpenId(null)} /> : null}
    </>,
  );
}
