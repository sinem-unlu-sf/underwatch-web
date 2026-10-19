import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api/client";
import { FixtureBadge } from "../badges";
import { Icon, Kbd } from "../ds";
import { ALL_NAV, NavIcon, sectionHref, type NavIconName } from "./nav";

/**
 * Cmd/Ctrl+K command palette. Searches REAL records through the existing list APIs only:
 *  - runs: server-side substring search (GET /api/runs?q=) over id, label and task;
 *  - findings and safeguards: the list endpoints have no text search, so the most recent records
 *    (up to FINDINGS_SCAN / all safeguards) are fetched once when the palette opens and filtered here.
 * Plus the app's real pages. Nothing is fetched until the user opens the palette; no fake results.
 */
export const FINDINGS_SCAN = 500;
const PER_GROUP = 6;

type Result = { key: string; group: "Pages" | "Findings" | "Agent Runs" | "Safeguards"; label: string; meta: string; href: string; fixture?: boolean; icon: NavIconName };

const ONCE = { staleTime: 30_000, retry: false, refetchOnWindowFocus: false } as const;

function matches(q: string, ...fields: (string | null | undefined)[]) {
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(q));
}

function useDebounced(value: string, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <PaletteDialog onClose={onClose} />;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null);
  const listId = useId();
  const q = query.trim().toLowerCase();
  const debounced = useDebounced(query.trim(), 180);

  useEffect(() => {
    inputRef.current?.focus();
    const restore = restoreRef.current;
    return () => restore?.focus?.();
  }, []);

  const findings = useQuery({ queryKey: ["palette", "findings"], queryFn: () => api.findings({ limit: FINDINGS_SCAN }), ...ONCE });
  const safeguards = useQuery({ queryKey: ["palette", "safeguards"], queryFn: () => api.safeguards({}), ...ONCE });
  const runs = useQuery({
    queryKey: ["palette", "runs", debounced],
    queryFn: () => api.runs(debounced ? { q: debounced, limit: PER_GROUP } : { limit: PER_GROUP }),
    ...ONCE,
  });

  const results = useMemo<Result[]>(() => {
    const out: Result[] = [];
    for (const n of ALL_NAV) {
      if (!q || matches(q, n.label, n.description)) out.push({ key: `page:${n.to}`, group: "Pages", label: n.label, meta: n.description, href: sectionHref(n.to), icon: n.icon });
    }
    for (const f of (findings.data?.items ?? []).filter((f) => !q || matches(q, f.title, f.id, f.category, f.run_label, f.run_id)).slice(0, PER_GROUP)) {
      out.push({ key: `f:${f.id}`, group: "Findings", label: f.title, meta: `${f.severity} · ${f.status.replace(/_/g, " ")} · ${f.id}`, href: `/findings/${encodeURIComponent(f.id)}`, fixture: f.is_fixture, icon: "findings" });
    }
    // Server already filtered runs by `debounced`; while typing ahead of the debounce, keep showing only matching ones.
    for (const r of (runs.data?.items ?? []).filter((r) => !q || matches(q, r.id, r.label, r.task_description)).slice(0, PER_GROUP)) {
      out.push({ key: `r:${r.id}`, group: "Agent Runs", label: r.label ?? r.task_description, meta: `${r.agent_type} · ${r.status} · ${r.id}`, href: `/runs/${encodeURIComponent(r.id)}`, fixture: r.is_fixture, icon: "runs" });
    }
    for (const s of (safeguards.data?.items ?? []).filter((s) => !q || matches(q, s.title, s.id, s.finding_title, s.type)).slice(0, PER_GROUP)) {
      out.push({ key: `s:${s.id}`, group: "Safeguards", label: s.title, meta: `${s.verification_status.replace(/_/g, " ")} · for: ${s.finding_title}`, href: `/safeguards/${encodeURIComponent(s.id)}`, fixture: s.is_fixture, icon: "safeguards" });
    }
    return out;
  }, [q, findings.data, runs.data, safeguards.data]);

  useEffect(() => setActive(0), [q]);
  const clamped = results.length === 0 ? -1 : Math.min(active, results.length - 1);

  const go = (r: Result | undefined) => {
    if (!r) return;
    onClose();
    navigate(r.href);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (results.length ? (a + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[clamped]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault(); // focus stays in the dialog; arrows move through results
    }
  };

  useEffect(() => {
    document.getElementById(`${listId}-opt-${clamped}`)?.scrollIntoView?.({ block: "nearest" });
  }, [clamped, listId]);

  const errors = [
    findings.error ? `findings (${(findings.error as Error).message})` : null,
    runs.error ? `runs (${(runs.error as Error).message})` : null,
    safeguards.error ? `safeguards (${(safeguards.error as Error).message})` : null,
  ].filter(Boolean);
  const loading = findings.isPending || runs.isPending || safeguards.isPending || (q !== "" && debounced.toLowerCase() !== q && runs.isFetching);
  const truncatedFindings = findings.data && findings.data.total > findings.data.items.length;

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" onKeyDown={onKeyDown}>
      <div className="kw-fade-in absolute inset-0 bg-black/60" aria-hidden="true" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search Underwatch"
        className="kw-fade-in relative flex max-h-[70vh] w-full max-w-[600px] flex-col overflow-hidden rounded-lg border border-line-strong bg-surface-2"
        style={{ boxShadow: "var(--shadow-overlay)" }}
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Icon name="search" size={15} className="text-fg-2" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={clamped >= 0 ? `${listId}-opt-${clamped}` : undefined}
            aria-label="Search findings, runs, safeguards and pages"
            placeholder="Search findings, runs, safeguards, pages…"
            className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-fg-0 outline-none placeholder:text-fg-2"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {loading ? (
            <span className="flex items-center gap-1 text-[11px] text-fg-2" role="status">
              <Icon name="spinner" size={12} />
              Searching…
            </span>
          ) : null}
          <Kbd>Esc</Kbd>
        </div>

        <ul id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto py-1">
          {results.map((r, i) => {
            const header = r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              <li key={r.key} role="presentation">
                {header ? <div className="label px-3 pt-2.5 pb-1" role="presentation">{header}</div> : null}
                <div
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={i === clamped}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(r)}
                  className={`mx-1 flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 ${i === clamped ? "bg-surface-3 text-fg-0" : "text-fg-1"}`}
                >
                  <span className={i === clamped ? "text-accent" : "text-fg-2"}>
                    <NavIcon name={r.icon} size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{r.label}</span>
                    <span className="block truncate font-mono text-[11px] text-fg-2">{r.meta}</span>
                  </span>
                  {r.fixture ? <FixtureBadge isFixture compact /> : null}
                  {i === clamped ? <Icon name="chevronRight" size={12} className="text-fg-2" /> : null}
                </div>
              </li>
            );
          })}
          {results.length === 0 && !loading ? (
            <li role="presentation" className="px-3 py-6 text-center text-[13px] text-fg-2">
              No findings, runs, safeguards or pages match “{query.trim()}”.
            </li>
          ) : null}
        </ul>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-[11px] text-fg-2">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> open
          </span>
          {truncatedFindings ? (
            <span>
              Searching the {findings.data!.items.length} most recent of {findings.data!.total} findings.
            </span>
          ) : null}
          {errors.length ? (
            <span role="alert" className="flex items-center gap-1 text-warn">
              <Icon name="alert" size={12} />
              Could not search {errors.join(", ")}.
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
