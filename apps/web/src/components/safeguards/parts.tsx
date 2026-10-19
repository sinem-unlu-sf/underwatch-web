import {
  SAFEGUARD_LIFECYCLE_LABELS,
  VERIFICATION_STATE_LABELS,
  type FileDiffPreview,
  type MechanismInfo,
  type MechanismKind,
  type SafeguardLifecycleStatus,
  type VerificationCaseResult,
  type VerificationState,
  type Workspace,
} from "@kw/schema";
import { useState } from "react";
import { Badge, type Tone } from "../badges";
import { Mono } from "../ui";

const KIND_TONE: Record<MechanismKind, Tone> = { instruction: "warn", "permission control": "neutral", hook: "neutral", test: "muted", "kernel enforcement": "neutral" };

export function MechanismBadge({ kind }: { kind: MechanismKind }) {
  return (
    <Badge tone={KIND_TONE[kind]} title={kind === "instruction" ? "Guidance only: cannot block anything" : undefined}>
      {kind}
    </Badge>
  );
}

/** Always visible next to a safeguard: what the mechanism can and cannot enforce, from the shared MECHANISMS table. */
export function EnforcementExplainer({ m, compact }: { m: MechanismInfo; compact?: boolean }) {
  return (
    <div className="space-y-1.5 rounded-md border border-line bg-surface-0 p-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <MechanismBadge kind={m.kind} />
        <span className="font-medium text-fg-0">{m.label}</span>
        {m.can_enforce ? (
          <Badge tone="neutral" title="Can block actions when applied and in effect; whether it does is shown only by verification">
            can enforce (when applied)
          </Badge>
        ) : (
          <Badge tone="warn">does not enforce</Badge>
        )}
        {m.availability.status === "unavailable" ? <Badge tone="unknown">unavailable in this build</Badge> : null}
      </div>
      {m.kind === "instruction" ? (
        <p className="font-medium text-warn">CLAUDE.md is guidance, not a security boundary. It cannot block an action.</p>
      ) : null}
      {m.availability.status === "unavailable" ? <p className="text-unknown">{m.availability.reason}</p> : null}
      <div className={compact ? "grid gap-2 md:grid-cols-2" : "grid gap-2 lg:grid-cols-2"}>
        <div>
          <div className="label">Can</div>
          <ul className="list-inside list-disc text-fg-1">
            {m.can.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="label">Cannot</div>
          <ul className="list-inside list-disc text-fg-1">
            {m.cannot.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      </div>
      {!compact ? (
        <div className="grid gap-1 text-fg-2">
          <div>
            <span className="label">Apply: </span>
            {m.apply_description}
          </div>
          <div>
            <span className="label">Test: </span>
            {m.test_description}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-fg-2";
  if (line.startsWith("@@")) return "text-focus";
  if (line.startsWith("+")) return "bg-verified/10 text-verified";
  if (line.startsWith("-")) return "bg-risk/10 text-risk";
  if (line.startsWith("\\")) return "text-fg-2";
  return "text-fg-1";
}

/** Before/after diff of a CLAUDE.md file. Content is untrusted: rendered as text only. */
export function DiffView({ preview, workspace }: { preview: FileDiffPreview; workspace: Workspace | null }) {
  const [mode, setMode] = useState<"diff" | "before" | "after">("diff");
  const lines = preview.unified_diff.replace(/\n$/, "").split("\n");
  return (
    <div className="space-y-1.5" data-testid="diff-view">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span>
          <span className="label">Target </span>
          {preview.workspace_id && workspace ? (
            <>
              <span className="text-fg-0">{workspace.label}</span> <Badge tone="muted">{workspace.kind}</Badge>{" "}
              <Mono className="text-fg-1">
                {workspace.root_path}/{preview.rel_path}
              </Mono>
            </>
          ) : (
            <>
              <Mono className="text-fg-1">{preview.rel_path}</Mono> <Badge tone="unknown">no workspace connected: diff against an empty file</Badge>
            </>
          )}
        </span>
        <span className="text-fg-2">
          {preview.before_exists ? "file exists" : "file does not exist yet (will be created)"} · before{" "}
          <Mono title={preview.before_sha256 ?? undefined}>{preview.before_sha256 ? preview.before_sha256.slice(0, 12) : "none"}</Mono> → after{" "}
          <Mono title={preview.after_sha256}>{preview.after_sha256.slice(0, 12)}</Mono>
        </span>
        <span className="ml-auto flex gap-1" role="group" aria-label="Diff view mode">
          {(["diff", "before", "after"] as const).map((m) => (
            <button key={m} type="button" className="btn btn-sm" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        </span>
      </div>
      {preview.duplicate_of ? (
        <div className="rounded-md border border-warn/50 bg-warn/10 px-2 py-1 text-[12px] text-fg-1">
          An equivalent instruction already exists in this file, so no change is proposed: <Mono>{preview.duplicate_of}</Mono>
        </div>
      ) : null}
      <pre className="max-h-96 overflow-auto rounded-md border border-line bg-surface-0 p-2 font-mono text-[12px] leading-[1.45]">
        {mode === "diff"
          ? lines.map((l, i) => (
              <div key={i} className={`whitespace-pre-wrap ${lineClass(l)}`}>
                {l || " "}
              </div>
            ))
          : mode === "before"
            ? (preview.before ?? "(file does not exist)")
            : preview.after}
      </pre>
    </div>
  );
}

const VSTATE_TONE: Record<VerificationState, Tone> = {
  not_tested: "unknown",
  running: "focus",
  passed: "verified",
  failed: "risk",
  inconclusive: "unknown",
};

/** Green only for "passed", which the server derives solely from recorded harness observations. */
export function VerificationStateBadge({ state }: { state: VerificationState }) {
  return <Badge tone={VSTATE_TONE[state]}>{VERIFICATION_STATE_LABELS[state]}</Badge>;
}

const CASE_TONE: Record<VerificationCaseResult, Tone> = { pass: "neutral", fail: "risk", not_exercised: "unknown", error: "warn" };
export function CaseResultBadge({ result }: { result: VerificationCaseResult }) {
  return <Badge tone={CASE_TONE[result]}>{result.replace("_", " ")}</Badge>;
}

type StepState = "done" | "current" | "todo" | "failed" | "off";

function Step({ label, state, detail }: { label: string; state: StepState; detail?: string }) {
  const cls =
    state === "done"
      ? "border-line-strong bg-surface-3 text-fg-0"
      : state === "current"
        ? "border-focus bg-focus/10 text-focus"
        : state === "failed"
          ? "border-risk/55 bg-risk/10 text-risk"
          : state === "off"
            ? "hatch text-unknown"
            : "border-line text-fg-2";
  return (
    <li className={`flex min-w-[110px] flex-1 flex-col rounded-md border px-2 py-1 ${cls}`} aria-current={state === "current" ? "step" : undefined}>
      <span className="text-[11px] font-semibold tracking-wide uppercase">{label}</span>
      {detail ? <span className="text-[11px]">{detail}</span> : null}
    </li>
  );
}

/** Proposed -> Approved -> Applied -> Verification. Distinguishes the states; never implies verification from approval. */
export function SafeguardStepper({ lifecycle, verification }: { lifecycle: SafeguardLifecycleStatus; verification: VerificationState }) {
  const order: SafeguardLifecycleStatus[] = ["proposed", "approved", "applied"];
  const idx = order.indexOf(lifecycle);
  const s = (i: number): StepState => {
    if (lifecycle === "rejected") return i === 0 ? "failed" : "off";
    if (lifecycle === "application_failed") return i < 2 ? "done" : i === 2 ? "failed" : "todo";
    if (lifecycle === "rolled_back") return i < 2 ? "done" : i === 2 ? "off" : "todo";
    return i < idx ? "done" : i === idx ? (lifecycle === "applied" ? "done" : "current") : "todo";
  };
  const vTone: StepState = verification === "passed" ? "done" : verification === "failed" ? "failed" : verification === "running" ? "current" : "off";
  return (
    <ol className="flex flex-wrap gap-1.5" aria-label="Safeguard status">
      <Step label="Proposed" state={s(0)} detail={lifecycle === "rejected" ? "Rejected" : undefined} />
      <Step label="Approved" state={s(1)} />
      <Step
        label="Applied"
        state={s(2)}
        detail={lifecycle === "application_failed" ? "Application failed" : lifecycle === "rolled_back" ? "Rolled back" : undefined}
      />
      <li className="flex min-w-[140px] flex-1 flex-col gap-0.5 rounded-md border border-line px-2 py-1" data-step-state={vTone}>
        <span className="text-[11px] font-semibold tracking-wide text-fg-1 uppercase">Verification</span>
        <span>
          <VerificationStateBadge state={verification} />
        </span>
      </li>
      <li className="sr-only">Lifecycle: {SAFEGUARD_LIFECYCLE_LABELS[lifecycle]}</li>
    </ol>
  );
}
