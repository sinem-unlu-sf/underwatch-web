import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DigestRefreshResponse,
  DigestResponse,
  FindingDetailResponse,
  FindingsSnapshotResponse,
  RunDetailResponse,
  RunFindingsResponse,
  TasksResponse,
  apiPaths,
  findingsViewsPaths,
} from "@kw/schema";
import { buildQuery, requestJson } from "./client";
import { queryKeys } from "./queries";

/**
 * Findings presentation modes (PRD Addendum B). PRESENTATION ONLY: these calls read persisted findings; nothing here
 * changes event collection, finding generation, or enforcement.
 *
 * Calm-by-default query options: no background refetching of any kind. Data changes only when the user navigates to a
 * new scope (task / date) or presses Refresh. Keys start with "findingsViews" (never "findings") so that
 * invalidateAfterFindingChange() cannot silently replace a digest or Current State snapshot.
 */
export const CALM_QUERY = {
  staleTime: Infinity,
  gcTime: Infinity,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchInterval: false,
  retry: false,
} as const;

/**
 * Same as CALM_QUERY but honours invalidation on mount, so a status change the user made on the finding page shows up
 * when they come back to By Task. Never refetches on focus, reconnect, or a timer.
 */
const CALM_SHARED_QUERY = { ...CALM_QUERY, gcTime: 5 * 60_000, refetchOnMount: true } as const;

export const findingsViewsKeys = {
  all: ["findingsViews"] as const,
  tasks: ["findingsViews", "tasks"] as const,
  current: ["findingsViews", "current"] as const,
  digest: (date: string, tz: string, version: number | null) => ["findingsViews", "digest", date, tz, version] as const,
};

export const findingsViewsApi = {
  tasks: () => requestJson(findingsViewsPaths.tasks() + buildQuery({ fixture: "include" }), TasksResponse),
  snapshot: () => requestJson(findingsViewsPaths.findingsSnapshot(), FindingsSnapshotResponse),
  digest: (date: string, tz: string, version: number | null) =>
    requestJson(findingsViewsPaths.digest(date) + buildQuery({ tz, version: version ?? undefined }), DigestResponse),
  refreshDigest: (date: string, tz: string) =>
    requestJson(findingsViewsPaths.digestRefresh(date) + buildQuery({ tz }), DigestRefreshResponse, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
};

// --- By Task ---------------------------------------------------------------------------------------------------

export const useTasks = () => useQuery({ queryKey: findingsViewsKeys.tasks, queryFn: findingsViewsApi.tasks, ...CALM_QUERY });

/** Shares the existing ["run", id] / ["runFindings", id] / ["finding", id] cache entries with the rest of the app. */
export const useTaskRun = (id: string) =>
  useQuery({ queryKey: queryKeys.run(id), queryFn: () => requestJson(apiPaths.run(id), RunDetailResponse), ...CALM_SHARED_QUERY });

export const useTaskRunFindings = (id: string) =>
  useQuery({
    queryKey: queryKeys.runFindings(id),
    queryFn: () => requestJson(apiPaths.runFindings(id), RunFindingsResponse),
    ...CALM_SHARED_QUERY,
  });

export const useFindingContext = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.finding(id),
    queryFn: () => requestJson(apiPaths.finding(id), FindingDetailResponse),
    enabled,
    ...CALM_SHARED_QUERY,
  });

// --- Current State ---------------------------------------------------------------------------------------------

/** Fetches once if nothing is cached; afterwards only refetch() (the Refresh button) retrieves newer data. */
export const useCurrentSnapshot = () => useQuery({ queryKey: findingsViewsKeys.current, queryFn: findingsViewsApi.snapshot, ...CALM_QUERY });

// --- Daily Digest ----------------------------------------------------------------------------------------------

export const useDigest = (date: string, tz: string, version: number | null) =>
  useQuery({ queryKey: findingsViewsKeys.digest(date, tz, version), queryFn: () => findingsViewsApi.digest(date, tz, version), ...CALM_QUERY });

/** Explicit refresh: appends a version only if content changed; the result becomes the cached "latest" view. */
export function useRefreshDigest(date: string, tz: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => findingsViewsApi.refreshDigest(date, tz),
    onSuccess: (res) => {
      const { created: _created, ...view } = res;
      qc.setQueryData(findingsViewsKeys.digest(date, tz, null), view);
      qc.setQueryData(findingsViewsKeys.digest(date, tz, res.snapshot.version), view);
    },
  });
}
