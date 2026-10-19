import { outcomesForRun, type SafeguardDetailResponse, type VerificationRunV2 } from "@kw/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiRequestError, api, newClientRequestId } from "../../api/client";
import { invalidateAfterSafeguardChange, queryKeys, useVerificationHarness, useVerificationRun } from "../../api/queries";
import { Badge, FixtureBadge } from "../badges";
import { MutationError } from "../states";
import { Mono, Time } from "../ui";
import { OutcomePair } from "./OutcomePair";
import { CaseResultBadge, VerificationStateBadge } from "./parts";

/**
 * Controlled verification. The status shown is the server's, which derives "passed" only from recorded harness
 * observations (deriveVerificationState). When the harness cannot run, the server records "inconclusive".
 */
export function VerificationSection({ detail }: { detail: SafeguardDetailResponse }) {
  const qc = useQueryClient();
  const sg = detail.safeguard;
  const harness = useVerificationHarness();
  const runs = detail.verification_runs;
  const runningInList = runs.find((r) => r.verification_status === "running")?.id ?? null;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const pollId = activeId ?? runningInList;
  const polled = useVerificationRun(pollId);
  const polledStatus = polled.data?.run.verification_status;

  useEffect(() => {
    if (polledStatus && polledStatus !== "running") void invalidateAfterSafeguardChange(qc, sg.id, sg.finding_id);
  }, [polledStatus, qc, sg.id, sg.finding_id]);

  const start = useMutation({
    mutationFn: (rid: string) => api.startVerification(sg.id, { client_request_id: rid, ...(detail.current_version ? { version_id: detail.current_version.id } : {}) }),
    onSuccess: async (res) => {
      setActiveId(res.run.id);
      setRequestId(null);
      qc.setQueryData(queryKeys.verificationRun(res.run.id), res);
      await invalidateAfterSafeguardChange(qc, sg.id, sg.finding_id);
    },
  });

  const run = () => {
    // Reuse the key on retry after a network failure (idempotent); a fresh click gets a fresh key.
    const keep = requestId !== null && start.error instanceof ApiRequestError && start.error.kind === "unreachable";
    const rid = keep ? requestId : newClientRequestId();
    setRequestId(rid);
    start.mutate(rid);
  };

  const unavailable = detail.mechanism.availability.status === "unavailable";
  const canRun = detail.current_version !== null && !unavailable && !start.isPending && pollId === null;
  const display: VerificationRunV2[] = runs.map((r) => (polled.data && r.id === polled.data.run.id ? polled.data.run : r));
  if (polled.data && !runs.some((r) => r.id === polled.data!.run.id)) display.unshift(polled.data.run);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary" onClick={run} disabled={!canRun}>
          {start.isPending ? "Starting…" : pollId ? "Verification running…" : "Run verification"}
        </button>
        <span className="text-[12px] text-fg-2">
          {unavailable
            ? "This mechanism cannot be tested in this build."
            : detail.current_version === null
              ? "Legacy safeguard without a version: cannot be verified here."
              : detail.lifecycle_status !== "applied"
                ? "Runs against the current version in a disposable container; normally done after applying."
                : "Runs a restricted case and a legitimate case in a disposable container against a snapshot of the workspace."}
        </span>
      </div>
      <HarnessLine q={harness} />
      <MutationError error={start.error} what="Starting verification" />

      {detail.current_version && detail.current_version.verification_plan.cases.length > 0 ? (
        <div>
          <div className="label mb-1">Test plan (defined before running)</div>
          {display.length > 0 ? (
            <p className="mb-1 text-[11px] text-fg-2">
              This is the proposal's default plan. A run may use a different scripted scenario; each run below lists the cases it actually ran.
            </p>
          ) : null}
          <ul className="space-y-0.5 text-[12px]">
            {detail.current_version.verification_plan.cases.map((c) => (
              <li key={c.id} className="flex flex-wrap gap-1.5">
                <Badge tone={c.kind === "restricted" ? "warn" : "neutral"}>{c.kind}</Badge>
                <span className="text-fg-1">{c.description}</span>
                <span className="text-fg-2">expected: {c.expected}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {display.length === 0 ? (
        <div className="hatch rounded-md px-2 py-1.5 text-[12px] text-unknown">Not tested: no verification run recorded.</div>
      ) : (
        <div className="space-y-2">
          {display.map((r) => (
            <RunCard key={r.id} run={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function HarnessLine({ q }: { q: ReturnType<typeof useVerificationHarness> }) {
  if (q.isPending) return <div className="text-[11px] text-fg-2">Checking verification harness…</div>;
  if (q.isError) {
    const ni = q.error instanceof ApiRequestError && q.error.code === "not_implemented";
    return <div className="text-[11px] text-fg-2">Harness status {ni ? "not reported by this server build" : "unavailable"}.</div>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-2">
      <span>Harness:</span>
      {q.data.available ? <Badge tone="neutral">ready</Badge> : <Badge tone="unknown">not ready (runs will be inconclusive)</Badge>}
      {q.data.checks.map((c) => (
        <Badge key={c.id} tone={c.ok ? "muted" : "unknown"} title={c.detail}>
          {c.ok ? "✓" : "✗"} {c.id}
        </Badge>
      ))}
    </div>
  );
}

const GENERIC_AGENT_LABEL =
  "Experimental - generic CLI agent (Codex CLI on ai&): kernel/proxy/git observation + reported commands/final-summary comparison only; no Claude-specific hooks or permission rules";

function RunCard({ run: r }: { run: VerificationRunV2 }) {
  const restricted = r.cases.filter((c) => c.kind === "restricted");
  const legit = r.cases.filter((c) => c.kind === "legitimate");
  return (
    <div className="space-y-1.5 rounded-md border border-line bg-surface-1 p-3" data-testid="verification-run">
      <div className="flex flex-wrap items-center gap-1.5">
        <FixtureBadge isFixture={r.is_fixture} compact />
        <VerificationStateBadge state={r.verification_status} />
        {r.environment?.agent === "codex-cli" ? <Badge tone="warn">experimental · generic CLI agent</Badge> : null}
        <Mono className="text-[11px] text-fg-2">{r.id}</Mono>
        <span className="ml-auto text-[11px] text-fg-2">
          <Time iso={r.started_at} /> → {r.ended_at ? <Time iso={r.ended_at} /> : "running"}
        </span>
      </div>
      {r.environment?.agent === "codex-cli" ? (
        <div className="text-[12px] text-fg-1" data-testid="generic-agent-banner">
          {r.environment.agent_label ?? GENERIC_AGENT_LABEL}
          <div className="text-[11px] text-fg-2">
            Agent: OpenAI Codex CLI 0.163.0 · Model: ai& {r.environment.model ?? "?"} via credential broker · Commands and final summary are agent-reported (codex exec --json), not hooks; Tetragon, egress proxy and git diff are the observed sources.
          </div>
        </div>
      ) : null}
      {r.verification_status === "running" ? (
        <div className="text-[12px] text-focus">Running in the disposable container… (polling every 2s)</div>
      ) : (
        <OutcomePair outcomes={outcomesForRun(r)} compact />
      )}
      {r.cases.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Case</th>
                <th>Expected</th>
                <th>Observed</th>
                <th>Result</th>
                <th>Sources</th>
              </tr>
            </thead>
            <tbody>
              {[...restricted, ...legit].map((c) => (
                <tr key={c.case_id}>
                  <td>
                    <Badge tone={c.kind === "restricted" ? "warn" : "neutral"}>{c.kind}</Badge>
                    <div className="font-mono text-[11px] text-fg-2">{c.case_id}</div>
                  </td>
                  <td className="text-fg-1">{c.expected}</td>
                  <td className="text-fg-1">{c.observed ?? <span className="text-fg-2">not observed</span>}</td>
                  <td>
                    <CaseResultBadge result={c.result} />
                  </td>
                  <td>
                    {c.sources.length === 0 ? (
                      <span className="text-fg-2">none</span>
                    ) : (
                      c.sources.map((s) => (
                        <div key={s}>
                          <Mono className="text-[11px]">{s}</Mono>
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : r.verification_status !== "running" ? (
        <div className="text-[12px] text-fg-2">
          {r.version_id === null ? "Legacy run (pre-versioning):" : "No per-case results recorded."} {r.notes ?? ""}
        </div>
      ) : null}
      {r.limitations.length > 0 ? (
        <div>
          <div className="label">Limitations</div>
          <ul className="list-inside list-disc text-[12px] text-fg-1">
            {r.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.environment ? (
        <div className="flex flex-wrap gap-x-3 text-[11px] text-fg-2">
          {r.environment.image ? <span>image <Mono>{r.environment.image}</Mono></span> : null}
          {r.environment.claude_code_version ? <span>claude code <Mono>{r.environment.claude_code_version}</Mono></span> : null}
          {r.environment.model ? <span>model <Mono>{r.environment.model}</Mono></span> : null}
          {r.environment.policy_hash ? <span>policy <Mono>{r.environment.policy_hash.slice(0, 12)}</Mono></span> : null}
        </div>
      ) : null}
      {r.artifacts.length > 0 ? (
        <div className="flex flex-wrap gap-1 text-[11px] text-fg-2">
          Artifacts:
          {r.artifacts.map((a) => (
            <Badge key={a.blob_sha256 + a.kind} tone="muted" mono title={`${a.blob_sha256} · ${a.size_bytes} bytes`}>
              {a.label}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
