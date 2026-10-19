import type { FindingDetailResponse, InvestigationTurn } from "@kw/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useMatch, useNavigate } from "react-router";
import { ApiRequestError, newClientRequestId } from "../../api/client";
import { queryKeys } from "../../api/queries";
import { asBundleRef, citationHref, scopedApi, scopeKey, type AskScope, type ScopedAskBody, type ScopedEvidenceRef } from "../../api/scopedAsk";
import { MutationError, SkeletonBlock } from "../states";
import { TurnView, type EvidenceLookup, type FollowUpMode } from "./AnswerView";
import { AI_FOOTNOTE, ChatComposer, PendingTurn, SuggestionCards } from "./ChatParts";
import { EvidenceRefDrawer } from "./EvidenceRef";

/**
 * Global Ask Witness drawer (Addendum A, run + workspace scopes; Addendum B calm UI). It opens ONLY when the user
 * clicks an "Ask Witness" control, closes with Esc / Close, never opens by itself, never polls and never refetches in
 * the background. It is not a general chatbot: the server answers from a small, capped, redacted bundle of Kernel
 * Witness's own records for the chosen scope and validates every citation; this view renders the validated turn.
 */

export type ScopeChoice = "finding" | "run" | "workspace";

export const SCOPE_SUGGESTIONS: Record<"run" | "workspace", readonly string[]> = {
  run: [
    "What did the agent do in this run?",
    "What was blocked and what succeeded?",
    "Where does the agent's report disagree with observed activity?",
    "What telemetry is missing?",
  ],
  workspace: [
    "What needs my attention?",
    "What was blocked today?",
    "Which findings are still uncertain?",
    "Which safeguards are verified and which failed?",
  ],
};

const SCOPE_LABEL: Record<ScopeChoice, string> = { finding: "This finding", run: "This run", workspace: "All findings" };

interface Conversation {
  investigationId: string | null;
  turns: InvestigationTurn[];
  index: Map<string, ScopedEvidenceRef>;
  /** True once turns were loaded (or started) in this tab; prevents re-fetching. */
  loaded: boolean;
  /** True once the scope's earlier investigations were looked up (at most once per tab). */
  listed: boolean;
}

interface Pending {
  key: string;
  scope: AskScope;
  question: string;
  clientRequestId: string;
  investigationId: string | null;
  /** Addendum C: omitted = concise / standard. */
  mode?: FollowUpMode;
}

export interface OpenOptions {
  scope?: "run" | "workspace";
  runId?: string;
}

interface DrawerApi {
  isOpen: boolean;
  open: (opts?: OpenOptions) => void;
  close: () => void;
}

const DrawerContext = createContext<DrawerApi | null>(null);

/** Safe no-op outside the provider (isolated component tests). */
export function useAskWitnessDrawer(): DrawerApi {
  return useContext(DrawerContext) ?? { isOpen: false, open: () => {}, close: () => {} };
}

const STORAGE_KEY = "kw.askwitness.scoped";

function loadIds(): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveIds(ids: Record<string, string>) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // storage unavailable: history then lives only in memory for this tab
  }
}

/** Page context from the URL (no fetch): run page -> run id; finding page -> finding id (+ its run if already cached). */
function usePageContext() {
  const runMatch = useMatch("/runs/:id");
  const findingMatch = useMatch("/findings/:id");
  const qc = useQueryClient();
  const findingId = findingMatch?.params.id ?? null;
  const cached = findingId ? qc.getQueryData<FindingDetailResponse>(queryKeys.finding(findingId)) : undefined;
  return {
    runId: runMatch?.params.id ?? null,
    findingId,
    findingRunId: cached?.finding?.run_id ?? null,
  };
}

export function AskWitnessDrawerProvider({ children }: { children: ReactNode }) {
  const ctx = usePageContext();
  const [isOpen, setOpen] = useState(false);
  const [choice, setChoice] = useState<ScopeChoice>("workspace");
  const [runId, setRunId] = useState<string | null>(null);
  const [findingId, setFindingId] = useState<string | null>(null);

  const open = useCallback(
    (opts?: OpenOptions) => {
      const rid = opts?.runId ?? ctx.runId ?? ctx.findingRunId;
      setRunId(rid);
      setFindingId(ctx.findingId);
      if (opts?.scope === "run" && rid) setChoice("run");
      else if (opts?.scope === "workspace") setChoice("workspace");
      else if (ctx.runId) setChoice("run");
      else if (ctx.findingId) setChoice("finding");
      else setChoice("workspace");
      setOpen(true);
    },
    [ctx.runId, ctx.findingId, ctx.findingRunId],
  );
  const close = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ isOpen, open, close }), [isOpen, open, close]);

  return (
    <DrawerContext.Provider value={value}>
      {children}
      {isOpen ? <AskWitnessDrawer choice={choice} onChoice={setChoice} runId={runId} findingId={findingId} onClose={close} /> : null}
    </DrawerContext.Provider>
  );
}

/** Top-bar entry. Plain button: no badge, counter or unread marker. */
export function AskWitnessLauncher() {
  const { open, isOpen } = useAskWitnessDrawer();
  return (
    <button type="button" className="btn" aria-haspopup="dialog" aria-expanded={isOpen} onClick={() => open()}>
      Ask Witness
    </button>
  );
}

/** Persisted across open/close within the tab (module-level so the provider remount does not drop history). */
const conversations = new Map<string, Conversation>();
const emptyConversation = (investigationId: string | null): Conversation => ({
  investigationId,
  turns: [],
  index: new Map(),
  loaded: investigationId === null,
  listed: investigationId !== null,
});

const ONCE = { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

/** Test hook: forget in-memory conversations. */
export function resetAskWitnessConversations() {
  conversations.clear();
}

function AskWitnessDrawer({
  choice,
  onChoice,
  runId,
  findingId,
  onClose,
}: {
  choice: ScopeChoice;
  onChoice: (c: ScopeChoice) => void;
  runId: string | null;
  findingId: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [openId, setOpenId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scope: AskScope | null = choice === "run" && runId ? { kind: "run", runId } : choice === "workspace" ? { kind: "workspace" } : null;
  const key = scope ? scopeKey(scope) : null;

  // Bump to re-render after mutating the module-level conversation map.
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const conv: Conversation | null = key
    ? (conversations.get(key) ??
      (() => {
        const c = emptyConversation(loadIds()[key] ?? null);
        conversations.set(key, c);
        return c;
      })())
    : null;

  // At most one lookup of this scope's earlier investigations, then one fetch of the latest. Never refetched or polled.
  const earlier = useQuery({
    queryKey: ["scopedInvestigations", key ?? ""],
    queryFn: () => scopedApi.list(scope!),
    enabled: !!scope && !!conv && !conv.listed && conv.investigationId === null,
    ...ONCE,
  });
  useEffect(() => {
    if (!key || !(earlier.data || earlier.isError)) return;
    const c = conversations.get(key);
    if (!c || c.listed) return;
    c.listed = true;
    const latest = (earlier.data ?? []).filter((i) => i.turn_count > 0).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (latest && c.investigationId === null) {
      c.investigationId = latest.id;
      c.loaded = false;
    }
    bump();
  }, [key, earlier.data, earlier.isError]);

  const restore = useQuery({
    queryKey: ["scopedInvestigation", conv?.investigationId ?? ""],
    queryFn: () => scopedApi.detail(conv!.investigationId!),
    enabled: !!conv && !!conv.investigationId && !conv.loaded,
    ...ONCE,
  });
  useEffect(() => {
    if (!key || !restore.data) return;
    const c = conversations.get(key);
    if (!c || c.loaded) return;
    c.turns = restore.data.turns;
    for (const r of restore.data.evidence_index) c.index.set(r.evidence_id, r);
    c.loaded = true;
    bump();
  }, [key, restore.data]);

  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useMutation({
    mutationFn: (p: Pending) => {
      // Addendum C: depth/style are additive body fields (omitted = concise / standard).
      const body: ScopedAskBody & FollowUpMode = {
        question: p.question,
        client_request_id: p.clientRequestId,
        ...(p.investigationId ? { investigation_id: p.investigationId } : {}),
        ...(p.mode?.depth && p.mode.depth !== "concise" ? { depth: p.mode.depth } : {}),
        ...(p.mode?.style && p.mode.style !== "standard" ? { style: p.mode.style } : {}),
      };
      return scopedApi.ask(p.scope, body);
    },
    onSuccess: (res, p) => {
      const c = conversations.get(p.key) ?? emptyConversation(null);
      c.investigationId = res.investigation.id;
      c.loaded = true;
      c.listed = true;
      if (!c.turns.some((t) => t.id === res.turn.id)) c.turns = [...c.turns, res.turn];
      for (const r of res.evidence_index) c.index.set(r.evidence_id, r);
      conversations.set(p.key, c);
      saveIds({ ...loadIds(), [p.key]: res.investigation.id });
      setPending(null);
      bump();
    },
  });

  const submit = (question: string, mode?: FollowUpMode) => {
    const q = question.trim();
    if (!q || !scope || !key || ask.isPending) return;
    const p: Pending = { key, scope, question: q, clientRequestId: newClientRequestId(), investigationId: conv?.investigationId ?? null, ...(mode ? { mode } : {}) };
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


  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openId === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, openId]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [choice]);

  const index = conv?.index ?? new Map<string, ScopedEvidenceRef>();
  const bundleIndex = new Map<string, ReturnType<typeof asBundleRef>>();
  for (const [k, v] of index) bundleIndex.set(k, asBundleRef(v));
  const ev: EvidenceLookup = {
    index: bundleIndex,
    onOpen: (id) => {
      const href = citationHref(id, index.get(id));
      if (href) navigate(href);
      else setOpenId(id);
    },
  };

  const showPending = pending && pending.key === key;
  const loadingHistory = (restore.isPending && restore.fetchStatus !== "idle") || earlier.fetchStatus === "fetching";
  const turns = conv?.turns ?? [];
  const suggestions = scope ? SCOPE_SUGGESTIONS[scope.kind] : [];
  const choices: ScopeChoice[] = [...(findingId ? (["finding"] as const) : []), ...(runId ? (["run"] as const) : []), "workspace"];
  const lastFailedAi = restore.data?.ai && !restore.data.ai.available ? restore.data.ai.detail : null;

  return (
    <>
      <aside
        role="dialog"
        aria-modal="false"
        aria-label="Ask Witness"
        className="fixed inset-y-0 right-0 z-30 flex w-[min(520px,100vw)] flex-col border-l border-line-strong bg-surface-1 shadow-[-8px_0_24px_rgba(0,0,0,0.18)]"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <h2 className="text-[12px] font-semibold tracking-wide text-fg-1 uppercase">Ask Witness</h2>
          <span className="text-[11px] text-fg-2">ai& · advisory</span>
          <button type="button" className="btn ml-auto" onClick={onClose}>
            Close <span className="text-fg-2">Esc</span>
          </button>
        </div>

        <div className="border-b border-line px-3 py-2">
          <div role="radiogroup" aria-label="Scope" className="inline-flex overflow-hidden rounded-[3px] border border-line-strong">
            {choices.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={choice === c}
                onClick={() => onChoice(c)}
                className={`px-2 py-0.5 text-[12px] ${choice === c ? "bg-fg-0 font-medium text-surface-0" : "bg-surface-2 text-fg-1 hover:bg-surface-3"}`}
              >
                {SCOPE_LABEL[c]}
              </button>
            ))}
          </div>
        </div>

        {choice === "finding" && findingId ? (
          <div className="space-y-2 p-3 text-[12.5px] text-fg-1">
            <p>Ask about one finding from its page.</p>
            <Link to={`/findings/${encodeURIComponent(findingId)}#ask-witness`} className="btn"
              onClick={() => {
                onClose();
                // Same page: react-router does not scroll to a hash, so bring the in-page panel into view.
                window.requestAnimationFrame(() => {
                  const panel = document.getElementById("ask-witness");
                  panel?.scrollIntoView?.({ block: "start" });
                  panel?.querySelector<HTMLElement>("textarea[aria-label], input[aria-label]")?.focus();
                });
              }}
            >
              Go to this finding's Ask Witness panel
            </Link>
            <p className="text-[11px] text-fg-2">Or switch scope above.</p>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-5 overflow-auto p-3" aria-live="polite">
              {lastFailedAi ? (
                <div role="status" className="hatch rounded-md px-2 py-1.5 text-[12px] text-unknown">
                  ai& unavailable: {lastFailedAi} Questions are still recorded, marked unanswered.
                </div>
              ) : null}
              {loadingHistory ? <SkeletonBlock lines={4} /> : null}
              {restore.isError && conv && !conv.loaded ? (
                <div className="space-y-1.5">
                  <MutationError error={restore.error} what="Loading the earlier conversation" />
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      conv.investigationId = null;
                      conv.loaded = true;
                      conv.listed = true;
                      if (key) {
                        const ids = loadIds();
                        delete ids[key];
                        saveIds(ids);
                      }
                      bump();
                    }}
                  >
                    Start a new conversation
                  </button>
                </div>
              ) : null}
              {turns.length === 0 && !showPending && !loadingHistory ? (
                <div className="space-y-3 py-4">
                  <h3 className="text-center text-[15px] font-semibold text-fg-0">What do you want to know?</h3>
                  <SuggestionCards suggestions={suggestions} onPick={(q) => submit(q)} disabled={ask.isPending} />
                </div>
              ) : null}

              {turns.map((t) => (
                <TurnView key={t.id} turn={t} ev={ev} onRetry={submit} onFollowUp={submit} retrying={ask.isPending} />
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
                  }}
                />
              ) : null}
            </div>

            <div className="border-t border-line p-3">
              <ChatComposer
                inputRef={inputRef}
                value={input}
                onChange={setInput}
                onSubmit={() => submit(input)}
                label={scope?.kind === "run" ? "Ask a question about this run" : "Ask a question about all findings"}
                placeholder={conv?.investigationId ? "Ask a follow-up…" : scope?.kind === "run" ? "Ask about this run…" : "Ask about your findings…"}
                sending={ask.isPending}
              />
              <p className="mt-1.5 text-center text-[11px] text-fg-2">{AI_FOOTNOTE}</p>
            </div>
          </>
        )}
      </aside>
      {openId ? <EvidenceRefDrawer id={openId} evidenceRef={bundleIndex.get(openId)} onClose={() => setOpenId(null)} /> : null}
    </>
  );
}

/** HTTP-level failure (the question may not have been recorded). AI failures after acceptance arrive as failed turns. */
function AskError({ error }: { error: unknown }) {
  const e = error instanceof ApiRequestError ? error : null;
  if (e?.kind === "http" && (e.code === "ai_unavailable" || e.status === 503)) {
    return (
      <div role="alert" className="rounded-[3px] border border-warn/50 bg-warn/10 p-2 text-[12px] text-fg-1">
        <span className="font-medium text-warn">ai& is unavailable. </span>
        {e.message} The records are unchanged; the rest of Underwatch works without ai&.
      </div>
    );
  }
  if (e?.kind === "http" && (e.code === "timeout" || e.status === 504)) {
    return (
      <div role="alert" className="rounded-[3px] border border-warn/50 bg-warn/10 p-2 text-[12px] text-fg-1">
        <span className="font-medium text-warn">ai& request timed out. </span>
        Retrying sends the same request id, so the server returns the stored answer if it finished meanwhile.
      </div>
    );
  }
  return <MutationError error={error} what="Asking Witness" />;
}
