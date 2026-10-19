import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 * Addendum C section 3: two levels of detail on the finding page. Changing the level is presentation only; it never
 * touches monitoring, capture or enforcement, and both levels render the SAME finding detail response.
 *
 * Resolution order: ?view=full|summary (or quick) in the URL (linkable) -> per-browser preference -> "summary".
 */
export type FindingView = "summary" | "full";
export const FINDING_VIEW_STORAGE_KEY = "kw.findingView";

function readPref(): FindingView | null {
  try {
    const v = window.localStorage.getItem(FINDING_VIEW_STORAGE_KEY);
    return v === "full" || v === "summary" ? v : null;
  } catch {
    return null;
  }
}

function writePref(v: FindingView) {
  try {
    window.localStorage.setItem(FINDING_VIEW_STORAGE_KEY, v);
  } catch {
    // Storage unavailable (private window, blocked site data): the URL param still carries the choice.
  }
}

export function useFindingView(): [FindingView, (v: FindingView) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get("view");
  // "quick" is accepted as an alias of "summary" (the switch reads "Quick Read").
  const view: FindingView = raw === "full" || raw === "summary" ? raw : raw === "quick" ? "summary" : (readPref() ?? "summary");
  const setView = useCallback(
    (v: FindingView) => {
      writePref(v);
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("view", v);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return [view, setView];
}
