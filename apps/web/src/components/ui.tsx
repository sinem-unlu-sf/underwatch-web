import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { formatTimestamp } from "../lib/format";

export function PageHeader({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
      <div className="min-w-0">
        <h1 className="flex flex-wrap items-center gap-2 text-[18px] leading-7 font-semibold tracking-[-0.01em] text-fg-0">{title}</h1>
        {subtitle ? <div className="mt-1 max-w-[90ch] text-[13px] text-fg-2">{subtitle}</div> : null}
        {children}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Lightweight surface. Use sparingly: prefer <Section/> (components/ds) for plain page structure. */
export function Panel({
  title,
  aside,
  children,
  className = "",
  id,
  bodyClassName = "p-3",
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  bodyClassName?: string;
}) {
  return (
    <section id={id} className={`rounded-md border border-line bg-surface-1 ${className}`}>
      {title ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h2 className="text-[12.5px] font-semibold text-fg-0">{title}</h2>
          {aside ? <div className="flex flex-wrap items-center gap-2 text-fg-2">{aside}</div> : null}
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** Monospace identifier / path / hash. Long values wrap rather than overflow. See ds/MonoValue for truncate + copy. */
export function Mono({ children, className = "", title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`font-mono text-[12px] break-all ${className}`}>
      {children}
    </span>
  );
}

export function Time({ iso, className = "" }: { iso: string | null | undefined; className?: string }) {
  return (
    <time dateTime={iso ?? undefined} title={iso ?? undefined} className={`font-mono text-[12px] whitespace-nowrap text-fg-1 tabular-nums ${className}`}>
      {formatTimestamp(iso)}
    </time>
  );
}

export function KeyValue({ items, className = "" }: { items: Array<[ReactNode, ReactNode]>; className?: string }) {
  return (
    <dl className={`grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 ${className}`}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="label pt-0.5">{k}</dt>
          <dd className="min-w-0 text-fg-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Stat({ label, value, breakdown }: { label: string; value: number; breakdown?: ReactNode }) {
  return (
    <div className="min-w-[120px] border-l border-line px-4 py-1 first:border-l-0 first:pl-0">
      <div className="label">{label}</div>
      <div className="font-mono text-[20px] leading-7 font-semibold text-fg-0 tabular-nums">{value}</div>
      {breakdown ? <div className="text-[11.5px] text-fg-2">{breakdown}</div> : null}
    </div>
  );
}

/**
 * Form field: label, optional help text, optional inline validation error. When `help` / `error` is given and the
 * child is a single element, it gets aria-describedby (and aria-invalid for errors) automatically.
 * Existing call sites (label + children [+ htmlFor]) are unchanged.
 */
export function Field({
  label,
  children,
  htmlFor,
  help,
  error,
  required,
  className = "",
}: {
  label: string;
  children: ReactNode;
  htmlFor?: string;
  help?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
}) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [helpId, errId].filter(Boolean).join(" ") || undefined;
  const control =
    describedBy && isValidElement(children)
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          "aria-describedby": describedBy,
          "aria-invalid": error ? true : undefined,
        })
      : children;
  return (
    <label htmlFor={htmlFor} className={`flex flex-col gap-1 ${className}`}>
      <span className="label">
        {label}
        {required ? (
          <span className="ml-0.5 text-fg-2" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>
      {control}
      {help ? (
        <span id={helpId} className="text-[11.5px] text-fg-2">
          {help}
        </span>
      ) : null}
      {error ? (
        <span id={errId} role="alert" className="text-[11.5px] text-risk">
          {error}
        </span>
      ) : null}
    </label>
  );
}
