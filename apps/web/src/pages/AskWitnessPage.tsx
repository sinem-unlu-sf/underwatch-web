import {
  ASK_WITNESS_INVESTIGATOR_QUESTIONS,
  ASK_WITNESS_SUGGESTED_QUESTIONS,
  type BundleEvidenceRef,
  type FindingListItem,
  type InvestigationTurn,
  type RunListItem,
} from "@kw/schema";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ApiRequestError, api, newClientRequestId } from "../api/client";
import { queryKeys, useFindings, useRuns } from "../api/queries";
import { asBundleRef, citationHref, scopedApi, scopeKey, type AskScope, type ScopedEvidenceRef } from "../api/scopedAsk";
import { TurnView, type EvidenceLookup, type FollowUpMode } from "../components/askwitness/AnswerView";
import { SCOPE_SUGGESTIONS } from "../components/askwitness/AskWitnessDrawer";
import { SUGGESTION_MODE } from "../components/askwitness/AskWitnessPanel";
import { AI_FOOTNOTE, ChatComposer, PendingTurn, PillSelect, SuggestionCards } from "../components/askwitness/ChatParts";
import { EvidenceRefDrawer } from "../components/askwitness/EvidenceRef";
import { FixtureBadge, SeverityBadge } from "../components/badges";
import { Icon, Notice, StatusPill } from "../components/ds";
import { ErrorState, MutationError, SkeletonBlock } from "../components/states";
import { Mono, Time } from "../components/ui";
import { truncate } from "../lib/format";
import { useUrlFilters } from "../lib/searchParams";

/**
 * Ask Witness workspace (full page). Same server routes, evidence rules and answer rendering as the drawer and the
 * finding panel: the server answers from a small, capped, redacted bundle of Underwatch's own records for the chosen
 * scope and validates every citation; this page renders the validated turns with TurnView. Nothing is fetched in the
 * background and nothing opens by itself. Scope, run, finding and investigation live in the URL so a view is linkable.
 */

type ScopeChoice = "workspace" | "run" | "finding";

interface HistoryItem {
  id: string;
  updated_at: string;
  turn_count: number;
  last_question: string | null;
}

interface Pending {
  question: string;
  clientRequestId: string;
  investigationId: string | null;
  mode?: FollowUpMode;
}

interface ConversationSource {
  key: string;
  listKey: QueryKey;
  list: () => Promise<HistoryItem[]>;
  detailKey: (id: string) => QueryKey;
  detail: (id: string) => Promise<{ turns: InvestigationTurn[]; index: ScopedEvidenceRef[]; ai: { available: boolean; detail: string } | null }>;
  ask: (p: Pending) => Promise<{ investigationId: string; index: ScopedEvidenceRef[] }>;
  suggestions: readonly string[];
  investigatorQuestions: readonly string[];
  records: ReactNode;
  inputLabel: string;
  noun: string;
  findingId: string | null;
  /** Other views' cache entries that show the same investigation (finding page panel, evidence graph). */
  alsoInvalidate?: (investigationId: string) => QueryKey[];
}

/** Shared with the drawer so a conversation started here continues there (same tab). */
const DRAWER_STORAGE_KEY = "kw.askwitness.scoped";
function rememberForDrawer(key: string, investigationId: string) {
  try {
    const raw = window.sessionStorage.getItem(DRAWER_STORAGE_KEY);
    const ids = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    window.sessionStorage.setItem(DRAWER_STORAGE_KEY, JSON.stringify({ ...ids, [key]: investigationId }));
  } catch {
    // storage unavailable: the drawer simply starts from its own lookup
  }
}

const ONCE = { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: 30_000 } as const;

const fromBundle = (r: BundleEvidenceRef): ScopedEvidenceRef => ({ ...r, finding_id: null, safeguard_id: null });

const modeBody = (m?: FollowUpMode) => ({
  ...(m?.depth && m.depth !== "concise" ? { depth: m.depth } : {}),
  ...(m?.style && m.style !== "standard" ? { style: m.style } : {}),
});

function scopedSource(scope: AskScope): ConversationSource {
  const key = scopeKey(scope);
  return {
    key,
    listKey: ["askPage", "list", key],
    list: () => scopedApi.list(scope),
    detailKey: (id) => ["askPage", "detail", id],
    detail: (id) => scopedApi.detail(id).then((d) => ({ turns: d.turns, index: d.evidence_index, ai: d.ai })),
    ask: (p) =>
      scopedApi
        .ask(scope, {
          question: p.question,
          client_request_id: p.clientRequestId,
          ...(p.investigationId ? { investigation_id: p.investigationId } : {}),
          ...modeBody(p.mode),
        } as Parameters<typeof scopedApi.ask>[1])
        .then((r) => {
          rememberForDrawer(key, r.investigation.id);
          return { investigationId: r.investigation.id, index: r.evidence_index };
        }),
    suggestions: SCOPE_SUGGESTIONS[scope.kind],
    investigatorQuestions: [],
    records:
      scope.kind === "run" ? (
        <>
          this run's events, findings, coverage and policy (<Mono>{scope.runId}</Mono>)
        </>
      ) : (
        "all findings, runs, coverage, safeguards, verification results and today's digest"
      ),
    inputLabel: scope.kind === "run" ? "Ask a question about this run" : "Ask a question about all findings",
    noun: scope.kind === "run" ? "this run" : "all findings",
    findingId: null,
  };
}

function findingSource(findingId: string): ConversationSource {
  return {
    key: `finding:${findingId}`,
    // Page-local keys: the cached value is reshaped, so it must not share the finding panel's cache entries.
    listKey: ["askPage", "list", `finding:${findingId}`],
    list: () => api.findingInvestigations(findingId).then((r) => r.items),
    detailKey: (id) => ["askPage", "detail", id],
    detail: (id) => api.investigation(id).then((d) => ({ turns: d.turns, index: d.evidence_index.map(fromBundle), ai: d.ai })),
    ask: (p) =>
      api
        .askWitness(findingId, {
          question: p.question,
          client_request_id: p.clientRequestId,
          ...(p.investigationId ? { investigation_id: p.investigationId } : {}),
          ...modeBody(p.mode),
        })
        .then((r) => ({ investigationId: r.investigation.id, index: r.evidence_index.map(fromBundle) })),
    alsoInvalidate: (investigationId) => [queryKeys.findingInvestigations(findingId), queryKeys.investigation(investigationId), queryKeys.findingGraph(findingId)],
    suggestions: ASK_WITNESS_SUGGESTED_QUESTIONS,
    investigatorQuestions: ASK_WITNESS_INVESTIGATOR_QUESTIONS,
    records: "this finding's evidence bundle (redacted)",
    inputLabel: "Ask a question about this finding",
    noun: "this finding",
    findingId,
  };
}

const RAIL_KEY = "kw.askwitness.rail";
function initialRail(): boolean {
  try {
    const v = window.localStorage.getItem(RAIL_KEY);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch {
    // storage unavailable: fall through to the viewport default
  }
  return typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 1024px)").matches : true;
}

export function AskWitnessPage() {
  const { get, set } = useUrlFilters();
  const raw = get("scope");
  const choice: ScopeChoice = raw === "run" || raw === "finding" ? raw : "workspace";
  const runId = get("run") ?? null;
  const findingId = get("finding") ?? null;

  const runs = useRuns({ limit: 100 });
  const findings = useFindings({ limit: 200 });

  const source = useMemo<ConversationSource | null>(() => {
    if (choice === "workspace") return scopedSource({ kind: "workspace" });
    if (choice === "run") return runId ? scopedSource({ kind: "run", runId }) : null;
    return findingId ? findingSource(findingId) : null;
  }, [choice, runId, findingId]);

  const run = runId ? runs.data?.items.find((r) => r.id === runId) : undefined;
  const finding = findingId ? findings.data?.items.find((f) => f.id === findingId) : undefined;

  const [railOpen, setRailOpen] = useState(initialRail);
  const toggleRail = () =>
    setRailOpen((v) => {
      try {
        window.localStorage.setItem(RAIL_KEY, v ? "0" : "1");
      } catch {
        // per-viewer convenience only
      }
      return !v;
    });

  const scopeControls = (
    <>
      <PillSelect
        label="Ask Witness scope"
        value={choice}
        onChange={(v) => set({ scope: v === "workspace" ? undefined : v, inv: undefined }, { replace: true })}
        options={[
          ["workspace", "All findings"],
          ["run", "A run"],
          ["finding", "A finding"],
        ]}
      />
      {choice === "run" ? (
        <ScopePicker
          label="Run"
          value={runId}
          onChange={(v) => set({ run: v, inv: undefined })}
          query={runs}
          placeholder="Choose a run…"
          options={(runs.data?.items ?? []).map((r: RunListItem) => [r.id, `${r.is_fixture ? "[FIXTURE] " : ""}${r.label ? truncate(r.label, 56) : r.id}`])}
        />
      ) : null}
      {choice === "finding" ? (
        <ScopePicker
          label="Finding"
          value={findingId}
          onChange={(v) => set({ finding: v, inv: undefined })}
          query={findings}
          placeholder="Choose a finding…"
          options={(findings.data?.items ?? []).map((f: FindingListItem) => [f.id, `${f.is_fixture ? "[FIXTURE] " : ""}${truncate(f.title, 64)} · ${f.severity}`])}
        />
      ) : null}
    </>
  );

  const context =
    choice === "run" && run ? (
      <>
        <FixtureBadge isFixture={run.is_fixture} compact />
        <Link to={`/runs/${encodeURIComponent(run.id)}`} className="truncate font-medium text-fg-1 hover:text-fg-0 hover:underline">
          {run.label ?? run.id}
        </Link>
      </>
    ) : choice === "finding" && finding ? (
      <>
        <FixtureBadge isFixture={finding.is_fixture} compact />
        <Link to={`/findings/${encodeURIComponent(finding.id)}`} className="truncate font-medium text-fg-1 hover:text-fg-0 hover:underline">
          {finding.title}
        </Link>
        <SeverityBadge severity={finding.severity} />
      </>
    ) : null;

  const pickerError = choice === "run" && runs.isError ? { e: runs.error, what: "runs" } : choice === "finding" && findings.isError ? { e: findings.error, what: "findings" } : null;

  if (source) {
    return (
      <Conversation
        key={source.key}
        source={source}
        selected={get("inv") ?? null}
        onSelect={(id) => set({ inv: id }, { replace: true })}
        scopeControls={scopeControls}
        context={context}
        railOpen={railOpen}
        onToggleRail={toggleRail}
      />
    );
  }
  const what = choice === "run" ? "run" : "finding";
  return (
    <ChatFrame
      railOpen={railOpen}
      onToggleRail={toggleRail}
      context={context}
      rail={<p className="px-2 text-[12px] text-fg-2">Choose a {what} first.</p>}
      composer={<ChatComposer value="" onChange={() => {}} onSubmit={() => {}} label={`Ask a question about this ${what}`} placeholder={`Choose a ${what} below…`} disabled leading={scopeControls} />}
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
        <h2 className="text-[18px] font-semibold text-fg-0">Choose a {what} to ask about</h2>
        <p className="text-[12.5px] text-fg-2">Pick it from the selector in the composer.</p>
        {pickerError ? <ErrorState error={pickerError.e} what={pickerError.what} /> : null}
      </div>
    </ChatFrame>
  );
}

function ScopePicker({
  label,
  value,
  onChange,
  query,
  placeholder,
  options,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | undefined) => void;
  query: { isPending: boolean; isError: boolean; error: unknown };
  placeholder: string;
  options: Array<[string, string]>;
}) {
  const all: Array<[string, string]> = [
    ["", query.isPending ? "Loading…" : query.isError ? `Could not load ${label.toLowerCase()}s` : placeholder],
    ...(value && !options.some(([v]) => v === value) ? ([[value, value]] as Array<[string, string]>) : []),
    ...options,
  ];
  return <PillSelect label={label} value={value ?? ""} onChange={(v) => onChange(v || undefined)} options={all} disabled={query.isPending || query.isError} />;
}

/** Page layout: collapsible conversation rail + centered conversation column with a pinned composer. */
function ChatFrame({
  rail,
  railOpen,
  onToggleRail,
  context,
  headerAside,
  composer,
  children,
}: {
  rail: ReactNode;
  railOpen: boolean;
  onToggleRail: () => void;
  context: ReactNode;
  headerAside?: ReactNode;
  composer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`grid min-h-[calc(100dvh-7.5rem)] gap-4 ${railOpen ? "lg:grid-cols-[232px_minmax(0,1fr)]" : ""}`}>
      {railOpen ? (
        <nav aria-label="Conversations" className="flex min-h-0 flex-col gap-1 border-line lg:sticky lg:top-0 lg:max-h-[calc(100dvh-7.5rem)] lg:overflow-y-auto lg:border-r lg:pr-3">
          {rail}
        </nav>
      ) : null}
      <div className="flex min-w-0 flex-col">
        <header className="mx-auto flex w-full max-w-[760px] items-center gap-2 pb-3">
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            onClick={onToggleRail}
            aria-expanded={railOpen}
            aria-label={railOpen ? "Hide conversations" : "Show conversations"}
            title={railOpen ? "Hide conversations" : "Show conversations"}
          >
            <Icon name={railOpen ? "chevronLeft" : "chevronRight"} size={14} />
          </button>
          <h1 className="text-[14px] font-semibold text-fg-0">Ask Witness</h1>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px]">{context}</div>
          {headerAside}
          <StatusPill kind="inferred">AI · advisory</StatusPill>
        </header>
        <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col">{children}</div>
        <div className="sticky bottom-0 z-10 mx-auto w-full max-w-[760px] bg-gradient-to-t from-surface-0 from-70% to-transparent pt-4 pb-1">
          {composer}
          <p className="mt-1.5 text-center text-[11px] text-fg-2">{AI_FOOTNOTE}</p>
        </div>
      </div>
    </div>
  );
}

function Conversation({
  source,
  selected,
  onSelect,
  scopeControls,
  context,
  railOpen,
  onToggleRail,
}: {
  source: ConversationSource;
  selected: string | null;
  onSelect: (id: string | undefined) => void;
  scopeControls: ReactNode;
  context: ReactNode;
  railOpen: boolean;
  onToggleRail: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: source.listKey, queryFn: source.list, ...ONCE });
  const items = useMemo(() => [...(list.data ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [list.data]);
  const latest = items.find((i) => i.turn_count > 0)?.id ?? items[0]?.id ?? null;
  const investigationId = selected === "new" ? null : (selected ?? latest);
  const detail = useQuery({
    queryKey: source.detailKey(investigationId ?? ""),
    queryFn: () => source.detail(investigationId!),
    enabled: investigationId !== null,
    ...ONCE,
  });

  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [extraIndex, setExtraIndex] = useState<ScopedEvidenceRef[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const askedHere = useRef(false);

  const ask = useMutation({
    mutationFn: (p: Pending) => source.ask(p),
    onSuccess: async (res) => {
      setExtraIndex((prev) => [...prev, ...res.index]);
      onSelect(res.investigationId);
      await Promise.all([
        qc.invalidateQueries({ queryKey: source.detailKey(res.investigationId) }),
        qc.invalidateQueries({ queryKey: source.listKey }),
        ...(source.alsoInvalidate?.(res.investigationId) ?? []).map((k) => qc.invalidateQueries({ queryKey: k })),
      ]);
      setPending(null);
    },
  });

  const submit = (question: string, mode?: FollowUpMode) => {
    const q = question.trim();
    if (!q || ask.isPending) return;
    const p: Pending = { question: q, clientRequestId: newClientRequestId(), investigationId, ...(mode ? { mode } : {}) };
    askedHere.current = true;
    setPending(p);
    setInput("");
    ask.mutate(p);
  };

  /** Same request again: reuse the idempotency key unless the server reported a key conflict. */
  const retryPending = () => {
    if (!pending) return;
    const conflict = ask.error instanceof ApiRequestError && ask.error.code === "conflict";
    const p = conflict ? { ...pending, clientRequestId: newClientRequestId() } : pending;
    setPending(p);
    ask.mutate(p);
  };

  const turns = detail.data?.turns ?? [];
  useEffect(() => {
    if (askedHere.current) endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [turns.length, pending]);

  const index = useMemo(() => {
    const m = new Map<string, ScopedEvidenceRef>();
    for (const r of detail.data?.index ?? []) m.set(r.evidence_id, r);
    for (const r of extraIndex) if (!m.has(r.evidence_id)) m.set(r.evidence_id, r);
    return m;
  }, [detail.data, extraIndex]);
  const bundleIndex = useMemo(() => {
    const m = new Map<string, BundleEvidenceRef>();
    for (const [k, v] of index) m.set(k, asBundleRef(v));
    return m;
  }, [index]);
  const ev: EvidenceLookup = {
    index: bundleIndex,
    onOpen: (id) => {
      const ref = index.get(id);
      // Events, findings and evidence records open in the inspector (it links onward); other records have their own page.
      if (ref && (ref.kind === "event" || ref.kind === "finding" || ref.kind === "evidence")) return setOpenId(id);
      const href = citationHref(id, ref);
      if (href) navigate(href);
      else setOpenId(id);
    },
  };
  const createSafeguard = source.findingId
    ? () => navigate(`/findings/${encodeURIComponent(source.findingId!)}?view=full#safeguards`)
    : undefined;

  const ai = detail.data?.ai;
  const showPending = pending !== null && !turns.some((t) => t.client_request_id === pending.clientRequestId);
  const loading = list.isPending || (investigationId !== null && detail.isPending);
  const empty = !loading && !list.isError && !(investigationId && detail.isError) && turns.length === 0 && !showPending;
  const cards = source.suggestions.slice(0, 4);
  const more = [...source.suggestions.slice(4), ...source.investigatorQuestions];

  const rail = (
    <>
      <button
        type="button"
        className="btn btn-sm mb-1 w-full justify-start gap-1.5"
        aria-pressed={investigationId === null}
        onClick={() => {
          onSelect("new");
          inputRef.current?.focus();
        }}
        disabled={ask.isPending}
      >
        <span aria-hidden="true">+</span> New chat
      </button>
      {list.isPending ? (
        <SkeletonBlock lines={3} />
      ) : list.isError ? (
        <p className="px-2 text-[12px] text-fg-2">History unavailable.</p>
      ) : items.length === 0 ? (
        <p className="px-2 text-[12px] text-fg-2">None yet.</p>
      ) : (
        <ul className="space-y-0.5" aria-label="Investigation history">
          {items.map((it) => {
            const current = it.id === investigationId;
            return (
              <li key={it.id}>
                <button
                  type="button"
                  aria-current={current ? "true" : undefined}
                  disabled={ask.isPending}
                  onClick={() => onSelect(it.id)}
                  title={it.last_question ?? it.id}
                  className={`w-full rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors duration-[120ms] ${
                    current ? "bg-surface-2 text-fg-0" : "text-fg-1 hover:bg-surface-2"
                  }`}
                >
                  <span className="block truncate">{it.last_question ?? <Mono>{it.id}</Mono>}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-fg-2">
                    <span className="font-mono">{it.turn_count}</span>
                    {it.updated_at ? <Time iso={it.updated_at} /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  return (
    <ChatFrame
      rail={rail}
      railOpen={railOpen}
      onToggleRail={onToggleRail}
      context={context}
      composer={
        <ChatComposer
          inputRef={inputRef}
          value={input}
          onChange={setInput}
          onSubmit={() => submit(input)}
          label={source.inputLabel}
          placeholder={investigationId ? "Ask a follow-up…" : `Ask about ${source.noun}…`}
          sending={ask.isPending}
          leading={scopeControls}
        />
      }
    >
      <div className="flex flex-1 flex-col gap-6 pb-4" aria-live="polite">
        {ai && !ai.available ? (
          <Notice tone="unknown" title="ai& unavailable">
            {ai.detail} Questions are still recorded, marked unanswered.
          </Notice>
        ) : null}
        {loading ? (
          <SkeletonBlock lines={4} />
        ) : list.isError ? (
          <ErrorState error={list.error} what="earlier investigations" />
        ) : investigationId && detail.isError ? (
          <div className="space-y-2">
            <ErrorState error={detail.error} what="this investigation" />
            <button type="button" className="btn btn-sm" onClick={() => onSelect("new")}>
              New chat
            </button>
          </div>
        ) : null}

        {empty ? (
          <div className="flex flex-1 flex-col justify-center gap-5 py-10">
            <h2 className="text-center text-[20px] font-semibold tracking-tight text-fg-0">What do you want to know?</h2>
            <SuggestionCards suggestions={cards} onPick={(q) => submit(q, SUGGESTION_MODE[q])} disabled={ask.isPending} />
            {more.length > 0 ? (
              <details className="text-center">
                <summary className="cursor-pointer text-[11.5px] text-fg-2 hover:text-fg-1">More questions ({more.length})</summary>
                <div className="mt-2 flex flex-wrap justify-center gap-1.5" role="group" aria-label="More suggested questions">
                  {more.map((q) => (
                    <button key={q} type="button" className="btn btn-sm" disabled={ask.isPending} onClick={() => submit(q, SUGGESTION_MODE[q])}>
                      {q}
                    </button>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}

        {turns.map((t) => (
          <TurnView key={t.id} turn={t} ev={ev} onRetry={submit} onFollowUp={submit} retrying={ask.isPending} onCreateSafeguard={createSafeguard} />
        ))}

        {showPending ? (
          <PendingTurn
            question={pending.question}
            sending={ask.isPending}
            error={ask.isError ? <AskError error={ask.error} /> : null}
            onRetry={retryPending}
            onEdit={() => {
              setInput(pending.question);
              setPending(null);
              ask.reset();
              inputRef.current?.focus();
            }}
          />
        ) : null}
        <div ref={endRef} />
      </div>
      {openId ? <EvidenceRefDrawer id={openId} evidenceRef={bundleIndex.get(openId)} onClose={() => setOpenId(null)} /> : null}
    </ChatFrame>
  );
}

/** HTTP-level failure (the question may not have been recorded). AI failures after acceptance arrive as failed turns. */
function AskError({ error }: { error: unknown }) {
  const e = error instanceof ApiRequestError ? error : null;
  if (e?.kind === "http" && (e.code === "ai_unavailable" || e.status === 503)) {
    return (
      <Notice tone="caution" title="ai& is unavailable">
        {e.message}
      </Notice>
    );
  }
  if (e?.kind === "http" && (e.code === "timeout" || e.status === 504)) {
    return (
      <Notice tone="caution" title="ai& request timed out">
        Retry returns the stored answer if it finished meanwhile.
      </Notice>
    );
  }
  return <MutationError error={error} what="Asking Witness" />;
}
