import type { ReactNode } from "react";

/**
 * Page section: heading + one-line description, no heavy card. Prefer this over wrapping everything in a Panel.
 * `level` picks h2/h3 so the page outline stays correct.
 */
export function Section({
  title,
  description,
  actions,
  children,
  id,
  level = 2,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  id?: string;
  level?: 2 | 3;
  className?: string;
}) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={`scroll-mt-16 ${className}`}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <H id={id ? `${id}-title` : undefined} className={`${level === 2 ? "text-[14px]" : "text-[13px]"} font-semibold tracking-[-0.005em] text-fg-0`}>
            {title}
          </H>
          {description ? <p className="mt-0.5 max-w-[80ch] text-[12.5px] text-fg-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Thin horizontal rule using the border token. */
export function Divider({ className = "" }: { className?: string }) {
  return <hr className={`border-0 border-t border-line ${className}`} />;
}
