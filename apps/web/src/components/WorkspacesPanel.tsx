import type { IntegrationStatus } from "@kw/schema";
import { useState, type FormEvent } from "react";
import { ApiRequestError } from "../api/client";
import { useAuthorizeWorkspace, useDemoWorkspace, useVerificationHarness, useWorkspaces } from "../api/queries";
import { Badge } from "./badges";
import { ErrorState, MutationError, SkeletonBlock } from "./states";
import { Mono, Time } from "./ui";

/**
 * Settings → Workspaces. The backend may edit CLAUDE.md files only inside workspaces listed here. The demo workspace
 * is disposable, created from a template with synthetic secrets only.
 */
export function WorkspacesPanel() {
  const q = useWorkspaces();
  const demo = useDemoWorkspace();
  const authorize = useAuthorizeWorkspace();
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmDemo, setConfirmDemo] = useState(false);

  const hasDemo = (q.data?.items ?? []).some((w) => w.kind === "demo");
  const absolute = path.trim().startsWith("/");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!absolute || !label.trim()) return;
    setConfirming(true);
  };

  return (
    <div data-testid="workspaces-panel">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-[80ch] text-[12px] text-fg-1">
            Underwatch's backend reads and writes files only inside workspaces you authorize here, and only <Mono>CLAUDE.md</Mono> files, after you approve a
            visible diff. The demo workspace is a disposable copy of a template under <Mono>data/workspaces/</Mono> containing synthetic secrets only.
          </p>
          <button
            type="button"
            className="btn"
            disabled={demo.isPending}
            aria-busy={demo.isPending || undefined}
            onClick={() => (hasDemo ? setConfirmDemo(true) : demo.mutate())}
          >
            {demo.isPending ? "Working…" : hasDemo ? "Reset demo workspace" : "Create demo workspace"}
          </button>
        </div>

        {confirmDemo ? (
          <div role="dialog" aria-label="Confirm demo reset" className="space-y-1.5 rounded-md border border-focus/60 bg-surface-2 p-3 shadow-[var(--shadow-raised)] text-[12px]">
            <div className="text-fg-1">Reset the demo workspace to the template? Changes made there (including applied safeguards) are discarded.</div>
            <div className="flex gap-1.5">
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  setConfirmDemo(false);
                  demo.mutate();
                }}
              >
                Reset demo workspace
              </button>
              <button type="button" className="btn" onClick={() => setConfirmDemo(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        <MutationError error={demo.error} what="Creating the demo workspace" />
        {demo.data ? (
          <div role="status" className="text-[12px] text-fg-1">
            Demo workspace {demo.data.reset ? "reset" : "created"} at <Mono>{demo.data.workspace.root_path}</Mono> ({demo.data.files.length} files, synthetic secrets
            only).
          </div>
        ) : null}

        {q.isPending ? (
          <SkeletonBlock lines={3} />
        ) : q.isError ? (
          <ErrorState error={q.error} what="workspaces" />
        ) : q.data.items.length === 0 ? (
          <div className="hatch rounded-md px-2 py-1.5 text-[12px] text-unknown">
            No workspace authorized. Safeguard proposals are offered as copyable patches only.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="data">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Kind</th>
                  <th>Path</th>
                  <th>Status</th>
                  <th>Authorized</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((w) => (
                  <tr key={w.id}>
                    <td>{w.label}</td>
                    <td>
                      <Badge tone={w.kind === "demo" ? "focus" : "neutral"}>{w.kind === "demo" ? "demo (synthetic)" : "user"}</Badge>
                    </td>
                    <td>
                      <Mono className="text-[11px]">{w.root_path}</Mono>
                    </td>
                    <td>
                      <Badge tone={w.status === "active" ? "neutral" : "unknown"}>{w.status}</Badge>
                    </td>
                    <td>
                      <Time iso={w.authorized_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form onSubmit={submit} className="space-y-2 border-t border-line pt-4">
          <h3 className="text-[13px] font-semibold text-fg-0">Authorize a local project</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-[2] basis-[18rem] flex-col gap-1">
              <span className="label">Absolute path</span>
              <input
                className="field font-mono"
                aria-invalid={path.trim() && !absolute ? true : undefined}
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setConfirming(false);
                }}
                placeholder="/Users/you/code/project"
              />
            </label>
            <label className="flex min-w-0 flex-1 basis-[10rem] flex-col gap-1">
              <span className="label">Label</span>
              <input
                className="field"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setConfirming(false);
                }}
                placeholder="my project"
              />
            </label>
            <button type="submit" className="btn" disabled={!absolute || !label.trim() || authorize.isPending}>
              Authorize…
            </button>
          </div>
          {path.trim() && !absolute ? <p role="alert" className="text-[11px] text-warn">Enter an absolute path (starting with /).</p> : null}
          {confirming ? (
            <div role="dialog" aria-label="Confirm workspace authorization" className="space-y-1.5 rounded-md border border-focus/60 bg-surface-2 p-3 shadow-[var(--shadow-raised)] text-[12px]">
              <div className="text-fg-1">
                Allow the Underwatch backend to read and edit <Mono>CLAUDE.md</Mono> files under <Mono className="text-fg-0">{path.trim()}</Mono>? Each edit
                still requires you to approve a visible diff, and conflicting changes are never overwritten. No other files are written.
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={authorize.isPending}
                  onClick={() =>
                    authorize.mutate(
                      { path: path.trim(), label: label.trim(), confirm: true },
                      {
                        onSuccess: () => {
                          setConfirming(false);
                          setPath("");
                          setLabel("");
                        },
                      },
                    )
                  }
                >
                  {authorize.isPending ? "Authorizing…" : "Yes, authorize this directory"}
                </button>
                <button type="button" className="btn" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          <MutationError error={authorize.error} what="Authorizing the workspace" />
        </form>
      </div>
    </div>
  );
}

const CONFIGURED: IntegrationStatus[] = ["configured", "connected", "degraded"];

/** Credentials: configured yes/no only. Values never reach the browser. */
export function CredentialsPanel({ aiStatus }: { aiStatus: IntegrationStatus | null }) {
  const harness = useVerificationHarness();
  const tokenCheck = harness.data?.checks.find((c) => /token/i.test(c.id));
  const yesNo = (v: boolean | null) =>
    v === null ? <Badge tone="unknown">unknown</Badge> : v ? <Badge tone="neutral">configured</Badge> : <Badge tone="unknown">not configured</Badge>;
  const harnessNi = harness.error instanceof ApiRequestError && harness.error.code === "not_implemented";
  return (
    <div aria-label="Credentials (status only)" role="group">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[12px] sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-y-2.5">
        <dt className="label pt-0.5 max-sm:mt-2">ai& API key</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {yesNo(aiStatus === null ? null : CONFIGURED.includes(aiStatus))}
          <span className="text-fg-2">
            <Mono>AIAND_API_KEY</Mono> in <Mono>.env.local</Mono> (server only). Without it Ask Witness records questions as unanswered and safeguards use templates.
          </span>
        </dd>
        <dt className="label pt-0.5 max-sm:mt-2">Claude token</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {yesNo(tokenCheck ? tokenCheck.ok : null)}
          <span className="text-fg-2">
            <Mono>~/.underwatch/claude-oauth-token</Mono>, used only by the verification harness.{" "}
            {harness.isError ? (harnessNi ? "Harness status not reported by this server build." : "Harness status unavailable.") : null}
          </span>
        </dd>
        <dt className="label pt-0.5 max-sm:mt-2">Verification harness</dt>
        <dd className="flex flex-wrap items-center gap-1.5">
          {harness.data ? (
            <>
              {harness.data.available ? <Badge tone="neutral">ready</Badge> : <Badge tone="unknown">not ready</Badge>}
              {harness.data.checks.map((c) => (
                <Badge key={c.id} tone={c.ok ? "muted" : "unknown"} title={c.detail}>
                  {c.ok ? "✓" : "✗"} {c.id}
                </Badge>
              ))}
            </>
          ) : (
            <span className="text-fg-2">{harness.isPending ? "checking…" : "unknown"}</span>
          )}
        </dd>
      </dl>
    </div>
  );
}
