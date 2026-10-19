import type { KeyboardEvent, ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  /** CSS width, e.g. "120px" or "30%". */
  width?: string;
  /** Truncate to one line; the full value is exposed via `title` (from fullValue) so it stays accessible. */
  truncate?: boolean;
  fullValue?: (row: T) => string | undefined;
  /** Optional extra className for the cell (e.g. "font-mono"). */
  className?: string;
};

/**
 * Compact data table: sticky header, subtle dividers, hover + selected rows, consistent alignment.
 * Wraps itself in a horizontal scroll container so long rows never overflow the page (works at ~400px).
 * Sorting / filtering / pagination stay owned by the page (pass already-processed rows); this is presentation only.
 * When `onRowClick` is given, rows are keyboard-activatable (Enter / Space) and focusable.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  caption,
  empty,
  maxHeight,
  className = "",
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  /** Accessible caption (visually hidden). */
  caption?: string;
  /** Rendered in place of the body when rows is empty (use <EmptyState/>). */
  empty?: ReactNode;
  /** Enables vertical scrolling with the sticky header, e.g. "60vh". */
  maxHeight?: string;
  className?: string;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (!onRowClick) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onRowClick(row);
    }
  };
  return (
    <div className={`overflow-x-auto ${maxHeight ? "overflow-y-auto" : ""} ${className}`} style={maxHeight ? { maxHeight } : undefined}>
      <table className="data sticky">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.align === "right" ? "num" : ""} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const k = rowKey(row);
            const selected = selectedKey != null && selectedKey === k;
            return (
              <tr
                key={k}
                data-selected={selected || undefined}
                aria-selected={onRowClick ? selected : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => onKey(e, row) : undefined}
                className={onRowClick ? "cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent" : ""}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`${c.align === "right" ? "num" : ""} ${c.truncate ? "max-w-0 truncate" : ""} ${c.className ?? ""}`}
                    title={c.truncate ? c.fullValue?.(row) : undefined}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
