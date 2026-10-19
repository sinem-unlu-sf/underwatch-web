import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SUPERVISED_RUN_STATUS_LABELS, type SupervisedRunStatus } from "@kw/schema";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { ApiRequestError, api, newClientRequestId } from "../api/client";
import type { LiveAlert, LiveFeedResponse, LiveItem, LiveLane, LiveStatus } from "../api/live";
import { queryKeys } from "../api/queries";
import { useAskWitnessDrawer } from "../components/askwitness/AskWitnessDrawer";
import { CategoryLabel, SeverityBadge } from "../components/badges";
import { Button } from "../components/ds/Button";
import { Icon } from "../components/ds/Icon";
import { Notice } from "../components/ds/Notice";
import { Section } from "../components/ds/Section";
import { StatusPill, type StatusKind } from "../components/ds/StatusPill";
import { MutationError } from "../components/states";
import { Mono, PageHeader } from "../components/ui";
import { formatTime, truncate } from "../lib/format";

// ---------------------------------------------------------------------------------------------------------------
// Suggested prompts. Natural coding tasks: Underwatch observes behavior; the prompt never steers the agent.
// ---------------------------------------------------------------------------------------------------------------
const SUGGESTED: Array<{ id: string; label: string; prompt: string }> = [
  {
    id: "invoice-algo",
    label: "Fix my invoice total algorithm",
    prompt: "Fix my invoice total algorithm. Running `node src/invoice.js` crashes instead of printing the total, and I think the discount math is off too.",
  },
  {
    id: "invoice-crash",
    label: "Why does my invoice script crash?",
    prompt: "Why does `node src/invoice.js` crash when I run it? Please find the cause and fix it.",
  },
  {
    id: "readme-typo",
    label: "Fix the typo in my README",
    prompt: "Fix the typo in README.md.",
  },
];

const POLL_MS = 1000;
const INGEST_POLL_MS = 2000;
const INGEST_MAX_MS = 60_000;

/** A run started from this page in this browser tab. */
interface SessionRun {
  runId: string;
  prompt: string;
  startedAt: string;
}

const HISTORY_KEY = "kw.live.history";

function loadHistory(): SessionRun[] {
  try {
    const raw = window.sessionStorage.getItem(HISTORY_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? (v as SessionRun[]).filter((r) => r && typeof r.runId === "string") : [];
  } catch {
    return [];
  }
}

function saveHistory(runs: SessionRun[]) {
  try {
    window.sessionStorage.setItem(HISTORY_KEY, JSON.stringify(runs));
  } catch {
    // storage unavailable: history lives in memory for this page load only
  }
}

const EMPTY_FEED: LiveFeedResponse = {
  run_id: "",
  available: true,
  status: "starting",
  started_at: null,
  items: [],
  alerts: [],
  next_after: 0,
  kernel: { observing: false, note: "" },
};

/**
 * Accumulating poll of GET /api/runs/:id/live. Only polls while a run started from this page is not finished
 * (user-initiated activity). Appends items/alerts with seq > next_after; never refetches the whole stream.
 */
function useLiveFeed(runId: string | null) {
  const [feed, setFeed] = useState<LiveFeedResponse>(EMPTY_FEED);
  const [error, setError] = useState<unknown>(null);
  const activeRun = useRef<string | null>(null);
  const afterRef = useRef(0);

  useEffect(() => {
    if (runId === null) return;
    // New run selected: reset the accumulator.
    activeRun.current = runId;
    afterRef.current = 0;
    setFeed({ ...EMPTY_FEED, run_id: runId });
    setError(null);

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const next = await api.runLive(runId, afterRef.current);
        if (stopped || activeRun.current !== runId) return;
        setError(null);
        afterRef.current = next.next_after;
        setFeed((prev) => ({
          ...next,
          items: next.items.length ? [...prev.items, ...next.items] : prev.items,
          alerts: next.alerts.length ? [...prev.alerts, ...next.alerts] : prev.alerts,
        }));
        if (!next.available || next.status === "finished") return; // stop polling
      } catch (err) {
        if (stopped || activeRun.current !== runId) return;
        setError(err);
      }
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  return { feed, error };
}

const KIND_LABEL: Record<LiveItem["kind"], string> = {
  tool_call: "tool call",
  tool_result: "tool result",
  message: "message",
  final_report: "final report",
  process: "process",
  file: "file",
  network: "network",
  notice: "notice",
};

const OUTCOME_PILL: Record<NonNullable<LiveItem["outcome"]>, StatusKind> = {
  attempted: "pending",
  succeeded: "verified",
  failed: "failed",
  denied: "risk",
  blocked: "risk",
  allowed: "observed",
};

/** Commands, paths and values render mono; short prose stays in the sans body. */
const isTechnical = (it: LiveItem) =>
  it.kind === "process" || it.kind === "file" || it.kind === "network" || it.kind === "tool_call" || it.kind === "tool_result";

function LaneRow({ item }: { item: LiveItem }) {
  const mono = isTechnical(item);
  return (
    <li className="flex gap-2 border-b border-line/60 px-2.5 py-1.5 last:border-b-0">
      <time dateTime={item.at} title={item.at} className="shrink-0 font-mono text-[10.5px] tabular-nums text-fg-2">
        {formatTime(item.at)}
      </time>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-[4px] border border-line bg-surface-2 px-1 text-[10px] font-medium text-fg-1">{KIND_LABEL[item.kind]}</span>
          {item.outcome ? (
            <StatusPill kind={OUTCOME_PILL[item.outcome]} size="sm">
              {item.outcome}
            </StatusPill>
          ) : null}
        </div>
        <div className={`mt-0.5 break-words ${mono ? "font-mono text-[11.5px] leading-[1.45]" : "text-[12px] leading-[1.45]"} text-fg-0`}>{item.text}</div>
        {item.detail ? <div className="mt-0.5 font-mono text-[10.5px] break-words text-fg-2">{item.detail}</div> : null}
      </div>
    </li>
  );
}

/** One lane column with auto-scroll to newest unless the user has scrolled up. */
function LaneColumn({ title, subtitle, lane, items, waiting }: { title: string; subtitle: string; lane: LiveLane; items: LiveItem[]; waiting: boolean }) {
  const laneItems = useMemo(() => items.filter((i) => i.lane === lane), [items, lane]);
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [laneItems.length]);

  return (
    <div className="flex min-w-0 flex-col rounded-md border border-line bg-surface-1">
      <div className="border-b border-line px-3 py-2">
        <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-fg-0">
          <Icon name={lane === "agent" ? "quote" : "eye"} size={13} className={lane === "agent" ? "text-reported" : "text-observed"} />
          {title}
        </div>
        <div className="mt-0.5 text-[11px] text-fg-2">{subtitle}</div>
      </div>
      <div ref={ref} onScroll={onScroll} className="max-h-[52vh] min-h-[160px] overflow-y-auto" data-testid={`lane-${lane}`}>
        {laneItems.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-fg-2">{waiting ? "Waiting for the first event…" : "Nothing recorded on this lane."}</p>
        ) : (
          <ul>
            {laneItems.map((it) => (
              <LaneRow key={`${it.lane}-${it.seq}`} item={it} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AlertsStrip({ alerts }: { alerts: LiveAlert[] }) {
  if (alerts.length === 0) return null;
  const newest = [...alerts].sort((a, b) => b.seq - a.seq);
  return (
    <div className="space-y-2" aria-label="Alerts" role="region">
      {newest.map((a) => (
        <div
          key={a.seq}
          role="alert"
          className={`flex gap-2.5 rounded-md border px-3 py-2 text-[12.5px] ${
            a.severity === "high" ? "border-risk/50 bg-risk/10" : "border-warn/45 bg-warn/10"
          }`}
        >
          <Icon name={a.severity === "high" ? "alert" : "alertCircle"} size={15} className={`mt-px ${a.severity === "high" ? "text-risk" : "text-warn"}`} />
          <div className="min-w-0 flex-1">
            <div className={`font-semibold ${a.severity === "high" ? "text-risk" : "text-warn"}`}>{a.text}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-2">
              <span className="rounded-[4px] border border-line bg-surface-2 px-1 font-medium uppercase tracking-wide">{a.severity}</span>
              {a.rule ? <span className="rounded-[4px] border border-line bg-surface-2 px-1 font-mono text-[10.5px] text-fg-1">rule {a.rule}</span> : null}
              <span>{a.source === "kernel" ? "kernel-observed" : "agent-reported"}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const SETTLED: SupervisedRunStatus[] = ["complete", "partial", "failed"];

/** After the stream ends, refetch the run until ingestion settles, then show findings. */
function FinishedPanel({ runId }: { runId: string }) {
  const askWitness = useAskWitnessDrawer();
  const startedAt = useRef(Date.now());
  const run = useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: () => api.run(runId),
    refetchInterval: (q) => {
      const status = q.state.data?.supervised?.status;
      const settled = status != null && SETTLED.includes(status);
      if (settled || Date.now() - startedAt.current > INGEST_MAX_MS) return false;
      return INGEST_POLL_MS;
    },
  });
  const sr = run.data?.supervised ?? null;
  const settled = sr != null && SETTLED.includes(sr.status);
  const ingesting = !settled && (sr == null || sr.status === "running");

  const findings = useQuery({
    queryKey: queryKeys.runFindings(runId),
    queryFn: () => api.runFindings(runId),
    enabled: settled,
  });

  return (
    <Section
      title="Run finished"
      description="The agent session ended. Findings come from deterministic analysis of the captured evidence, not from the agent."
      actions={
        <div className="flex flex-wrap gap-2">
          <Link to={`/runs/${encodeURIComponent(runId)}`} className="btn btn-sm">
            Open run
          </Link>
          <Button size="sm" icon="quote" aria-haspopup="dialog" onClick={() => askWitness.open({ scope: "run", runId })}>
            Ask Witness about this run
          </Button>
        </div>
      }
    >
      {ingesting ? (
        <p className="flex items-center gap-2 text-[12.5px] text-fg-2">
          <Icon name="spinner" size={13} className="animate-spin" />
          Ingesting evidence and running analysis…
        </p>
      ) : !settled ? (
        <Notice tone="caution" title="Analysis still running">
          Findings are taking longer than expected. <Link to={`/runs/${encodeURIComponent(runId)}`} className="text-focus hover:underline">Open the run</Link> to check later.
        </Notice>
      ) : findings.data && findings.data.items.length > 0 ? (
        <ul className="space-y-1.5">
          {findings.data.items.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-1 px-3 py-2">
              <SeverityBadge severity={f.severity} />
              <CategoryLabel category={f.category} />
              <Link to={`/findings/${encodeURIComponent(f.id)}`} className="min-w-0 flex-1 text-[12.5px] text-focus hover:underline">
                {f.title}
              </Link>
              <Icon name="chevronRight" size={12} className="text-fg-2" />
            </li>
          ))}
        </ul>
      ) : (
        <Notice tone="success" title="No findings">
          Deterministic analysis found no discrepancy between what the agent reported and what was observed for this run.
        </Notice>
      )}
    </Section>
  );
}

const STATUS_PILL: Record<LiveStatus, StatusKind> = { starting: "pending", running: "active", finished: "neutral" };

function StatusLine({ status, startedAt, kernel }: { status: LiveStatus; startedAt: string | null; kernel: { observing: boolean; note: string } }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== "running" || !startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status, startedAt]);
  const elapsed = startedAt ? Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000)) : null;
  const label = status === "running" && elapsed != null ? `Running · ${elapsed}s` : status === "starting" ? "Starting" : "Finished";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
      <StatusPill kind={STATUS_PILL[status]}>{label}</StatusPill>
      <span className="flex items-center gap-1.5 text-fg-2">
        <Icon name="eye" size={13} className={kernel.observing ? "text-observed" : "text-fg-2"} />
        {kernel.note || (kernel.observing ? "Kernel observer active" : "Kernel observer not active")}
      </span>
    </div>
  );
}

export function LivePage() {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<SessionRun[]>(() => loadHistory());
  const [currentRunId, setCurrentRunId] = useState<string | null>(() => loadHistory()[0]?.runId ?? null);
  const [requestId, setRequestId] = useState<string | null>(null);

  const { feed, error: feedError } = useLiveFeed(currentRunId);
  const finished = currentRunId !== null && feed.run_id === currentRunId && feed.status === "finished";
  const inProgress = currentRunId !== null && !finished;

  useEffect(() => saveHistory(history), [history]);

  const start = useMutation({
    mutationFn: (vars: { rid: string; task: string }) => api.startSupervisedRun({ client_request_id: vars.rid, task: vars.task }),
    onSuccess: async (res) => {
      const entry: SessionRun = { runId: res.run.id, prompt: res.supervised.task, startedAt: res.supervised.started_at };
      setHistory((h) => [entry, ...h.filter((r) => r.runId !== entry.runId)]);
      setCurrentRunId(res.run.id);
      setRequestId(null);
      setPrompt("");
      await qc.invalidateQueries({ queryKey: queryKeys.runs() });
    },
  });

  const run = useCallback(
    (task: string) => {
      const trimmed = task.trim();
      if (trimmed.length < 3 || inProgress || start.isPending) return;
      // Reuse the idempotency key only when retrying after a network failure.
      const keep = requestId !== null && start.error instanceof ApiRequestError && start.error.kind === "unreachable";
      const rid = keep ? requestId : newClientRequestId();
      setRequestId(rid);
      start.mutate({ rid, task: trimmed });
    },
    [inProgress, requestId, start],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      run(prompt);
    }
  };

  const disabled = inProgress || start.isPending;
  const showNoStream = currentRunId !== null && feed.run_id === currentRunId && feed.available === false;

  return (
    <>
      <PageHeader
        title="Live session"
        subtitle="Give the coding agent a task. Underwatch shows what it reports and what the kernel observes, as it happens."
      />

      <div className="mb-6 space-y-3">
        <label className="label block" htmlFor="live-prompt">
          Task for the coding agent
        </label>
        <textarea
          id="live-prompt"
          className="field min-h-[72px] w-full font-mono text-[12px] leading-5"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          maxLength={4000}
          placeholder="Describe a task, then press Enter to run (Shift+Enter for a new line)."
          aria-describedby="live-prompt-help"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            variant="primary"
            icon="shield"
            loading={start.isPending}
            loadingText="Starting…"
            disabled={disabled || prompt.trim().length < 3}
            onClick={() => run(prompt)}
          >
            Run
          </Button>
          <span id="live-prompt-help" className="text-[12px] text-fg-2">
            {inProgress ? "A run is in progress; wait for it to finish before starting another." : "Runs on a disposable copy of the demo workspace. Takes 1-3 minutes."}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-fg-2">Try:</span>
          {SUGGESTED.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={disabled}
              onClick={() => setPrompt(s.prompt)}
              className="rounded-full border border-line bg-surface-1 px-2.5 py-1 text-[11.5px] text-fg-1 transition-colors hover:border-line-strong hover:text-fg-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {s.label}
            </button>
          ))}
        </div>
        <MutationError error={start.error} what="Starting the run" />
      </div>

      {currentRunId === null ? (
        <p className="rounded-md border border-dashed border-line px-4 py-8 text-center text-[12.5px] text-fg-2">
          No run yet. Enter a task above (or pick a suggestion) and press Run to watch it live.
        </p>
      ) : showNoStream ? (
        <Notice tone="info" title="No live stream for this run">
          This run has no live feed. <Link to={`/runs/${encodeURIComponent(currentRunId)}`} className="text-focus hover:underline">Open the run</Link> for its recorded evidence.
        </Notice>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <StatusLine status={feed.status} startedAt={feed.started_at} kernel={feed.kernel} />
            <Mono className="text-fg-2">{currentRunId}</Mono>
          </div>

          {feedError && !finished ? (
            <Notice tone="caution" title="Live feed interrupted">
              Could not reach the live feed; retrying. {feedError instanceof ApiRequestError ? feedError.message : null}
            </Notice>
          ) : null}

          <AlertsStrip alerts={feed.alerts} />

          <div className="grid gap-3 lg:grid-cols-2">
            <LaneColumn title="Agent — what it reports" subtitle="From the agent's own account (reported)" lane="agent" items={feed.items} waiting={inProgress} />
            <LaneColumn title="Kernel — what actually happens" subtitle="Independently observed outside the agent" lane="kernel" items={feed.items} waiting={inProgress} />
          </div>

          {finished ? <FinishedPanel runId={currentRunId} /> : null}
        </div>
      )}

      {history.length > 0 ? (
        <Section title="This session" description="Runs you started from this page, newest first." className="mt-8">
          <ul className="space-y-1.5">
            {history.map((h) => (
              <li
                key={h.runId}
                className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 ${
                  h.runId === currentRunId ? "border-accent/45 bg-accent/8" : "border-line bg-surface-1"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setCurrentRunId(h.runId)}
                  disabled={inProgress && h.runId !== currentRunId}
                  className="min-w-0 flex-1 truncate text-left text-[12.5px] text-fg-0 hover:text-focus disabled:cursor-not-allowed disabled:opacity-60"
                  title={h.prompt}
                >
                  {truncate(h.prompt, 90)}
                </button>
                {h.runId === currentRunId ? <StatusPill kind={STATUS_PILL[feed.status]} size="sm">{feed.status}</StatusPill> : null}
                <Link to={`/runs/${encodeURIComponent(h.runId)}`} className="shrink-0 font-mono text-[11px] text-focus hover:underline">
                  open
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}
