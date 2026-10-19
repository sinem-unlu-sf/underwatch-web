import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type NoticeTone = "info" | "success" | "caution" | "danger" | "unknown";

const TONE: Record<NoticeTone, { cls: string; icon: IconName; titleCls: string; role: "status" | "alert" }> = {
  info: { cls: "border-line-strong bg-surface-1", icon: "info", titleCls: "text-fg-0", role: "status" },
  success: { cls: "border-verified/40 bg-verified/8", icon: "check", titleCls: "text-verified", role: "status" },
  caution: { cls: "border-warn/45 bg-warn/8", icon: "alertCircle", titleCls: "text-warn", role: "status" },
  danger: { cls: "border-risk/50 bg-risk/8", icon: "alert", titleCls: "text-risk", role: "alert" },
  unknown: { cls: "hatch", icon: "question", titleCls: "text-unknown", role: "status" },
};

/**
 * Inline, persistent notice. Use for unresolved issues / warnings / errors in the context where they matter
 * (they stay until resolved). Do not use for transient success: see <SuccessFlash/>.
 */
export function Notice({
  tone = "info",
  title,
  children,
  actions,
  onDismiss,
  className = "",
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Only offer dismissal for informational notices; unresolved problems should stay visible. */
  onDismiss?: () => void;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <div role={t.role} className={`flex gap-2.5 rounded-md border px-3 py-2.5 text-[12.5px] ${t.cls} ${className}`}>
      <Icon name={t.icon} size={15} className={`mt-px ${t.titleCls}`} />
      <div className="min-w-0 flex-1">
        {title ? <div className={`font-semibold ${t.titleCls}`}>{title}</div> : null}
        {children ? <div className={`text-fg-1 ${title ? "mt-0.5" : ""}`}>{children}</div> : null}
        {actions ? <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="btn btn-ghost btn-sm btn-icon -mt-0.5 -mr-1">
          <Icon name="x" size={12} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Transient confirmation for a CONFIRMED success only. Render it after the mutation resolved successfully
 * (e.g. `{mutation.isSuccess ? <SuccessFlash key={mutation.submittedAt}>Saved</SuccessFlash> : null}`).
 * It announces politely and fades out after `duration` ms. Never render it optimistically.
 */
export function SuccessFlash({ children, duration = 2400 }: { children: ReactNode; duration?: number }) {
  const [visible, setVisible] = useState(true);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    t.current = setTimeout(() => setVisible(false), duration);
    return () => {
      if (t.current) clearTimeout(t.current);
    };
  }, [duration]);
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-1 text-[12px] text-verified">
      {visible ? (
        <span className="kw-fade-in inline-flex items-center gap-1">
          <Icon name="check" size={12} />
          {children}
        </span>
      ) : null}
    </span>
  );
}
