import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { Kbd } from "../ds";
import { LogoMark, NavIcon, PRIMARY_NAV, SECONDARY_NAV, ShellIcon, sectionHref, type NavItem } from "./nav";

export const SIDEBAR_COLLAPSED_KEY = "kw.shell.sidebarCollapsed";
const NARROW_QUERY = "(max-width: 767px)";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function useIsNarrow(): boolean {
  const get = () => {
    try {
      return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
    } catch {
      return false;
    }
  };
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(NARROW_QUERY);
    const on = () => setNarrow(mql.matches);
    mql.addEventListener?.("change", on);
    return () => mql.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

/** True when a keystroke is meant for a text control, not for a global shortcut. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

/**
 * Sidebar state. Desktop: expanded (232px) / collapsed (64px), remembered per browser. Narrow screens (<768px):
 * the sidebar is an overlay drawer, closed by default and on navigation. `[` toggles whichever applies.
 */
export function useSidebarState() {
  const narrow = useIsNarrow();
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  const setCollapsed = useCallback((v: boolean) => {
    setCollapsedState(v);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? "1" : "0");
    } catch {
      // storage unavailable: preference lasts for this page load
    }
  }, []);

  const toggle = useCallback(() => {
    if (narrow) setMobileOpen((o) => !o);
    else setCollapsed(!collapsed);
  }, [narrow, collapsed, setCollapsed]);

  useEffect(() => setMobileOpen(false), [location.pathname]);
  useEffect(() => {
    if (!narrow) setMobileOpen(false);
  }, [narrow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { narrow, collapsed, setCollapsed, mobileOpen, setMobileOpen, toggle };
}

export type SidebarState = ReturnType<typeof useSidebarState>;

export function Sidebar({ state, footer }: { state: SidebarState; footer?: ReactNode }) {
  const { narrow, collapsed, setCollapsed, mobileOpen, setMobileOpen } = state;
  const drawerRef = useRef<HTMLDivElement>(null);

  // Overlay drawer: focus the first link on open, Escape closes.
  useEffect(() => {
    if (!mobileOpen) return;
    drawerRef.current?.querySelector<HTMLElement>("a,button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, setMobileOpen]);

  if (narrow) {
    if (!mobileOpen) return null;
    return (
      <div className="fixed inset-0 z-40 flex">
        <div className="kw-fade-in absolute inset-0 bg-black/60" aria-hidden="true" onClick={() => setMobileOpen(false)} />
        <div
          ref={drawerRef}
          id="kw-sidebar"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
          className="kw-fade-in relative flex h-full w-[232px] max-w-[85vw] flex-col border-r border-line bg-surface-1"
          style={{ boxShadow: "var(--shadow-overlay)" }}
        >
          <SidebarBody collapsed={false} footer={footer}>
            <button type="button" className="btn btn-ghost btn-icon ml-auto" aria-label="Close navigation" title="Close navigation" onClick={() => setMobileOpen(false)}>
              <ShellIcon name="x" />
            </button>
          </SidebarBody>
        </div>
      </div>
    );
  }

  return (
    <aside
      id="kw-sidebar"
      aria-label="Sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      className={`flex shrink-0 flex-col border-r border-line bg-surface-1 transition-[width] duration-200 ease-out ${collapsed ? "w-16" : "w-[232px]"}`}
    >
      <SidebarBody collapsed={collapsed} footer={collapsed ? null : footer}>
        {null}
      </SidebarBody>
      <div className="border-t border-line p-2">
        <CollapsedTip show={collapsed} label={<>Expand sidebar <Kbd>[</Kbd></>}>
          <button
            type="button"
            className={`btn btn-ghost w-full text-fg-2 ${collapsed ? "justify-center px-0" : "justify-start"}`}
            aria-controls="kw-sidebar"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar ([)" : "Collapse sidebar ([)"}
            onClick={() => setCollapsed(!collapsed)}
          >
            <ShellIcon name="sidebar" />
            {collapsed ? null : (
              <span className="flex flex-1 items-center justify-between text-[12px]">
                Collapse <Kbd>[</Kbd>
              </span>
            )}
          </button>
        </CollapsedTip>
      </div>
    </aside>
  );
}

function SidebarBody({ collapsed, footer, children }: { collapsed: boolean; footer?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className={`flex h-14 shrink-0 items-center gap-2.5 border-b border-line ${collapsed ? "justify-center px-0" : "px-4"}`}>
        <LogoMark />
        <div className={collapsed ? "sr-only" : "min-w-0 leading-tight"}>
          <div className="truncate text-[13.5px] font-semibold tracking-tight text-fg-0">Underwatch</div>
          <div className="truncate text-[11px] text-fg-2">agent behavior verification</div>
        </div>
        {children}
      </div>
      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {PRIMARY_NAV.map((item) => (
          <SidebarLink key={item.to} item={item} collapsed={collapsed} />
        ))}
        <div className="mt-auto flex flex-col gap-0.5 border-t border-line pt-2">
          {SECONDARY_NAV.map((item) => (
            <SidebarLink key={item.to} item={item} collapsed={collapsed} />
          ))}
        </div>
      </nav>
      {footer ? <div className="border-t border-line px-4 py-3 text-[11px] text-fg-2">{footer}</div> : null}
    </>
  );
}

function SidebarLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  return (
    <CollapsedTip show={collapsed} label={item.label}>
      <NavLink
        to={sectionHref(item.to)}
        end={item.end}
        title={collapsed ? item.label : undefined}
        className={({ isActive }) =>
          `relative flex h-8 items-center gap-2.5 rounded-sm text-[13px] no-underline transition-colors duration-150 ${
            collapsed ? "w-full justify-center" : "px-2.5"
          } ${isActive ? "bg-surface-2 font-medium text-fg-0" : "text-fg-1 hover:bg-surface-2 hover:text-fg-0"}`
        }
      >
        {({ isActive }) => (
          <>
            {isActive ? <span aria-hidden="true" className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-accent" /> : null}
            <span className={isActive ? "text-accent" : "text-fg-2"}>
              <NavIcon name={item.icon} />
            </span>
            <span className={collapsed ? "sr-only" : "truncate"}>{item.label}</span>
          </>
        )}
      </NavLink>
    </CollapsedTip>
  );
}

/** Right-side tooltip for the collapsed rail (hover + keyboard focus). Supplementary: the link keeps its text label. */
function CollapsedTip({ show, label, children }: { show: boolean; label: ReactNode; children: ReactNode }) {
  if (!show) return <>{children}</>;
  return (
    <div className="group relative flex">
      {children}
      <span
        aria-hidden="true"
        className="surface-raised pointer-events-none absolute top-1/2 left-full z-50 ml-2 hidden -translate-y-1/2 items-center gap-1.5 px-2 py-1 text-[12px] whitespace-nowrap text-fg-0 group-hover:flex group-has-[:focus-visible]:flex"
      >
        {label}
      </span>
    </div>
  );
}
