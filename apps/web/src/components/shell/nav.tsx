import type { SVGProps } from "react";

/**
 * App-shell navigation model. Every entry is a real route registered in App.tsx; nothing here links to an empty page.
 * Detail routes (/runs/:id?event=, /findings/:id, /safeguards/:id) stay deep-linkable and mark their section active.
 */
export type NavIconName = "overview" | "live" | "findings" | "runs" | "evidence" | "ask" | "safeguards" | "settings";

export type NavItem = { to: string; label: string; icon: NavIconName; end: boolean; description: string };

export const PRIMARY_NAV: readonly NavItem[] = [
  { to: "/overview", label: "Overview", icon: "overview", end: true, description: "Current state and next actions" },
  { to: "/live", label: "Live session", icon: "live", end: true, description: "Give the agent a task and watch reported vs observed behavior live" },
  { to: "/findings", label: "Findings", icon: "findings", end: false, description: "Discrepancies between reported and observed behavior" },
  { to: "/runs", label: "Agent Runs", icon: "runs", end: false, description: "Captured coding-agent sessions and their events" },
  { to: "/evidence", label: "Evidence Explorer", icon: "evidence", end: false, description: "Observed events and evidence records" },
  { to: "/ask", label: "Ask Witness", icon: "ask", end: false, description: "Questions answered from Underwatch records" },
  { to: "/safeguards", label: "Safeguards", icon: "safeguards", end: false, description: "Proposed, applied and verified safeguards" },
];

export const SECONDARY_NAV: readonly NavItem[] = [
  { to: "/settings", label: "Settings", icon: "settings", end: false, description: "Integrations, workspaces and access" },
];

export const ALL_NAV: readonly NavItem[] = [...PRIMARY_NAV, ...SECONDARY_NAV];

/** The nav section a pathname belongs to (detail pages belong to their list section). */
export function sectionFor(pathname: string): NavItem | undefined {
  // "/" is the public landing page (outside the shell); it still maps to Overview for older callers.
  if (pathname === "/" || pathname === "") return PRIMARY_NAV[0];
  return ALL_NAV.find((n) => pathname === n.to || pathname.startsWith(`${n.to}/`));
}

// ---------------------------------------------------------------------------------------------------------------
// Context memory: the last filter/selection query string seen on each section's list page, so going back to a
// section through the sidebar restores the investigation context (filters live in the URL, see lib/searchParams).
// ---------------------------------------------------------------------------------------------------------------
const SECTION_SEARCH_KEY = "kw.shell.sectionSearch";
const memory = new Map<string, string>();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = window.sessionStorage.getItem(SECTION_SEARCH_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") memory.set(k, v);
  } catch {
    // storage unavailable: context is remembered for this page load only
  }
}

/** Records the query string of a section list page (only exact section roots, never detail pages). */
export function rememberSectionSearch(pathname: string, search: string) {
  load();
  const item = ALL_NAV.find((n) => n.to === pathname && n.to !== "/overview");
  if (!item) return;
  const clean = search.startsWith("?") ? search : search ? `?${search}` : "";
  if ((memory.get(item.to) ?? "") === clean) return;
  if (clean) memory.set(item.to, clean);
  else memory.delete(item.to);
  try {
    window.sessionStorage.setItem(SECTION_SEARCH_KEY, JSON.stringify(Object.fromEntries(memory)));
  } catch {
    // ignore
  }
}

/** Link target for a section, carrying its remembered filters. */
export function sectionHref(to: string): string {
  load();
  return `${to}${memory.get(to) ?? ""}`;
}

/** Test hook. */
export function resetSectionMemory() {
  memory.clear();
  loaded = true;
  try {
    window.sessionStorage.removeItem(SECTION_SEARCH_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Icons (16px grid, 1.5px stroke, currentColor; decorative: always paired with a text label).
// ---------------------------------------------------------------------------------------------------------------
const NAV_PATHS: Record<NavIconName, string> = {
  overview: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  live: "M1.5 8h2.8l1.7-4.5 3.2 9 1.8-4.5h3.5",
  findings: "M8 2.5l6 11H2l6-11zM8 6.5v3.2M8 11.6v.1",
  runs: "M2.5 3h11v10h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5",
  evidence: "M7 12a5 5 0 100-10 5 5 0 000 10zM10.6 10.6l3.4 3.4M5 7h4M7 5v4",
  ask: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2v-7zM5.5 6.5h5M5.5 8.5h3",
  safeguards: "M8 1.8l5 2v4c0 3-2.2 5.3-5 6.4-2.8-1.1-5-3.4-5-6.4v-4l5-2zM5.8 8l1.6 1.6 2.9-3.1",
  settings:
    "M8 10a2 2 0 100-4 2 2 0 000 4zM8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2",
};

export function NavIcon({ name, size = 16, ...rest }: { name: NavIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
      {...rest}
    >
      <path d={NAV_PATHS[name]} />
    </svg>
  );
}

const SHELL_PATHS = {
  sidebar: "M2.5 3h11v10h-11zM6 3v10",
  menu: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11",
  user: "M8 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM3 13.5c.6-2.3 2.6-3.5 5-3.5s4.4 1.2 5 3.5",
  folder: "M2 4h4l1.5 1.5H14v7H2z",
  x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
} as const;
export type ShellIconName = keyof typeof SHELL_PATHS;

export function ShellIcon({ name, size = 16 }: { name: ShellIconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d={SHELL_PATHS[name]} />
    </svg>
  );
}

/** Product mark: an eye (witness) inside a kernel bracket. Decorative; the product name is always rendered as text. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false" className="shrink-0">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--color-elevated, #1A1A1F)" stroke="rgba(255,255,255,.12)" />
      <path d="M5 12s2.6-4.5 7-4.5 7 4.5 7 4.5-2.6 4.5-7 4.5S5 12 5 12z" fill="none" stroke="#EDEDF0" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2" fill="#8B8CF6" />
    </svg>
  );
}
