import { DEFAULT_FINDINGS_VIEW_MODE, FINDINGS_VIEW_MODE_STORAGE_KEY, FindingsViewMode, isValidTimeZone, zonedDate } from "@kw/schema";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";

/** Per-browser convenience storage. Every access is guarded: storage can be unavailable or throw. */
export const LAST_TASK_STORAGE_KEY = "kw.findings.lastTask";
export const PREVIOUS_TASK_STORAGE_KEY = "kw.findings.previousTask";

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Preference not persisted; the URL still carries the state.
  }
}

export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimeZone(tz) ? tz : "UTC";
  } catch {
    return "UTC";
  }
}

export const todayIn = (tz: string): string => zonedDate(new Date(), tz);

/**
 * Mode resolution: ?mode= (the URL is the state) -> legacy deep links (?status= => Current State filter,
 * ?run_id= => By Task for that run) -> localStorage preference -> By Task.
 */
export function resolveMode(params: URLSearchParams): FindingsViewMode {
  const fromUrl = FindingsViewMode.safeParse(params.get("mode"));
  if (fromUrl.success) return fromUrl.data;
  if (params.has("run_id")) return "task";
  if (params.has("status") || params.has("severity") || params.has("category")) return "current";
  const stored = FindingsViewMode.safeParse(readStorage(FINDINGS_VIEW_MODE_STORAGE_KEY));
  return stored.success ? stored.data : DEFAULT_FINDINGS_VIEW_MODE;
}

export function useFindingsMode() {
  const [params, setParams] = useSearchParams();
  const mode = useMemo(() => resolveMode(params), [params]);

  /** Patch URL params (undefined removes). Pushes history so Back returns to the previous view. */
  const patch = useCallback(
    (values: Record<string, string | undefined>, opts?: { replace?: boolean }) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(values)) {
            if (v === undefined || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: opts?.replace ?? false },
      );
    },
    [setParams],
  );

  const setMode = useCallback(
    (next: FindingsViewMode) => {
      writeStorage(FINDINGS_VIEW_MODE_STORAGE_KEY, next);
      const values: Record<string, string | undefined> = { mode: next };
      if (next === "digest") {
        // Switching to the digest selects a day: keep the one in the URL, else today in the browser's time zone.
        const tz = params.get("tz");
        const zone = tz && isValidTimeZone(tz) ? tz : browserTimeZone();
        values.tz = zone;
        if (!params.get("date")) values.date = todayIn(zone);
      }
      if (next === "task" && !params.get("task")) {
        const last = readStorage(LAST_TASK_STORAGE_KEY);
        if (last) values.task = last;
      }
      patch(values);
    },
    [params, patch],
  );

  return { mode, setMode, params, patch };
}

/** Href of the current findings view, passed to the finding page as ?from= so it can link back. */
export function useFindingsReturnHref(): string {
  const [params] = useSearchParams();
  const sp = new URLSearchParams(params);
  if (!sp.has("mode")) sp.set("mode", resolveMode(params));
  return `/findings?${sp.toString()}`;
}

export function findingHref(findingId: string, from: string): string {
  return `/findings/${encodeURIComponent(findingId)}?from=${encodeURIComponent(from)}`;
}
