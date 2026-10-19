import type { FindingStatus } from "./enums";

/**
 * Allowed finding status transitions, shared by server (enforcement) and UI (which buttons to show).
 * Nothing is ever deleted: dismissed and resolved findings can be reopened to under_review, keeping history.
 */
export const FINDING_STATUS_TRANSITIONS: Readonly<Record<FindingStatus, readonly FindingStatus[]>> = {
  new: ["under_review", "confirmed", "dismissed", "unresolved"],
  under_review: ["confirmed", "dismissed", "unresolved"],
  confirmed: ["resolved", "under_review"],
  unresolved: ["under_review", "confirmed", "dismissed"],
  resolved: ["under_review"],
  dismissed: ["under_review"],
};

/** Transitions into these statuses require a non-empty note explaining the decision. */
export const FINDING_STATUS_NOTE_REQUIRED: readonly FindingStatus[] = ["dismissed", "resolved"];

export function allowedFindingTransitions(from: FindingStatus): readonly FindingStatus[] {
  return FINDING_STATUS_TRANSITIONS[from];
}

export function canTransitionFinding(from: FindingStatus, to: FindingStatus): boolean {
  return FINDING_STATUS_TRANSITIONS[from].includes(to);
}

export type FindingTransitionCheck =
  | { ok: true }
  | { ok: false; code: "invalid_transition" | "note_required"; message: string };

export function checkFindingTransition(from: FindingStatus, to: FindingStatus, note: string | null | undefined): FindingTransitionCheck {
  if (!canTransitionFinding(from, to)) {
    return { ok: false, code: "invalid_transition", message: `Cannot change finding status from "${from}" to "${to}".` };
  }
  if (FINDING_STATUS_NOTE_REQUIRED.includes(to) && !note?.trim()) {
    return { ok: false, code: "note_required", message: `A note is required when marking a finding "${to}".` };
  }
  return { ok: true };
}
