import { SegmentedControl } from "../ds/SegmentedControl";
import type { FindingView } from "./useFindingView";

/** Labels exactly as the UI PRD names them. The URL keeps the stable values (?view=summary | ?view=full). */
export const VIEW_LABELS: Record<FindingView, string> = {
  summary: "Quick Read",
  full: "Full Technical Details",
};

const OPTIONS: Array<{ value: FindingView; label: string; description: string }> = [
  { value: "summary", label: VIEW_LABELS.summary, description: "Problem, why it matters and how to fix it, with the most relevant relationship" },
  { value: "full", label: VIEW_LABELS.full, description: "Every record: agent report, observed evidence, applicable policy and interpretation" },
];

/** Quick Read | Full Technical Details. Presentation only; both read the same records. */
export function ViewSwitch({ view, onChange }: { view: FindingView; onChange: (v: FindingView) => void }) {
  return <SegmentedControl options={OPTIONS} value={view} onChange={onChange} label="Level of detail" size="sm" />;
}
