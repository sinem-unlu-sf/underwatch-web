import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiRequestError, isPermissionDenied } from "../api/client";
import { getToken, setToken } from "../api/auth";
import { Icon } from "./ds/Icon";

export function SkeletonRows({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-2 p-3">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} className="skeleton h-3.5" style={{ width: `${c === 0 ? 22 : c === 1 ? 30 : 12}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonBlock({ lines = 4 }: { lines?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-2">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton h-3.5" style={{ width: `${90 - ((i * 17) % 45)}%` }} />
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading page">
      <div className="skeleton mb-2 h-5 w-64" />
      <div className="skeleton mb-6 h-3.5 w-96" />
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-line bg-surface-1 p-3">
          <SkeletonBlock lines={5} />
        </div>
        <div className="rounded-md border border-line bg-surface-1 p-3">
          <SkeletonBlock lines={5} />
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex gap-2.5 px-3 py-5">
      <Icon name="minus" size={15} className="mt-0.5 text-fg-2" />
      <div className="min-w-0">
        <div className="font-medium text-fg-1">{title}</div>
        {children ? <div className="mt-1 max-w-[70ch] text-fg-2">{children}</div> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

/** Loading with a visible label (not just shimmer), for panels where a skeleton shape would mislead. */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" className="flex items-center gap-2 px-3 py-4 text-fg-2">
      <Icon name="spinner" size={14} />
      <span>{label}</span>
    </div>
  );
}

/**
 * Data shown may be out of date (e.g. a cached response while a refetch failed, or a snapshot older than the run).
 * Pass `onRefresh` only if it actually refetches. No background polling (PRD Addendum B): refresh is user-initiated.
 */
export function StaleState({ children, asOf, onRefresh, refreshing }: { children?: ReactNode; asOf?: string | null; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-warn/40 bg-warn/8 px-3 py-2 text-[12.5px]">
      <span className="inline-flex items-center gap-1.5 font-medium text-warn">
        <Icon name="clock" size={13} />
        Possibly stale
      </span>
      <span className="text-fg-1">
        {children ?? "This view may not reflect the latest data."}
        {asOf ? (
          <>
            {" "}
            As of <time className="font-mono text-[12px]" dateTime={asOf}>{asOf}</time>.
          </>
        ) : null}
      </span>
      {onRefresh ? (
        <button type="button" className="btn btn-sm ml-auto" onClick={onRefresh} disabled={refreshing} aria-busy={refreshing || undefined}>
          {refreshing ? <Icon name="spinner" size={12} /> : null}
          Refresh
        </button>
      ) : null}
    </div>
  );
}

/** Data is partial (coverage gaps, truncated lists, collectors unavailable). Hatched = not established, never "safe". */
export function IncompleteState({ title = "Incomplete data", children }: { title?: string; children?: ReactNode }) {
  return (
    <div role="status" className="hatch flex gap-2.5 rounded-md px-3 py-2.5 text-[12.5px]">
      <Icon name="question" size={14} className="mt-px text-unknown" />
      <div className="min-w-0">
        <div className="font-medium text-unknown">{title}</div>
        {children ? <div className="mt-0.5 text-fg-1">{children}</div> : null}
      </div>
    </div>
  );
}

export function Cmd({ children }: { children: ReactNode }) {
  return <code className="rounded-[4px] border border-line bg-surface-0 px-1 py-px font-mono text-[12px] text-fg-0">{children}</code>;
}

export function ErrorState({ error, what = "data" }: { error: unknown; what?: string }) {
  const e = error instanceof ApiRequestError ? error : null;

  if (e?.kind === "unreachable") {
    return (
      <div role="alert" className="m-3 rounded-md border border-warn/50 bg-warn/8 p-3">
        <div className="flex items-center gap-1.5 font-semibold text-warn"><Icon name="alertCircle" size={14} />API not reachable</div>
        <p className="mt-1 text-fg-1">
          Could not load {what}: the Underwatch API did not answer at <Cmd>127.0.0.1:4600</Cmd>. Start it with{" "}
          <Cmd>pnpm --filter @kw/server dev</Cmd> (or <Cmd>pnpm dev</Cmd> from the repo root to run API and UI together).
        </p>
        <p className="mt-1 font-mono text-[11px] text-fg-2">
          {e.path}: {e.message}
        </p>
      </div>
    );
  }

  if (e?.kind === "contract") {
    return (
      <div role="alert" className="m-3 rounded-md border border-risk/55 bg-risk/8 p-3">
        <div className="flex items-center gap-1.5 font-semibold text-risk"><Icon name="alert" size={14} />Response does not match the API contract</div>
        <p className="mt-1 text-fg-1">
          The API answered, but the data failed validation against <Cmd>@kw/schema</Cmd>, so it is not displayed. This usually
          means the server and web app are out of sync.
        </p>
        <p className="mt-1 font-mono text-[11px] text-fg-2">
          {e.path}: {e.message}
        </p>
        {Array.isArray(e.details) && e.details.length > 0 ? (
          <ul className="mt-1 list-inside list-disc font-mono text-[11px] text-fg-2">
            {(e.details as string[]).map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (e && isPermissionDenied(e)) return <PermissionDenied message={e.message} />;

  if (e?.kind === "http" && e.code === "workspace_not_authorized") {
    return (
      <div role="alert" className="m-3 rounded-md border border-warn/50 bg-warn/8 p-3">
        <div className="flex items-center gap-1.5 font-semibold text-warn"><Icon name="alertCircle" size={14} />Workspace not authorized</div>
        <p className="mt-1 text-fg-1">{e.message}</p>
        <p className="mt-1 text-[12px] text-fg-2">Authorize the workspace (or create the demo workspace) under Settings → Workspaces. Nothing was written.</p>
      </div>
    );
  }

  if (e?.kind === "http" && e.code === "not_implemented") {
    return (
      <div role="status" className="m-3 hatch rounded-md p-3">
        <div className="flex items-center gap-1.5 font-semibold text-unknown"><Icon name="question" size={14} />Not available in this build</div>
        <p className="mt-1 text-fg-1">The server does not implement {what} yet. Nothing is simulated.</p>
        <p className="mt-1 font-mono text-[11px] text-fg-2">{e.message}</p>
      </div>
    );
  }

  if (e?.kind === "http" && (e.code === "timeout" || e.status === 504)) {
    return (
      <div role="alert" className="m-3 rounded-md border border-warn/50 bg-warn/8 p-3">
        <div className="flex items-center gap-1.5 font-semibold text-warn"><Icon name="alertCircle" size={14} />Timed out</div>
        <p className="mt-1 text-fg-1">Loading {what} took too long. Try again.</p>
      </div>
    );
  }

  if (e?.kind === "http" && e.code === "not_found") {
    return (
      <div role="alert" className="m-3 rounded-md border border-line-strong bg-surface-2 p-3">
        <div className="flex items-center gap-1.5 font-semibold text-fg-0"><Icon name="minus" size={14} />Not found</div>
        <p className="mt-1 text-fg-1">{e.message}</p>
      </div>
    );
  }

  return (
    <div role="alert" className="m-3 rounded-md border border-risk/55 bg-risk/8 p-3">
      <div className="flex items-center gap-1.5 font-semibold text-risk"><Icon name="alert" size={14} />Failed to load {what}</div>
      <p className="mt-1 font-mono text-[11px] text-fg-1">
        {e ? `${e.status ?? ""} ${e.code ?? ""} ${e.message}` : error instanceof Error ? error.message : String(error)}
      </p>
    </div>
  );
}

/**
 * 401/403 from the API. The server is local-only; when it runs in token mode the browser needs the token from the link
 * the server prints at startup. The pasted token is kept in localStorage ("kw.token") and sent as a Bearer header.
 */
export function PermissionDenied({ message }: { message?: string }) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const hadToken = getToken() !== null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setToken(value);
    setValue("");
    void qc.invalidateQueries();
  };
  return (
    <div role="alert" className="m-3 rounded-md border border-warn/50 bg-warn/8 p-3">
      <div className="flex items-center gap-1.5 font-semibold text-warn"><Icon name="alertCircle" size={14} />Permission denied</div>
      <p className="mt-1 text-fg-1">
        The Underwatch API refused this request{hadToken ? " with the stored access token" : " because no access token was sent"}. Open the app
        with the link the server prints at startup (run <Cmd>pnpm open</Cmd>, or copy the <Cmd>http://127.0.0.1:4601/overview?token=…</Cmd> link from the
        server log). The token is read once from the link, kept in this browser only, and removed from the address bar.
      </p>
      <p className="mt-1.5 text-fg-1">
        Or use a local account:{" "}
        {/* Plain links (not router Links) so this screen also works where it renders outside the router. */}
        <a href="/login">Log in</a>
        {" · "}
        <a href="/signup">Sign up</a>
      </p>
      {message ? <p className="mt-1 font-mono text-[11px] text-fg-2">{message}</p> : null}
      <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex min-w-[260px] flex-1 flex-col gap-1">
          <span className="label">Paste access token</span>
          <input
            type="password"
            autoComplete="off"
            className="field font-mono"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="token from the server's startup link"
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
          Use token
        </button>
        {hadToken ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setToken(null);
              void qc.invalidateQueries();
            }}
          >
            Forget stored token
          </button>
        ) : null}
      </form>
    </div>
  );
}

/** Inline error for a failed mutation (keeps panels compact). */
export function MutationError({ error, what }: { error: unknown; what: string }) {
  if (!error) return null;
  if (isPermissionDenied(error)) return <PermissionDenied message={(error as ApiRequestError).message} />;
  const e = error instanceof ApiRequestError ? error : null;
  return (
    <div role="alert" className="rounded-md border border-risk/55 bg-risk/8 p-2 text-[12px] text-fg-1">
      <span className="font-medium text-risk"><Icon name="alert" size={12} className="mr-1 inline align-[-2px]" />{what} failed. </span>
      {e ? (
        e.kind === "unreachable" ? (
          "The API is not reachable."
        ) : e.code === "not_implemented" ? (
          "Not available in this build yet (the server returned not_implemented). Nothing was changed."
        ) : (
          <>
            {e.message}
            {e.code ? <span className="ml-1 font-mono text-[11px] text-fg-2">({e.code})</span> : null}
          </>
        )
      ) : (
        String(error)
      )}
    </div>
  );
}
