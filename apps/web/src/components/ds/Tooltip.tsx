import { cloneElement, isValidElement, useId, useState, type ReactElement, type ReactNode } from "react";

/**
 * Tooltip for SUPPLEMENTARY info only (never the only place important information lives).
 * Opens on hover AND keyboard focus, closes on Escape / blur / mouse leave. The trigger gets aria-describedby.
 * The child must be a single focusable element (button, link, or an element with tabIndex=0).
 */
export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactElement; side?: "top" | "bottom" }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  if (!isValidElement(children)) return children;
  const child = children as ReactElement<Record<string, unknown>>;
  const trigger = cloneElement(child, {
    "aria-describedby": open ? id : (child.props["aria-describedby"] as string | undefined),
    onFocus: (e: unknown) => {
      setOpen(true);
      (child.props.onFocus as ((e: unknown) => void) | undefined)?.(e);
    },
    onBlur: (e: unknown) => {
      setOpen(false);
      (child.props.onBlur as ((e: unknown) => void) | undefined)?.(e);
    },
    onKeyDown: (e: { key: string }) => {
      if (e.key === "Escape") setOpen(false);
      (child.props.onKeyDown as ((e: unknown) => void) | undefined)?.(e);
    },
  });
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {trigger}
      {open ? (
        <span
          role="tooltip"
          id={id}
          className={`surface-raised kw-fade-in pointer-events-none absolute left-1/2 z-50 w-max max-w-[280px] -translate-x-1/2 px-2 py-1 text-[11.5px] leading-snug font-normal text-fg-0 normal-case ${
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
          }`}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}

/** Keyboard key hint. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[18px] items-center justify-center rounded-[4px] border border-line-strong border-b-2 bg-surface-2 px-1 font-mono text-[10.5px] leading-4 text-fg-1">
      {children}
    </kbd>
  );
}

/** Generic skeleton bar. Pair with an aria-busy container (see states.tsx LoadingState / SkeletonRows). */
export function Skeleton({ className = "", width, height = 14 }: { className?: string; width?: number | string; height?: number | string }) {
  return <span aria-hidden="true" className={`skeleton block ${className}`} style={{ width: width ?? "100%", height }} />;
}
