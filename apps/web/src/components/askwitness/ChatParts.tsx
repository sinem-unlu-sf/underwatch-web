import { useEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Icon } from "../ds/Icon";

/**
 * Shared chat building blocks for Ask Witness (full page, top-bar drawer, per-finding panel): compact user bubbles,
 * a typing indicator, an auto-growing composer (Enter sends, Shift+Enter adds a newline) and suggested-prompt cards.
 * Presentation only: every request, retry key and evidence rule stays in the caller.
 */

export const AI_FOOTNOTE = "AI interprets records; it does not decide what happened";

export function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-surface-3 px-3 py-1.5 text-[13px] leading-5 whitespace-pre-wrap text-fg-0">{children}</div>
    </div>
  );
}

export function TypingIndicator({ label = "Witness is answering" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-label={label} className="flex items-center gap-1 py-1 pl-1" data-testid="typing-indicator">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className="size-1.5 animate-pulse rounded-full bg-fg-2"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

/** Pinned composer. `leading` holds small pills (scope selector) shown under the textarea. */
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  label,
  placeholder,
  disabled = false,
  sending = false,
  leading,
  inputRef,
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  label: string;
  placeholder?: string;
  /** Composer unusable (no scope chosen). */
  disabled?: boolean;
  /** A question is in flight: typing is allowed, sending is not. */
  sending?: boolean;
  leading?: ReactNode;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  autoFocus?: boolean;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value, ref]);
  const canSend = !disabled && !sending && value.trim().length > 0;
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSubmit();
    }
  };
  const onFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (canSend) onSubmit();
  };
  return (
    <form onSubmit={onFormSubmit} className="rounded-2xl border border-line-strong bg-surface-2 px-3 pt-2 pb-2 shadow-[var(--shadow-subtle)] focus-within:border-accent/60">
      <textarea
        ref={ref}
        aria-label={label}
        rows={1}
        maxLength={2000}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="block max-h-[200px] w-full resize-none bg-transparent text-[13.5px] leading-5 text-fg-0 outline-none placeholder:text-fg-2 disabled:cursor-not-allowed"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{leading}</div>
        <button
          type="submit"
          aria-label={sending ? "Sending" : "Send"}
          title="Send (Enter)"
          disabled={!canSend}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-fg-0 text-surface-0 transition-opacity duration-[120ms] disabled:opacity-30"
        >
          {sending ? <Icon name="spinner" size={13} className="animate-spin" /> : <Icon name="chevronRight" size={14} className="-rotate-90" />}
        </button>
      </div>
    </form>
  );
}

/** Small pill-styled select used for the scope / run / finding choice inside the composer. */
export function PillSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-[min(260px,100%)] truncate rounded-full border border-line-strong bg-surface-1 px-2.5 py-0.5 text-[11.5px] text-fg-1 hover:bg-surface-3 disabled:opacity-60"
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

export function SuggestionCards({ suggestions, onPick, disabled }: { suggestions: readonly string[]; onPick: (q: string) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label="Suggested questions" className="grid gap-2 sm:grid-cols-2">
      {suggestions.map((q) => (
        <button
          key={q}
          type="button"
          disabled={disabled}
          onClick={() => onPick(q)}
          className="rounded-xl border border-line bg-surface-1 px-3 py-2.5 text-left text-[12.5px] leading-5 text-fg-1 transition-colors duration-[120ms] hover:border-line-strong hover:bg-surface-2 disabled:text-fg-disabled"
        >
          {q}
        </button>
      ))}
    </div>
  );
}

/** The question in flight: bubble, then the typing indicator or the inline error with Retry / Edit question. */
export function PendingTurn({
  question,
  sending,
  error,
  onRetry,
  onEdit,
}: {
  question: string;
  sending: boolean;
  /** Rendered error (already formatted by the caller); null = no error. */
  error: ReactNode;
  onRetry: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="kw-fade-in space-y-2">
      <UserBubble>{question}</UserBubble>
      {sending ? (
        <TypingIndicator />
      ) : error ? (
        <div className="space-y-1.5">
          {error}
          <div className="flex gap-1.5">
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Retry
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>
              Edit question
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
