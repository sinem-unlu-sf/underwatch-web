import {
  EVIDENCE_SUPPORT_LABELS,
  SAFEGUARD_TYPE_LABELS,
  type ActionClaimFlag,
  type AskWitnessAnswer,
  type AskWitnessDepth,
  type AskWitnessStyle,
  type BundleEvidenceRef,
  type CheckedClaim,
  type EvidenceSupport,
  type InvestigationTurn,
} from "@kw/schema";
import { useState, type ReactNode } from "react";
import { Badge, type Tone } from "../badges";
import { Icon } from "../ds/Icon";
import { UserBubble } from "./ChatParts";
import { EvidenceChip, InvalidIdChip } from "./EvidenceRef";

/**
 * Renders a validated Ask Witness turn. Claim labels come ONLY from the app-assigned `support` field
 * (EVIDENCE_SUPPORT_LABELS), never from which section the model put a claim in. Nothing here says "verified":
 * the app checks that a citation exists in the bundle and what its basis is; it does not check that the claim text is
 * entailed by the record.
 */

const SUPPORT_TONE: Record<EvidenceSupport, Tone> = {
  observed_evidence: "observed",
  reported_evidence_only: "reported",
  derived_only: "neutral",
  unsupported: "unknown",
};

export function SupportBadge({ support }: { support: EvidenceSupport }) {
  return (
    <Badge tone={SUPPORT_TONE[support]} title="Assigned by Underwatch from the cited records in the bundle sent to ai&, not by the model">
      {EVIDENCE_SUPPORT_LABELS[support]}
    </Badge>
  );
}

/** For hypotheses: describes what the cited records are, without implying the hypothesis itself is confirmed. */
const HYPOTHESIS_CITES_LABEL: Record<EvidenceSupport, string> = {
  observed_evidence: "Cites an observed record (hypothesis not confirmed)",
  reported_evidence_only: "Cites agent-reported records only",
  derived_only: "Cites Underwatch analysis only",
  unsupported: EVIDENCE_SUPPORT_LABELS.unsupported,
};

function HypothesisCitesBadge({ support }: { support: EvidenceSupport }) {
  return (
    <Badge tone={support === "unsupported" ? "unknown" : "muted"} title="Describes the cited records only. A hypothesis is not confirmed by citing a record.">
      {HYPOTHESIS_CITES_LABEL[support]}
    </Badge>
  );
}

export interface EvidenceLookup {
  index: ReadonlyMap<string, BundleEvidenceRef>;
  onOpen: (id: string) => void;
}

function ClaimItem({ claim, ev, showSupport = true, hypothesis = false }: { claim: CheckedClaim; ev: EvidenceLookup; showSupport?: boolean; hypothesis?: boolean }) {
  return (
    <li className="rounded-[3px] border border-line bg-surface-2 px-2 py-1.5">
      <div className="text-[12.5px] whitespace-pre-wrap text-fg-0">{claim.text}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {showSupport ? hypothesis ? <HypothesisCitesBadge support={claim.support} /> : <SupportBadge support={claim.support} /> : null}
        {claim.evidence_ids.map((id) => (
          <EvidenceChip key={id} id={id} evidenceRef={ev.index.get(id)} onOpen={ev.onOpen} />
        ))}
        {claim.invalid_evidence_ids.map((id) => (
          <InvalidIdChip key={id} id={id} />
        ))}
      </div>
    </li>
  );
}

function Section({ title, hint, count, children, tone }: { title: string; hint?: ReactNode; count: number; children: ReactNode; tone?: string }) {
  return (
    <section aria-label={title} className="space-y-1">
      <h4 className={`flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase ${tone ?? "text-fg-1"}`}>
        {title} <span className="font-mono text-fg-2">({count})</span>
      </h4>
      {hint ? <p className="text-[11px] text-fg-2">{hint}</p> : null}
      {children}
    </section>
  );
}

function ClaimSection({
  title,
  hint,
  claims,
  ev,
  tone,
  empty,
  hypothesis,
}: {
  title: string;
  hint?: ReactNode;
  claims: CheckedClaim[];
  ev: EvidenceLookup;
  tone?: string;
  empty?: string;
  hypothesis?: boolean;
}) {
  if (claims.length === 0 && !empty) return null;
  return (
    <Section title={title} hint={hint} count={claims.length} tone={tone}>
      {claims.length === 0 ? (
        <p className="text-[12px] text-fg-2">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {claims.map((c, i) => (
            <ClaimItem key={i} claim={c} ev={ev} hypothesis={hypothesis} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Addendum C: follow-up modes offered on each answer (same investigation, same evidence rules). */
export interface FollowUpMode {
  depth?: AskWitnessDepth;
  style?: AskWitnessStyle;
}

/** Follow-up question text for a quick action, referencing the original question (kept under the 2000-char limit). */
export function followUpQuestion(kind: "detail" | "simple", original: string): string {
  const q = original.length > 1800 ? `${original.slice(0, 1800)}…` : original;
  return kind === "detail" ? `More detail on: ${q}` : `Explain simply: ${q}`;
}

const CLAIM_KIND_LABEL: Record<ActionClaimFlag["claim"], string> = {
  verified: "verification",
  tested: "test",
  applied: "applied change",
  fixed: "fix / resolution",
};

function ActionClaimFlags({ flags }: { flags: ActionClaimFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <section aria-label="Unconfirmed action claims" className="space-y-1 rounded-[3px] border border-risk/50 bg-risk/5 px-2 py-1.5">
      <h4 className="text-[11px] font-semibold tracking-wide text-risk uppercase">Unconfirmed action claims (checked by Underwatch, not the AI)</h4>
      <ul className="space-y-1 text-[12px] text-fg-1">
        {flags.map((f, i) => (
          <li key={i}>
            <span className="italic">&ldquo;{f.text}&rdquo;</span>{" "}
            <Badge tone="unknown" title={f.reason}>
              No record confirms this {CLAIM_KIND_LABEL[f.claim]}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AnswerBody({
  answer,
  ev,
  onCreateSafeguard,
  inChat = false,
}: {
  answer: AskWitnessAnswer;
  ev: EvidenceLookup;
  onCreateSafeguard?: () => void;
  /** Chat layout: the summary, insufficient-evidence line and action-claim flags are rendered by TurnView above the disclosure. */
  inChat?: boolean;
}) {
  const observed = answer.verified_facts.filter((f) => f.support === "observed_evidence");
  const reported = answer.verified_facts.filter((f) => f.support === "reported_evidence_only");
  const derived = answer.verified_facts.filter((f) => f.support === "derived_only");
  const check = answer.evidence_check;

  return (
    <div className="space-y-3">
      {inChat ? null : (
        <>
          <p className="text-[13px] whitespace-pre-wrap text-fg-0">{answer.summary}</p>
          <InsufficientLine show={answer.insufficient_evidence} />
          <ActionClaimFlags flags={answer.action_claim_flags ?? []} />
        </>
      )}

      {answer.evidence_limitations && answer.evidence_limitations.length > 0 ? (
        <section aria-label="Limits of the evidence sent" className="space-y-1 rounded-[3px] border border-line px-2 py-1.5">
          <h4 className="text-[11px] font-semibold tracking-wide text-unknown uppercase">Limits of the evidence sent (written by Underwatch, not the AI)</h4>
          <ul className="list-inside list-disc space-y-0.5 text-[12px] text-fg-1">
            {answer.evidence_limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <ClaimSection
        title="Backed by observed evidence"
        hint="Each cites at least one independently observed record that was in the bundle (checked by Underwatch). The record exists; read it to confirm the claim."
        claims={observed}
        ev={ev}
        tone="text-observed"
        empty="No claim cites an independently observed record."
      />
      <ClaimSection
        title="Supported only by agent-reported evidence"
        hint="Cites only the agent's own account (hooks, transcript). Not independently observed."
        claims={reported}
        ev={ev}
        tone="text-reported"
      />
      <ClaimSection title="Supported only by Underwatch analysis" hint="Cites only derived records (findings, correlations, policy rules), not raw evidence." claims={derived} ev={ev} />
      <ClaimSection title="Hypotheses" hint="Plausible explanations that are not confirmed." claims={answer.hypotheses} ev={ev} empty="None offered." hypothesis />

      <Section title="Unknowns" count={answer.unknowns.length}>
        {answer.unknowns.length === 0 ? (
          <p className="text-[12px] text-fg-2">None listed.</p>
        ) : (
          <ul className="space-y-1">
            {answer.unknowns.map((u, i) => (
              <li key={i} className="hatch rounded-[2px] px-2 py-1 text-[12px] text-fg-1">
                {u.text}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {answer.unsupported_claims.length > 0 ? (
        <Section
          title="Unsupported claims (citations invalid - not shown as fact)"
          hint="The model presented these as facts, but none of their citations exist in the evidence bundle."
          count={answer.unsupported_claims.length}
          tone="text-risk"
        >
          <ul className="space-y-1 opacity-80">
            {answer.unsupported_claims.map((c, i) => (
              <ClaimItem key={i} claim={c} ev={ev} />
            ))}
          </ul>
        </Section>
      ) : null}

      {answer.recommended_next_steps.length > 0 ? (
        <Section title="Recommended next steps" count={answer.recommended_next_steps.length}>
          <ul className="list-inside list-disc space-y-0.5 text-[12px] text-fg-1">
            {answer.recommended_next_steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {answer.recommended_safeguards.length > 0 ? (
        <Section title="Recommended safeguards (suggestions, not applied)" count={answer.recommended_safeguards.length}>
          <ul className="space-y-1">
            {answer.recommended_safeguards.map((s, i) => (
              <li key={i} className="rounded-[3px] border border-line px-2 py-1 text-[12px]">
                <div className="text-[11px] text-fg-2">{SAFEGUARD_TYPE_LABELS[s.type]}</div>
                <div className="text-fg-1">{s.description}</div>
              </li>
            ))}
          </ul>
          {onCreateSafeguard ? (
            <button type="button" className="btn mt-1" onClick={onCreateSafeguard}>
              Create safeguard
            </button>
          ) : null}
        </Section>
      ) : null}

      <div className="text-[11px] text-fg-2">
        Citation check: {check.cited} cited · {check.valid} in bundle · {check.invalid} not in bundle
        {check.invalid_ids.length > 0 ? (
          <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
            {check.invalid_ids.map((id) => (
              <InvalidIdChip key={id} id={id} />
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}

const ERROR_TITLE: Record<string, string> = {
  not_configured: "ai& is not configured",
  unavailable: "ai& is unavailable",
  rate_limited: "ai& rate limit reached",
  timeout: "ai& request timed out",
  provider_error: "ai& returned an error",
  invalid_output: "ai& returned an invalid answer",
};

function InsufficientLine({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div role="status" className="hatch rounded-md px-2 py-1 text-[12px] text-unknown">
      Insufficient evidence: the records sent do not support a definitive answer. Treat the summary as tentative.
    </div>
  );
}

/** Unique in-bundle citations across the answer, in order of first appearance (invalid ids are never chips). */
function answerCitations(answer: AskWitnessAnswer, index: ReadonlyMap<string, BundleEvidenceRef>): string[] {
  const seen = new Set<string>();
  const add = (id: string) => {
    if (index.has(id)) seen.add(id);
  };
  for (const c of [...answer.verified_facts, ...answer.hypotheses]) c.evidence_ids.forEach(add);
  return [...seen];
}

const MAX_CHIPS = 6;

function CopyAnswer({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 1600);
  };
  return (
    <button type="button" className="btn btn-ghost btn-sm gap-1" onClick={() => void copy()} title="Copy the summary">
      <Icon name={state === "copied" ? "check" : state === "failed" ? "x" : "copy"} size={12} />
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
    </button>
  );
}

/**
 * One recorded turn, chat style: the question as a compact right-aligned bubble; the answer as plain text (summary
 * first), a row of citation chips, and a collapsed "Sources & reasoning" disclosure holding every structured section
 * with its Underwatch-assigned label and the citation check. Tiny actions underneath.
 */
export function TurnView({
  turn,
  ev,
  onRetry,
  retrying,
  onCreateSafeguard,
  onFollowUp,
}: {
  turn: InvestigationTurn;
  ev: EvidenceLookup;
  onRetry?: (question: string, mode?: FollowUpMode) => void;
  retrying?: boolean;
  onCreateSafeguard?: () => void;
  /** Addendum C quick actions: ask a follow-up in the same investigation with more depth or simpler wording. */
  onFollowUp?: (question: string, mode: FollowUpMode) => void;
}) {
  const failed = turn.answer === null;
  const depth = turn.depth ?? "concise";
  const style = turn.style ?? "standard";
  const answer = turn.answer;
  const chips = answer ? answerCitations(answer, ev.index) : [];
  return (
    <article className="kw-fade-in space-y-2" aria-label={`Question: ${turn.question}`}>
      <UserBubble>{turn.question}</UserBubble>
      <div className="space-y-2">
        {failed ? (
          <div role="alert" className="rounded-md border border-warn/50 bg-warn/10 px-2.5 py-2">
            <div className="text-[12.5px] font-medium text-warn">{turn.error ? (ERROR_TITLE[turn.error.code] ?? "ai& request failed") : "No answer recorded"}</div>
            <p className="mt-0.5 text-[12px] text-fg-1">{turn.error?.message ?? "The request failed."} The records are unchanged.</p>
            {turn.error?.code === "not_configured" ? <p className="mt-0.5 text-[11px] text-fg-2">Set AIAND_API_KEY in .env.local on the server, then restart it.</p> : null}
            {onRetry ? (
              <button type="button" className="btn btn-sm mt-1.5" onClick={() => onRetry(turn.question, { depth, style })} disabled={retrying}>
                {retrying ? "Retrying…" : "Retry"}
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <p className="text-[13.5px] leading-6 whitespace-pre-wrap text-fg-0">{answer!.summary}</p>
            <InsufficientLine show={answer!.insufficient_evidence} />
            <ActionClaimFlags flags={answer!.action_claim_flags ?? []} />
            {chips.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1" aria-label="Citations">
                {chips.slice(0, MAX_CHIPS).map((id) => (
                  <EvidenceChip key={id} id={id} evidenceRef={ev.index.get(id)} onOpen={ev.onOpen} />
                ))}
                {chips.length > MAX_CHIPS ? <span className="text-[11px] text-fg-2">+{chips.length - MAX_CHIPS} in sources</span> : null}
              </div>
            ) : null}
          </>
        )}
        <details className="group rounded-md text-[12px]">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11.5px] text-fg-2 select-none hover:text-fg-1 [&::-webkit-details-marker]:hidden">
            <Icon name="chevronRight" size={11} className="transition-transform duration-[120ms] group-open:rotate-90" />
            Sources &amp; reasoning
          </summary>
          <div className="mt-2 space-y-3 border-l border-line pl-3">
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-2">
              <Badge tone="focus" title="Advisory interpretation stored separately from evidence. It is never an event record and never changes a status.">
                AI-generated - interprets evidence, does not establish facts
              </Badge>
              <span className="font-mono">model {turn.model}</span>
              <span className="font-mono">prompt {turn.prompt_version}</span>
              <span className="font-mono">{turn.evidence_ids.length} evidence items sent</span>
              <Badge tone="muted" title="Answer depth and wording requested for this turn. The evidence and citation checks are the same in every mode.">
                {depth === "detailed" ? "Detailed" : "Concise"}
                {style === "simple" ? " · simple wording" : ""}
              </Badge>
            </div>
            {answer ? <AnswerBody answer={answer} ev={ev} onCreateSafeguard={onCreateSafeguard} inChat /> : null}
          </div>
        </details>
        {answer ? (
          <div className="flex flex-wrap items-center gap-0.5 text-fg-2">
            {onFollowUp ? (
              <div className="flex flex-wrap gap-0.5" role="group" aria-label="Follow-up on this answer">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={retrying}
                  title="Ask again in this investigation with a detailed answer (same evidence, same citation checks)"
                  onClick={() => onFollowUp(followUpQuestion("detail", turn.question), { depth: "detailed", style })}
                >
                  More detail
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={retrying}
                  title="Ask again in this investigation in plain language (same evidence, same citation checks)"
                  onClick={() => onFollowUp(followUpQuestion("simple", turn.question), { depth, style: "simple" })}
                >
                  Explain simply
                </button>
              </div>
            ) : null}
            <CopyAnswer text={answer.summary} />
          </div>
        ) : null}
      </div>
    </article>
  );
}
