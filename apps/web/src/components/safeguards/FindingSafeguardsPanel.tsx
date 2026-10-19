import { MECHANISMS, SafeguardType, type Safeguard, type SafeguardProposalResponse } from "@kw/schema";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiRequestError, api, newClientRequestId } from "../../api/client";
import { invalidateAfterSafeguardChange, queryKeys, useSafeguard, useWorkspaces } from "../../api/queries";
import { ApplicationBadge, ApprovalBadge, FixtureBadge, VerificationBadge } from "../badges";
import { EmptyState, ErrorState, MutationError, SkeletonBlock } from "../states";
import { Panel } from "../ui";
import { EnforcementExplainer, MechanismBadge } from "./parts";
import { SafeguardReview } from "./SafeguardReview";
import { SafeguardWorkflow, workflowForListItem } from "./Workflow";

export interface CreateSafeguardRequest {
  investigationId: string | null;
  /** Increments per click so the same investigation can be requested twice. */
  n: number;
}

/**
 * Safeguards for one finding, grouped by mechanism type, with "Create safeguard" (ai& when available, otherwise
 * clearly labeled templates). Generating a proposal never applies anything.
 */
export function FindingSafeguardsPanel({
  findingId,
  safeguards,
  request,
  onOpenEvidence,
}: {
  findingId: string;
  safeguards: Safeguard[];
  request: CreateSafeguardRequest | null;
  onOpenEvidence?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const workspaces = useWorkspaces();
  const active = (workspaces.data?.items ?? []).filter((w) => w.status === "active");
  const [workspaceId, setWorkspaceId] = useState<string | "">("");
  const effectiveWorkspace = workspaceId || active.find((w) => w.kind === "demo")?.id || active[0]?.id || "";
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lastGen, setLastGen] = useState<SafeguardProposalResponse["generation"] | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const pendingKey = useRef<{ key: string; inv: string | null } | null>(null);

  const propose = useMutation({
    mutationFn: (p: { key: string; inv: string | null }) =>
      api.proposeSafeguards(findingId, {
        client_request_id: p.key,
        ...(p.inv ? { investigation_id: p.inv } : {}),
        ...(effectiveWorkspace ? { workspace_id: effectiveWorkspace } : {}),
      }),
    onSuccess: async (res) => {
      pendingKey.current = null;
      setLastGen(res.generation);
      for (const item of res.items) qc.setQueryData(queryKeys.safeguard(item.safeguard.id), item);
      if (res.items[0]) setExpanded(res.items[0].safeguard.id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.finding(findingId) }),
        ...res.items.map((i) => invalidateAfterSafeguardChange(qc, i.safeguard.id)),
      ]);
    },
  });

  const create = (inv: string | null) => {
    // Network retry reuses the key (idempotent); otherwise a new request.
    const retry = pendingKey.current && propose.error instanceof ApiRequestError && propose.error.kind === "unreachable";
    const p = retry ? pendingKey.current! : { key: newClientRequestId(), inv };
    pendingKey.current = p;
    propose.mutate(p);
  };

  const handled = useRef(0);
  useEffect(() => {
    if (!request || request.n === handled.current) return;
    handled.current = request.n;
    panelRef.current?.scrollIntoView?.({ block: "start" });
    create(request.investigationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const groups = SafeguardType.options.map((t) => ({ type: t, items: safeguards.filter((s) => s.type === t) })).filter((g) => g.items.length > 0);

  return (
    <section ref={panelRef} id="safeguards">
      <Panel
        title={`Safeguards (${safeguards.length})`}
        aside={
          <>
            {workspaces.isSuccess ? (
              <select aria-label="Target workspace" className="field" value={effectiveWorkspace} onChange={(e) => setWorkspaceId(e.target.value)}>
                {active.length === 0 ? <option value="">No workspace (patch only)</option> : null}
                {active.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label} ({w.kind})
                  </option>
                ))}
              </select>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={() => create(request?.investigationId ?? null)} disabled={propose.isPending}>
              {propose.isPending ? "Generating…" : "Create safeguard"}
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-[12px] text-fg-1">
            <span className="font-medium text-warn">CLAUDE.md is guidance, not a security boundary.</span> Only permission rules and hooks can block actions,
            and only a passing verification run shows that a safeguard worked for the tested scenario. Nothing is written without a visible diff and your
            explicit approval.
          </p>
          {workspaces.isSuccess && active.length === 0 ? (
            <p className="text-[12px] text-fg-2">
              No authorized workspace: CLAUDE.md proposals are offered as a copyable patch only.{" "}
              <Link to="/settings#workspaces" className="text-focus hover:underline">
                Create the demo workspace
              </Link>
            </p>
          ) : null}
          {propose.isPending ? (
            <div role="status" className="text-[12px] text-fg-1">
              Retrieving the finding's evidence and generating proposals (ai& when available, otherwise templates)…
            </div>
          ) : null}
          <MutationError error={propose.error} what="Generating safeguard proposals" />
          {lastGen ? (
            <div role="status" className="text-[12px] text-fg-1">
              {lastGen.author === "ai" ? "Proposed by ai&." : "ai& unavailable: deterministic template proposals (no AI)."}{" "}
              <span className="text-fg-2">{lastGen.detail}</span>
            </div>
          ) : null}

          {groups.length === 0 ? (
            <EmptyState title="No safeguards for this finding yet">Create one to see proposals for a CLAUDE.md instruction, permission rule, or test.</EmptyState>
          ) : (
            groups.map((g) => {
              const m = MECHANISMS[g.type];
              return (
                <div key={g.type} className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <MechanismBadge kind={m.kind} />
                    <span className="text-[12px] font-medium text-fg-1">{m.label}</span>
                  </div>
                  <EnforcementExplainer m={m} compact />
                  <ul className="space-y-1.5">
                    {g.items.map((s) => (
                      <li key={s.id} className="rounded-md border border-line bg-surface-1">
                        <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
                          <FixtureBadge isFixture={s.is_fixture} compact />
                          <button
                            type="button"
                            className="text-left font-medium text-fg-0 hover:underline"
                            aria-expanded={expanded === s.id}
                            onClick={() => setExpanded(expanded === s.id ? null : s.id)}
                          >
                            {s.title}
                          </button>
                          <span className="ml-auto flex flex-wrap gap-1">
                            <ApprovalBadge status={s.approval_status} />
                            <ApplicationBadge status={s.application_status} />
                            <VerificationBadge status={s.verification_status} />
                          </span>
                          <Link to={`/safeguards/${encodeURIComponent(s.id)}`} className="text-[12px] text-focus hover:underline">
                            open
                          </Link>
                        </div>
                        <div className="px-2 pb-1.5">
                          <SafeguardWorkflow compact input={workflowForListItem(s)} label={`Workflow for ${s.title}`} />
                        </div>
                        {expanded === s.id ? (
                          <div className="border-t border-line p-2">
                            <InlineReview id={s.id} onOpenEvidence={onOpenEvidence} />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </div>
      </Panel>
    </section>
  );
}

function InlineReview({ id, onOpenEvidence }: { id: string; onOpenEvidence?: (id: string) => void }) {
  const q = useSafeguard(id);
  if (q.isPending) return <SkeletonBlock lines={5} />;
  if (q.isError) return <ErrorState error={q.error} what="this safeguard" />;
  return <SafeguardReview detail={q.data} onOpenEvidence={onOpenEvidence} />;
}
