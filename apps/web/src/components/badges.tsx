import type { ReactNode } from "react";
import {
  EVENT_SOURCE_LABELS,
  FINDING_CATEGORY_LABELS,
  FINDING_STATUS_LABELS,
  type CategoryCoverageStatus,
  type Confidence,
  type CorrelationMatch,
  type CoverageLevel,
  type EventBasis,
  type EventSource,
  type FindingCategory,
  type FindingStatus,
  type IntegrationStatus,
  type Outcome,
  type RedactionStatus,
  type RunStatus,
  type SafeguardApplicationStatus,
  type SafeguardApprovalStatus,
  type SafeguardVerificationStatus,
  type Severity,
  type VerificationResult,
} from "@kw/schema";
import { humanize } from "../lib/format";
import { Icon, type IconName } from "./ds/Icon";

export type Tone = "neutral" | "muted" | "risk" | "risk-solid" | "warn" | "verified" | "unknown" | "reported" | "observed" | "focus";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-line-strong bg-surface-2 text-fg-0",
  muted: "border-line bg-transparent text-fg-2",
  risk: "border-risk/50 bg-risk/12 text-risk",
  "risk-solid": "border-risk-solid bg-risk-solid text-white",
  warn: "border-warn/45 bg-warn/12 text-warn",
  verified: "border-verified/45 bg-verified/12 text-verified",
  unknown: "hatch text-unknown",
  reported: "border-reported/45 bg-reported/12 text-reported",
  observed: "border-observed/45 bg-observed/12 text-observed",
  focus: "border-focus/45 bg-focus/12 text-focus",
};

/** Symbol paired with tone so status is never colour-only (decorative; the text label carries the meaning). */
const TONE_ICON: Partial<Record<Tone, IconName>> = {
  risk: "alert",
  "risk-solid": "alert",
  warn: "alertCircle",
  verified: "check",
  unknown: "question",
  reported: "quote",
  observed: "eye",
};

export function Badge({
  tone = "neutral",
  children,
  title,
  mono,
  icon,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  mono?: boolean;
  /** Override the tone's default symbol, or pass false to hide it. */
  icon?: IconName | false;
}) {
  const sym = icon === false ? undefined : (icon ?? TONE_ICON[tone]);
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border px-1.5 py-px text-[11px] leading-4 font-medium ${
        mono ? "font-mono" : ""
      } ${TONE_CLASS[tone]}`}
    >
      {sym ? <Icon name={sym} size={10} /> : null}
      {children}
    </span>
  );
}

/** Marks every record that came from a hand-authored fixture file rather than a live capture. */
export function FixtureBadge({ isFixture, compact }: { isFixture: boolean; compact?: boolean }) {
  if (!isFixture) return null;
  return (
    <span
      title="Fixture data: hand-authored sample loaded with `pnpm seed:fixtures`. Not captured from a live agent run."
      className="inline-flex shrink-0 items-center rounded-[4px] bg-fg-0 px-1.5 py-px font-mono text-[10px] leading-4 font-bold tracking-wider text-surface-0"
    >
      {compact ? "FX" : "FIXTURE"}
    </span>
  );
}

const SEVERITY_TONE: Record<Severity, Tone> = { critical: "risk-solid", high: "risk", medium: "warn", low: "neutral", info: "muted" };
export const SeverityBadge = ({ severity }: { severity: Severity }) => (
  <Badge tone={SEVERITY_TONE[severity]} title="Severity: impact if the finding is real">
    {severity.toUpperCase()}
  </Badge>
);

/** Confidence is deliberately neutral-toned so it is never read as severity. */
export const ConfidenceBadge = ({ confidence }: { confidence: Confidence }) => (
  <Badge tone="muted" title="Confidence: how strongly the evidence supports the finding">
    conf: {confidence}
  </Badge>
);

const FINDING_STATUS_TONE: Record<FindingStatus, Tone> = {
  new: "warn",
  under_review: "focus",
  unresolved: "warn",
  confirmed: "risk",
  resolved: "neutral",
  dismissed: "muted",
};
export const FindingStatusBadge = ({ status }: { status: FindingStatus }) => (
  <Badge tone={FINDING_STATUS_TONE[status]}>{FINDING_STATUS_LABELS[status]}</Badge>
);

export const CategoryLabel = ({ category }: { category: FindingCategory }) => (
  <span className="text-fg-1">{FINDING_CATEGORY_LABELS[category]}</span>
);

const RUN_STATUS_TONE: Record<RunStatus, Tone> = { pending: "muted", running: "focus", completed: "neutral", failed: "risk", aborted: "warn" };
export const RunStatusBadge = ({ status }: { status: RunStatus }) => <Badge tone={RUN_STATUS_TONE[status]}>{humanize(status)}</Badge>;

const COVERAGE_TONE: Record<CoverageLevel, Tone> = { complete: "neutral", partial: "warn", minimal: "warn", unknown: "unknown" };
export const CoverageBadge = ({ level }: { level: CoverageLevel }) => (
  <Badge tone={COVERAGE_TONE[level]} title="Observation coverage for this run">
    coverage: {level}
  </Badge>
);

const CATEGORY_COVERAGE_TONE: Record<CategoryCoverageStatus, Tone> = { observed: "neutral", partial: "warn", unavailable: "unknown" };
export const CategoryCoverageBadge = ({ status }: { status: CategoryCoverageStatus }) => (
  <Badge tone={CATEGORY_COVERAGE_TONE[status]}>{status === "unavailable" ? "not observed" : status}</Badge>
);

const BASIS_TONE: Record<EventBasis, Tone> = { reported: "reported", observed: "observed", derived: "neutral" };
const BASIS_TITLE: Record<EventBasis, string> = {
  reported: "Agent-reported: from the agent's own account (hooks, transcript, telemetry)",
  observed: "Independently observed: captured by a collector outside the agent's narrative",
  derived: "Derived: produced by Underwatch analysis. Not raw evidence.",
};
export const BasisBadge = ({ basis }: { basis: EventBasis }) => (
  <Badge tone={BASIS_TONE[basis]} title={BASIS_TITLE[basis]}>
    {basis}
  </Badge>
);

export const SourceBadge = ({ source }: { source: EventSource }) => (
  <Badge tone="muted" mono title={EVENT_SOURCE_LABELS[source]}>
    {source}
  </Badge>
);

const OUTCOME_TONE: Record<Outcome, Tone> = {
  attempted: "neutral",
  allowed: "neutral",
  denied: "warn",
  blocked: "warn",
  succeeded: "neutral",
  failed: "risk",
  unknown: "unknown",
};
export const OutcomeBadge = ({ outcome }: { outcome: Outcome }) => <Badge tone={OUTCOME_TONE[outcome]}>{outcome}</Badge>;

const INTEGRATION_TONE: Record<IntegrationStatus, Tone> = {
  not_implemented: "unknown",
  not_configured: "unknown",
  configured: "neutral",
  connected: "verified",
  degraded: "warn",
  error: "risk",
  disabled: "muted",
};
export const IntegrationStatusBadge = ({ status }: { status: IntegrationStatus }) => (
  <Badge tone={INTEGRATION_TONE[status]}>{humanize(status).toLowerCase()}</Badge>
);

const CORRELATION_TONE: Record<CorrelationMatch, Tone> = { matched: "neutral", reported_only: "warn", observed_only: "warn", uncertain: "unknown" };
const CORRELATION_LABEL: Record<CorrelationMatch, string> = {
  matched: "matched",
  reported_only: "no observed counterpart",
  observed_only: "not reported by agent",
  uncertain: "uncertain correlation",
};
export const CorrelationBadge = ({ match, confidence }: { match: CorrelationMatch; confidence?: Confidence }) => (
  <Badge tone={CORRELATION_TONE[match]} title={confidence ? `Correlation confidence: ${confidence}` : undefined}>
    {CORRELATION_LABEL[match]}
  </Badge>
);

const REDACTION_TONE: Record<RedactionStatus, Tone> = { not_scanned: "unknown", no_secrets_detected: "neutral", redacted: "warn", withheld: "warn" };
export const RedactionBadge = ({ status }: { status: RedactionStatus }) => (
  <Badge tone={REDACTION_TONE[status]}>{humanize(status).toLowerCase()}</Badge>
);

const APPROVAL_TONE: Record<SafeguardApprovalStatus, Tone> = { proposed: "warn", approved: "neutral", rejected: "muted" };
export const ApprovalBadge = ({ status }: { status: SafeguardApprovalStatus }) => <Badge tone={APPROVAL_TONE[status]}>{status}</Badge>;

const APPLICATION_TONE: Record<SafeguardApplicationStatus, Tone> = {
  not_applied: "muted",
  applied: "neutral",
  application_failed: "risk",
  reverted: "muted",
};
export const ApplicationBadge = ({ status }: { status: SafeguardApplicationStatus }) => (
  <Badge tone={APPLICATION_TONE[status]}>{humanize(status).toLowerCase()}</Badge>
);

/** Green is reserved for verified_for_tested_scenario: the only state backed by a passing verification run. */
const VERIFICATION_TONE: Record<SafeguardVerificationStatus, Tone> = {
  not_tested: "unknown",
  test_pending: "muted",
  verified_for_tested_scenario: "verified",
  failed_verification: "risk",
  verification_inconclusive: "unknown",
};
export const VerificationBadge = ({ status }: { status: SafeguardVerificationStatus | VerificationResult }) => (
  <Badge tone={VERIFICATION_TONE[status]}>{humanize(status).toLowerCase()}</Badge>
);

/** Tri-state value from evidence: null is "not established", rendered distinctly from yes/no. */
export function TriState({ value, yes = "yes", no = "no" }: { value: boolean | null; yes?: string; no?: string }) {
  if (value === null) return <Badge tone="unknown">not established</Badge>;
  return <Badge tone="neutral">{value ? yes : no}</Badge>;
}

/** Inline rendering of a field the source could not provide. */
export const Unavailable = ({ label = "not available" }: { label?: string }) => (
  <span className="hatch inline-block rounded-[4px] px-1 text-[11px] text-unknown">{label}</span>
);

/**
 * Policy violation vs needs review (PRD FR4-15). Derived in the UI from the finding category: the server does not
 * persist a separate classification field. Only "permission_violation" counts as a violation; other categories are
 * discrepancies that need review, even when they relate to a policy rule.
 */
export function isPolicyViolation(f: { category: FindingCategory }): boolean {
  return f.category === "permission_violation";
}

export function FindingKindBadge({ finding }: { finding: { category: FindingCategory; policy_rule_id?: string | null } }) {
  const rule = finding.policy_rule_id ? ` Related policy rule: ${finding.policy_rule_id}.` : "";
  return isPolicyViolation(finding) ? (
    <Badge tone="risk" title={`Category is permission violation: an action the supervised policy does not allow.${rule} Derived from the finding category.`}>
      Policy violation
    </Badge>
  ) : (
    <Badge tone="muted" title={`A discrepancy between reported and observed evidence, not a policy violation by itself.${rule} Needs human review.`}>
      Needs review
    </Badge>
  );
}
