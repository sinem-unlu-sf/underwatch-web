import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FixtureBadge } from "../badges";
import { AskWitnessPanel, type AskWitnessFinding } from "./AskWitnessPanel";

/**
 * Contextual chatbot (Addendum C section 4): "Ask about this issue" opens this small side panel holding the existing
 * per-finding Ask Witness. It is non-modal: the finding stays visible and usable beside it. Closing only hides it; the
 * panel stays mounted after the first open, so a typed question, an in-flight answer and the selected investigation
 * survive close / reopen. Nothing opens it automatically.
 */
export function AskAboutIssuePanel({
  open,
  onClose,
  finding,
  onCreateSafeguard,
  header,
}: {
  open: boolean;
  onClose: () => void;
  finding: AskWitnessFinding;
  onCreateSafeguard: (investigationId: string | null) => void;
  /** Optional content above the chat (the Overview shows the finding's short read here). */
  header?: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  useEffect(() => {
    if (open) headingRef.current?.focus();
  }, [open, mounted]);
  // Esc fallback: asking a suggested question unmounts the clicked chip, so focus drops to <body> and the panel's own
  // onKeyDown never sees the key. Only acts when focus is nowhere in particular, so other dialogs keep their own Esc.
  useEffect(() => {
    if (!open) return;
    const onWinKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const a = document.activeElement;
      if (a && a !== document.body) return;
      if (document.querySelector('aside[aria-label="Evidence inspector"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onWinKey);
    return () => window.removeEventListener("keydown", onWinKey);
  }, [open, onClose]);

  if (!mounted) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // An evidence inspector opened from an answer closes first (it listens on window).
    if (document.querySelector('aside[aria-label="Evidence inspector"]')) return;
    e.stopPropagation();
    onClose();
  };

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="ask-about-issue-title"
      hidden={!open}
      onKeyDown={onKeyDown}
      className="kw-fade-in fixed inset-y-0 right-0 z-20 flex w-[min(420px,100vw)] flex-col border-l border-line-strong bg-surface-1 pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)] shadow-[var(--shadow-overlay)]"
      data-testid="ask-about-issue-panel"
    >
      <div className="flex items-start gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 ref={headingRef} id="ask-about-issue-title" tabIndex={-1} className="text-[13px] font-semibold text-fg-0 outline-none">
            Ask about this issue
          </h2>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11.5px] text-fg-2">
            <FixtureBadge isFixture={finding.is_fixture} compact />
            <span className="truncate" title={finding.title}>
              {finding.title}
            </span>
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Close Ask about this issue">
          Close <span className="text-fg-2">Esc</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {header ? <div className="mb-3">{header}</div> : null}
        <AskWitnessPanel finding={finding} onCreateSafeguard={onCreateSafeguard} compact embedded maxSuggestions={4} />
      </div>
    </aside>
  );
}
