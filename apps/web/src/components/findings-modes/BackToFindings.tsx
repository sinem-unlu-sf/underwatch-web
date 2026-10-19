import { FINDINGS_VIEW_MODE_LABELS, FindingsViewMode } from "@kw/schema";
import { Link, useSearchParams } from "react-router";

/**
 * "Back to <view>" link for pages opened from the findings modes (?from=/findings?...). Only same-app /findings URLs
 * are accepted, so a crafted ?from= cannot send the user elsewhere. Renders nothing without a valid ?from=.
 */
export function BackToFindings({ className = "" }: { className?: string }) {
  const [params] = useSearchParams();
  const from = params.get("from");
  if (!from || !/^\/findings(\?[^#\s]*)?$/.test(from)) return null;
  const sp = new URLSearchParams(from.slice("/findings".length));
  const mode = FindingsViewMode.safeParse(sp.get("mode"));
  const label = !mode.success
    ? "findings"
    : mode.data === "digest" && sp.get("date")
      ? `Daily Digest ${sp.get("date")}`
      : mode.data === "task" && sp.get("task")
        ? "task"
        : FINDINGS_VIEW_MODE_LABELS[mode.data];
  return (
    <Link to={from} className={`text-[12px] text-focus hover:underline ${className}`}>
      ← Back to {label}
    </Link>
  );
}
