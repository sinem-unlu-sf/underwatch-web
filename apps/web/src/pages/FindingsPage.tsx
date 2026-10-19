import { CurrentStateMode } from "../components/findings-modes/CurrentStateMode";
import { DigestMode } from "../components/findings-modes/DigestMode";
import { ModeSwitcher, modeHint } from "../components/findings-modes/ModeSwitcher";
import { TaskMode } from "../components/findings-modes/TaskMode";
import { useFindingsMode } from "../components/findings-modes/useFindingsMode";

/**
 * Findings (PRD Addendum B). The mode only changes how persisted findings are organized and when this view retrieves
 * newer data; it never affects event collection, finding generation, or enforcement.
 */
export function FindingsPage() {
  const { mode, setMode } = useFindingsMode();

  return (
    <div>
      <header className="mb-5 flex flex-col gap-3 border-b border-line pb-4">
        <div className="min-w-0">
          <h1 className="text-[18px] leading-7 font-semibold tracking-[-0.01em] text-fg-0">Findings</h1>
          <p className="mt-0.5 max-w-[90ch] text-[13px] text-fg-2">
            Discrepancies between what the agent reported, what was observed, and what policy allowed.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <ModeSwitcher mode={mode} onChange={setMode} />
          <p className="min-w-0 text-[12px] text-fg-2" aria-live="polite">
            {modeHint(mode)}
          </p>
        </div>
      </header>
      {mode === "task" ? <TaskMode /> : mode === "digest" ? <DigestMode /> : <CurrentStateMode />}
    </div>
  );
}
