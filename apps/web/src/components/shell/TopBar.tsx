import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useLocation, useNavigate, matchPath } from "react-router";
import { accountQueryKeys, accountsApi } from "../../api/accounts";
import { getToken, onTokenChange, setToken } from "../../api/auth";
import { ApiRequestError, api, isPermissionDenied } from "../../api/client";
import { queryKeys, useAuthCheck, useSettingsStatus, useWorkspaces } from "../../api/queries";
import { AskWitnessLauncher } from "../askwitness/AskWitnessDrawer";
import { Button, Icon, Kbd } from "../ds";
import { ShellIcon, sectionFor, sectionHref } from "./nav";
import type { SidebarState } from "./Sidebar";

const isMac = () => {
  try {
    return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  } catch {
    return false;
  }
};

export function TopBar({ sidebar, onOpenSearch }: { sidebar: SidebarState; onOpenSearch: () => void }) {
  const settings = useSettingsStatus();
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3 sm:px-5">
      {sidebar.narrow ? (
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Open navigation"
          title="Open navigation ([)"
          aria-controls="kw-sidebar"
          aria-expanded={sidebar.mobileOpen}
          onClick={() => sidebar.setMobileOpen(true)}
        >
          <ShellIcon name="menu" />
        </button>
      ) : null}
      <div className="hidden sm:flex">
        <WorkspaceIndicator />
      </div>
      <Breadcrumbs />
      <div className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px]">
        <button type="button" className="btn btn-ghost gap-2 text-fg-2" onClick={onOpenSearch} aria-label="Search" aria-keyshortcuts="Meta+K Control+K" title="Search findings, runs and safeguards">
          <Icon name="search" size={14} />
          <span className="hidden text-[12px] lg:inline">Search…</span>
          <span className="hidden lg:inline-flex">
            <Kbd>{isMac() ? "⌘K" : "Ctrl K"}</Kbd>
          </span>
        </button>
        <AskWitnessLauncher />
        <ApiIndicator ok={settings.isSuccess} pending={settings.isPending} error={settings.error} />
        <SessionControl />
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Breadcrumbs + contextual page title (record titles come from the query cache the page already filled; no fetch).
// ---------------------------------------------------------------------------------------------------------------
type Crumb = { label: string; to?: string; mono?: boolean };

function useCachedTitle(kind: "finding" | "run" | "safeguard", id: string | undefined): string | null {
  const key = id ? (kind === "finding" ? queryKeys.finding(id) : kind === "run" ? queryKeys.run(id) : queryKeys.safeguard(id)) : ["none"];
  const { data } = useQuery({
    queryKey: key,
    queryFn: async (): Promise<unknown> => (kind === "finding" ? api.finding(id!) : kind === "run" ? api.run(id!) : api.safeguard(id!)),
    enabled: false, // read-only cache subscription: the detail page owns the fetch
  });
  if (!id || !data) return null;
  const d = data as { finding?: { title?: string }; run?: { label?: string | null; task_description?: string }; safeguard?: { title?: string } };
  if (kind === "finding") return d.finding?.title ?? null;
  if (kind === "run") return d.run?.label ?? d.run?.task_description ?? null;
  return d.safeguard?.title ?? null;
}

export function useBreadcrumbs(): Crumb[] {
  const { pathname } = useLocation();
  const finding = matchPath("/findings/:id", pathname)?.params.id;
  const run = matchPath("/runs/:id", pathname)?.params.id;
  const safeguard = matchPath("/safeguards/:id", pathname)?.params.id;
  const findingTitle = useCachedTitle("finding", finding);
  const runTitle = useCachedTitle("run", run);
  const safeguardTitle = useCachedTitle("safeguard", safeguard);
  const section = sectionFor(pathname);
  if (!section) return [{ label: "Not found" }];
  const detailId = finding ?? run ?? safeguard;
  if (!detailId) return [{ label: section.label }];
  const title = findingTitle ?? runTitle ?? safeguardTitle;
  return [{ label: section.label, to: sectionHref(section.to) }, title ? { label: title } : { label: detailId, mono: true }];
}

function Breadcrumbs() {
  const crumbs = useBreadcrumbs();
  const current = crumbs[crumbs.length - 1]!;
  useEffect(() => {
    document.title = `${current.label} · Underwatch`;
  }, [current.label]);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-1.5 text-[13px]">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={i} className={`flex min-w-0 items-center gap-1.5 ${last ? "" : "shrink-0"}`}>
              {i > 0 ? (
                <span aria-hidden="true" className="text-fg-disabled">
                  /
                </span>
              ) : null}
              {c.to && !last ? (
                <Link to={c.to} className="text-fg-2 no-underline hover:text-fg-0">
                  {c.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} title={c.label} className={`truncate font-medium text-fg-0 ${c.mono ? "font-mono text-[12px]" : ""}`}>
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Popover (click / Enter to open; Escape and outside click close; focus returns to the trigger).
// ---------------------------------------------------------------------------------------------------------------
function Popover({ trigger, label, children, align = "right" }: { trigger: ReactNode; label: string; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  return (
    <div ref={ref} className="relative">
      <button ref={btn} type="button" className="btn btn-ghost gap-1.5" aria-expanded={open} aria-controls={id} aria-label={label} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open ? (
        <div
          id={id}
          role="dialog"
          aria-label={label}
          className={`kw-fade-in absolute top-full z-50 mt-1.5 w-[300px] max-w-[calc(100vw-24px)] rounded-lg border border-line-strong bg-surface-2 p-3 text-[12px] text-fg-1 ${align === "right" ? "right-0" : "left-0"}`}
          style={{ boxShadow: "var(--shadow-overlay)" }}
        >
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Workspace indicator (GET /api/workspaces). Read-only: pages are not workspace-scoped in this build, so there is
// nothing to switch; the list shows what is authorized and links to Settings, where workspaces are managed.
// ---------------------------------------------------------------------------------------------------------------
export function WorkspaceIndicator() {
  const ws = useWorkspaces();
  if (ws.isPending) return <span className="px-2 text-[12px] text-fg-2">Workspace…</span>;
  if (ws.error) {
    if (isPermissionDenied(ws.error)) return null;
    return (
      <Link to="/settings" className="flex items-center gap-1 px-2 text-[12px] text-warn no-underline" title={(ws.error as Error).message}>
        <Icon name="alert" size={12} />
        Workspaces unavailable
      </Link>
    );
  }
  const items = ws.data.items;
  const active = items.filter((w) => w.status === "active");
  const primary = active[0] ?? items[0];
  const label = primary ? primary.label : "No workspace";
  return (
    <Popover
      align="left"
      label={`Workspace: ${label}${items.length > 1 ? ` (${items.length} authorized)` : ""}`}
      trigger={
        <>
          <ShellIcon name="folder" size={14} />
          <span className="max-w-[160px] truncate text-[12.5px] text-fg-0">{label}</span>
          {items.length > 1 ? <span className="rounded-sm bg-surface-3 px-1 font-mono text-[10.5px] text-fg-2">{items.length}</span> : null}
          <Icon name="chevronDown" size={12} className="text-fg-2" />
        </>
      }
    >
      {(close) => (
        <div>
          <div className="label mb-1.5">Authorized workspaces</div>
          {items.length === 0 ? (
            <p className="text-fg-2">No workspace is authorized yet. Safeguards cannot be applied until one is.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((w) => (
                <li key={w.id} className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-fg-0">{w.label}</span>
                    <span className={`flex items-center gap-0.5 text-[11px] ${w.status === "active" ? "text-fg-2" : "text-warn"}`}>
                      <Icon name={w.status === "active" ? "check" : "alert"} size={11} />
                      {w.status}
                    </span>
                  </div>
                  <div className="truncate font-mono text-[11px] text-fg-2" title={w.root_path}>
                    {w.root_path}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-fg-2">Views are not filtered by workspace in this build. Approved safeguards (CLAUDE.md edits) are written only inside these workspaces.</p>
          <Link to="/settings" onClick={close} className="mt-2 inline-block text-[12px]">
            Manage workspaces in Settings
          </Link>
        </div>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// API status + local session
// ---------------------------------------------------------------------------------------------------------------
export function ApiIndicator({ ok, pending, error }: { ok: boolean; pending: boolean; error: unknown }) {
  const unreachable = error instanceof ApiRequestError && error.kind === "unreachable";
  const text = pending ? "API: checking…" : ok ? "API: responding" : unreachable ? "API: not reachable" : "API: error";
  const icon = pending ? "spinner" : ok ? "check" : "alert";
  return (
    <span role="status" title={`${text} (127.0.0.1:4600, local only)`} className={`flex items-center gap-1 px-1 ${ok ? "text-fg-2" : pending ? "text-fg-2" : "text-warn"}`}>
      <Icon name={icon} size={12} />
      <span className="hidden md:inline">{text}</span>
      <span className="sr-only md:hidden">{text}</span>
    </span>
  );
}

function useStoredToken(): boolean {
  return useSyncExternalStore(onTokenChange, () => getToken() !== null, () => false);
}

export function SessionControl() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const auth = useAuthCheck();
  const hasToken = useStoredToken();
  const [confirming, setConfirming] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  // GET /api/accounts/me: a stored session token belongs to a local account; the local API token (or none) does not.
  const me = useQuery({ queryKey: accountQueryKeys.me, queryFn: accountsApi.me, enabled: hasToken, retry: false });
  const user = hasToken ? (me.data?.user ?? null) : null;
  const mode = auth.data?.mode;

  const finishLogout = (close: () => void) => {
    setToken(null);
    qc.removeQueries({ queryKey: accountQueryKeys.me });
    setConfirming(false);
    close();
    void qc.invalidateQueries();
    navigate("/login");
  };
  const logout = async (close: () => void) => {
    setLogoutError(null);
    setLoggingOut(true);
    try {
      await accountsApi.logout();
      finishLogout(close);
    } catch (err) {
      // 401: the session already expired or was revoked server-side; there is nothing left to end.
      if (err instanceof ApiRequestError && err.kind === "http" && err.status === 401) finishLogout(close);
      else setLogoutError(err instanceof ApiRequestError && err.kind === "unreachable" ? "The API is not reachable; the session was not ended." : `Log out failed: ${(err as Error).message}`);
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <Popover
      label={user ? `Account: ${user.name}` : "Local session"}
      trigger={
        <>
          <ShellIcon name="user" size={14} />
          <span className="hidden max-w-[140px] truncate text-[12px] xl:inline">{user ? user.name : "Local session"}</span>
        </>
      }
    >
      {(close) =>
        user ? (
          <div>
            <div className="label mb-1">Signed in</div>
            <p className="truncate font-medium text-fg-0" title={user.name}>
              {user.name}
            </p>
            <p className="truncate font-mono text-[11.5px] text-fg-2" title={user.email}>
              {user.email}
            </p>
            <p className="mt-1.5 text-fg-2">Local account on this Underwatch server.</p>
            {logoutError ? (
              <p role="alert" className="mt-2 text-[12px] text-danger">
                {logoutError}
              </p>
            ) : null}
            <div className="mt-2.5 flex gap-1.5">
              <Button size="sm" loading={loggingOut} loadingText="Logging out…" onClick={() => void logout(close)}>
                Log out
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <div className="label mb-1">Local session</div>
            <p>
              Underwatch runs on this machine; you are not signed in to a local account. {mode === "token"
                ? "The API requires the access token from the server's startup link or a signed-in account."
                : mode === "local_loopback"
                  ? "The API accepts loopback requests from this machine."
                  : auth.error
                    ? "The API refused or did not answer the access check."
                    : "Checking API access…"}
            </p>
            <p className="mt-1.5 flex items-center gap-1 text-fg-2">
              <Icon name={hasToken ? "check" : "minus"} size={12} />
              {hasToken ? "An access token is stored in this browser." : "No access token is stored in this browser."}
            </p>
            <p className="mt-1.5 flex gap-3 text-[12px]">
              <Link to="/login" onClick={close}>
                Log in
              </Link>
              <Link to="/signup" onClick={close}>
                Sign up
              </Link>
            </p>
            {hasToken ? (
              confirming ? (
                <div className="mt-2.5 rounded-md border border-line-strong p-2">
                  <p className="text-fg-0">Clear the stored token?</p>
                  <p className="mt-0.5 text-fg-2">If the server requires a token, every page shows Permission denied until you paste it again or reopen the startup link.</p>
                  <div className="mt-2 flex gap-1.5">
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => {
                        setToken(null);
                        setConfirming(false);
                        close();
                        void qc.invalidateQueries();
                      }}
                    >
                      Clear token
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn btn-sm mt-2.5" onClick={() => setConfirming(true)}>
                  Clear stored token…
                </button>
              )
            ) : null}
          </div>
        )
      }
    </Popover>
  );
}
