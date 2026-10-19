import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export type SegmentedOption<T extends string> = { value: T; label: ReactNode; description?: string; disabled?: boolean };

/**
 * Accessible single-choice switch (role="radiogroup", roving tabindex, arrow keys / Home / End).
 * Use for view modes such as "Quick Read | Full Technical Details". The selected segment is marked with weight,
 * a raised surface and aria-checked, not colour alone.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className = "",
}: {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group (visually hidden). */
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const name = useId();
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  const move = (from: number, dir: 1 | -1 | "first" | "last") => {
    if (enabled.length === 0) return;
    let next: number;
    if (dir === "first") next = enabled[0]!;
    else if (dir === "last") next = enabled[enabled.length - 1]!;
    else {
      const pos = enabled.indexOf(from);
      next = enabled[(pos + dir + enabled.length) % enabled.length]!;
    }
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") move(i, 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(i, -1);
    else if (e.key === "Home") move(i, "first");
    else if (e.key === "End") move(i, "last");
    else return;
    e.preventDefault();
  };

  const pad = size === "sm" ? "px-2.5 py-0.5 text-[12px] min-h-[24px]" : "px-3 py-1 text-[12.5px] min-h-[28px]";

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-md border border-line bg-surface-0 p-0.5 ${className}`}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            name={name}
            aria-checked={checked}
            disabled={o.disabled}
            tabIndex={checked ? 0 : -1}
            title={o.description}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`inline-flex items-center gap-1.5 rounded-[5px] font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-120 ease-out focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-fg-disabled ${pad} ${
              checked ? "bg-surface-2 text-fg-0 shadow-[var(--shadow-raised)]" : "text-fg-2 hover:text-fg-0"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
