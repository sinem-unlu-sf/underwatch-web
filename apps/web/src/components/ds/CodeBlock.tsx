import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * Copy to clipboard with an accessible confirmation. "Copied" is shown ONLY after the clipboard write resolved;
 * a failure says so (aria-live polite region).
 */
export function CopyButton({ value, label = "Copy", className = "" }: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={state === "idle" ? `${label} to clipboard` : undefined}
      className={`btn btn-ghost btn-sm gap-1 ${className}`}
    >
      <Icon name={state === "copied" ? "check" : state === "failed" ? "x" : "copy"} size={12} />
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}</span>
    </button>
  );
}

/**
 * Block of source data (code, command, log, raw JSON). Geist Mono, whitespace preserved, restrained colours.
 * Long lines scroll horizontally by default; pass wrap to wrap. Copy is one click.
 */
export function CodeBlock({
  code,
  language,
  title,
  wrap = false,
  copy = true,
  maxHeight = "28rem",
  className = "",
}: {
  code: string;
  /** Shown as a small label (e.g. "json", "bash", "log"). No syntax highlighting: plain text reads best on dark. */
  language?: string;
  title?: ReactNode;
  wrap?: boolean;
  copy?: boolean;
  maxHeight?: string;
  className?: string;
}) {
  return (
    <figure className={`overflow-hidden rounded-md border border-line bg-surface-0 ${className}`}>
      {title || language || copy ? (
        <figcaption className="flex items-center justify-between gap-2 border-b border-line px-3 py-1">
          <span className="flex min-w-0 items-center gap-2 truncate text-[11.5px] text-fg-2">
            {title ? <span className="truncate text-fg-1">{title}</span> : null}
            {language ? <span className="font-mono text-[10.5px] tracking-wide text-fg-2 uppercase">{language}</span> : null}
          </span>
          {copy ? <CopyButton value={code} /> : null}
        </figcaption>
      ) : null}
      <pre className={`code-block overflow-auto px-3 py-2 ${wrap ? "wrap" : ""}`} style={{ maxHeight }} tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

/**
 * Inline technical value (id, hash, path, timestamp). Truncates to `maxWidth` with the full value in title and an
 * optional inline copy affordance, so long ids never break the layout but remain fully accessible.
 */
export function MonoValue({
  value,
  display,
  copy = false,
  truncate = true,
  maxWidth = "24ch",
  className = "",
}: {
  value: string;
  /** Optional shortened rendering; the full `value` is always in title / copy. */
  display?: ReactNode;
  copy?: boolean;
  truncate?: boolean;
  maxWidth?: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex max-w-full items-center gap-1 align-middle ${className}`}>
      <span
        title={value}
        className={`font-mono text-[12px] text-fg-0 ${truncate ? "inline-block truncate" : "break-all"}`}
        style={truncate ? { maxWidth } : undefined}
      >
        {display ?? value}
      </span>
      {copy ? <CopyButton value={value} label="Copy" className="!min-h-[20px] !px-1 !text-[11px]" /> : null}
    </span>
  );
}
