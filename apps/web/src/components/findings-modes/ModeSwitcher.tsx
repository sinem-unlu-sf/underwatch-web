import { FINDINGS_VIEW_MODE_LABELS, FINDINGS_VIEW_MODES, type FindingsViewMode } from "@kw/schema";
import { SegmentedControl } from "../ds/SegmentedControl";

const MODE_HINT: Record<FindingsViewMode, string> = {
  digest: "One stable summary per day. Changes only when you refresh it or open another version.",
  task: "Findings for one coding task or run, with its events, policy, and evidence.",
  current: "Latest findings as of your last refresh. Never updates on its own.",
};

/** Daily Digest | By Task | Current State. Design-system segmented control (ARIA radiogroup, arrows / Home / End). */
export function ModeSwitcher({ mode, onChange }: { mode: FindingsViewMode; onChange: (mode: FindingsViewMode) => void }) {
  return (
    <SegmentedControl
      label="Findings view"
      value={mode}
      onChange={onChange}
      options={FINDINGS_VIEW_MODES.map((m) => ({ value: m, label: FINDINGS_VIEW_MODE_LABELS[m], description: MODE_HINT[m] }))}
    />
  );
}

export const modeHint = (mode: FindingsViewMode) => MODE_HINT[mode];
