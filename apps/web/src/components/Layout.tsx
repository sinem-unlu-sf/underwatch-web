import type { DataMode } from "@kw/schema";
import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { useAuthCheck, useSettingsStatus } from "../api/queries";
import { isPermissionDenied } from "../api/client";
import { Cmd, PermissionDenied } from "./states";
import { AskWitnessDrawerProvider } from "./askwitness/AskWitnessDrawer";
import { CommandPalette } from "./shell/CommandPalette";
import { rememberSectionSearch } from "./shell/nav";
import { Sidebar, useSidebarState } from "./shell/Sidebar";
import { TopBar, WorkspaceIndicator } from "./shell/TopBar";

export function Layout() {
  return (
    <AskWitnessDrawerProvider>
      <LayoutShell />
    </AskWitnessDrawerProvider>
  );
}

function LayoutShell() {
  const location = useLocation();
  // Remember each section's list filters (they live in the URL) so the sidebar returns to the same context.
  rememberSectionSearch(location.pathname, location.search);
  const sidebar = useSidebarState();
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full min-h-0">
      <Sidebar
        state={sidebar}
        footer={
          <>
            {sidebar.narrow ? (
              <div className="mb-2 -ml-2">
                <WorkspaceIndicator />
              </div>
            ) : null}
            API <span className="font-mono">127.0.0.1:4600</span> · local only
          </>
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar sidebar={sidebar} onOpenSearch={() => setSearchOpen(true)} />
        <ContextStrip />
        <main id="kw-main" className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6">
          <AuthGate />
        </main>
      </div>
      <CommandPalette open={searchOpen} onClose={closeSearch} />
    </div>
  );
}

/** 401/403 on the auth probe replaces every page with the permission-denied state (with a token field). */
function AuthGate() {
  const auth = useAuthCheck();
  if (auth.error && isPermissionDenied(auth.error)) return <PermissionDenied message={auth.error.message} />;
  return <Outlet />;
}

/** Compact strip under the top bar: the FIXTURE DATA banner, shown only when fixture data is present. */
function ContextStrip() {
  const settings = useSettingsStatus();
  if (!settings.data?.data_mode.contains_fixture_data) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-1 px-4 py-1 text-[11px] sm:px-6">
      <DataModeBanner mode={settings.data.data_mode} />
    </div>
  );
}

export function DataModeBanner({ mode }: { mode: DataMode }) {
  if (!mode.contains_fixture_data) return null;
  const onlyFixtures = mode.live_runs === 0;
  return (
    <div role="status" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-fg-1">
      <span className="rounded-sm bg-fg-0 px-1.5 py-px font-mono text-[10px] font-bold tracking-wider text-surface-0">FIXTURE DATA</span>
      {onlyFixtures ? (
        <span>
          All {mode.fixture_runs} run{mode.fixture_runs === 1 ? "" : "s"} shown are hand-authored fixtures, not live captures. No live run
          has been recorded.
        </span>
      ) : (
        <span>
          {mode.fixture_runs} fixture run{mode.fixture_runs === 1 ? "" : "s"} and {mode.live_runs} live run{mode.live_runs === 1 ? "" : "s"}.
          Fixture records carry a FIXTURE badge.
        </span>
      )}
      <span className="text-fg-2">
        Loaded with <Cmd>pnpm seed:fixtures</Cmd>
      </span>
    </div>
  );
}
