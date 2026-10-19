import type { SnapshotFinding } from "@kw/schema";
import { OutcomeLine } from "./FindingRow";

/** Expanded body for Digest / Current State rows: shows the finding as recorded in the snapshot, with evidence refs. */
export function SnapshotFindingDetail({ finding }: { finding: SnapshotFinding }) {
  return (
    <div className="flex flex-col gap-2">
      <OutcomeLine label="Agent-reported" outcomes={finding.reported_outcomes} emptyText="No linked agent-reported event" />
      <OutcomeLine label="Independently observed" outcomes={finding.observed_outcomes} emptyText="No linked observed event (not proof nothing happened)" />
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="label w-full shrink-0 sm:w-40">Evidence</span>
        <span className="text-fg-1">
          {finding.evidence_ids.length} evidence record{finding.evidence_ids.length === 1 ? "" : "s"}, {finding.related_event_ids.length} linked event
          {finding.related_event_ids.length === 1 ? "" : "s"}
        </span>
        {finding.evidence_ids.length === 0 ? <span className="hatch rounded-[4px] px-1 text-unknown">no evidence record linked</span> : null}
      </div>
      {finding.missing_information.length > 0 ? (
        <div className="text-[12px]">
          <span className="label">Missing information</span>
          <ul className="mt-1 list-disc pl-5 text-fg-1">
            {finding.missing_information.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
