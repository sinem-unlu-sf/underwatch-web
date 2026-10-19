import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * The honesty vocabulary. Every pill renders a symbol AND a text label (never colour alone).
 *  - verified:     backed by a passing verification run ("verified for tested scenario"). The ONLY green state.
 *  - failed:       verification / operation failed.
 *  - inconclusive: ran, but the result does not establish either way.
 *  - unknown:      not observed / not established. Hatched; never reads as "safe".
 *  - fixture:      hand-authored sample data, not a live capture.
 *  - reported:     from the agent's own account.
 *  - observed:     independently captured outside the agent's narrative.
 *  - derived:      produced by Underwatch analysis, not raw evidence.
 *  - inferred:     model / heuristic interpretation; may be wrong.
 *  - policy:       relates to an explicit policy rule (violation or applicable rule).
 *  - risk:         meaningful security risk.
 *  - caution:      needs attention.
 *  - active / pending / neutral: system states.
 */
export type StatusKind =
  | "verified"
  | "failed"
  | "inconclusive"
  | "unknown"
  | "fixture"
  | "reported"
  | "observed"
  | "derived"
  | "inferred"
  | "policy"
  | "risk"
  | "caution"
  | "active"
  | "pending"
  | "neutral";

const SPEC: Record<StatusKind, { icon: IconName; cls: string; label: string; title: string }> = {
  verified: { icon: "check", cls: "border-verified/45 bg-verified/12 text-verified", label: "Verified", title: "Verified for the tested scenario only" },
  failed: { icon: "x", cls: "border-risk/50 bg-risk/12 text-risk", label: "Failed", title: "Failed" },
  inconclusive: { icon: "question", cls: "hatch text-warn", label: "Inconclusive", title: "Ran, but the result does not establish the outcome" },
  unknown: { icon: "circle", cls: "hatch text-unknown", label: "Unknown", title: "Not observed / not established. Not the same as safe." },
  fixture: { icon: "file", cls: "border-fg-0 bg-fg-0 text-surface-0 font-mono tracking-wider", label: "FIXTURE", title: "Fixture data: hand-authored sample, not captured from a live agent run" },
  reported: { icon: "quote", cls: "border-reported/45 bg-reported/12 text-reported", label: "Reported", title: "Agent-reported: from the agent's own account" },
  observed: { icon: "eye", cls: "border-observed/45 bg-observed/12 text-observed", label: "Observed", title: "Independently observed outside the agent's narrative" },
  derived: { icon: "derive", cls: "border-line-strong bg-surface-2 text-fg-1", label: "Derived", title: "Derived by Underwatch analysis. Not raw evidence." },
  inferred: { icon: "inferred", cls: "border-dashed border-line-strong bg-transparent text-fg-1", label: "Inferred", title: "Interpretation, not evidence. May be wrong." },
  policy: { icon: "shield", cls: "border-accent/45 bg-accent/12 text-accent", label: "Policy", title: "Relates to an explicit policy rule" },
  risk: { icon: "alert", cls: "border-risk/50 bg-risk/12 text-risk", label: "Risk", title: "Meaningful security risk" },
  caution: { icon: "alertCircle", cls: "border-warn/45 bg-warn/12 text-warn", label: "Needs attention", title: "Needs attention" },
  active: { icon: "dot", cls: "border-accent/45 bg-accent/12 text-accent", label: "Active", title: "In progress" },
  pending: { icon: "clock", cls: "border-line bg-transparent text-fg-2", label: "Pending", title: "Pending" },
  neutral: { icon: "minus", cls: "border-line-strong bg-surface-2 text-fg-1", label: "", title: "" },
};

export function StatusPill({
  kind,
  children,
  title,
  size = "md",
  className = "",
}: {
  kind: StatusKind;
  /** Visible label. Defaults to the vocabulary label (e.g. "Verified"). Keep the honest wording. */
  children?: ReactNode;
  title?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const s = SPEC[kind];
  return (
    <span
      title={title ?? (s.title || undefined)}
      data-status={kind}
      className={`inline-flex shrink-0 items-center gap-1 rounded-[5px] border font-medium whitespace-nowrap ${
        size === "sm" ? "px-1.5 py-0 text-[10.5px] leading-4" : "px-1.5 py-px text-[11px] leading-4"
      } ${s.cls} ${className}`}
    >
      <Icon name={s.icon} size={size === "sm" ? 10 : 11} />
      {children ?? s.label}
    </span>
  );
}

export const STATUS_ICON: Record<StatusKind, IconName> = Object.fromEntries(Object.entries(SPEC).map(([k, v]) => [k, v.icon])) as Record<StatusKind, IconName>;
