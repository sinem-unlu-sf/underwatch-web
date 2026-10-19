export function Pager({ offset, limit, total, shown, onChange }: { offset: number; limit: number; total: number; shown: number; onChange: (offset: number) => void }) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-[12px] text-fg-2">
      <span>
        {offset + 1}–{offset + shown} of <span className="font-mono text-fg-1">{total}</span>
      </span>
      <span className="flex gap-2">
        <button type="button" className="btn" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          Previous
        </button>
        <button type="button" className="btn" disabled={offset + shown >= total} onClick={() => onChange(offset + limit)}>
          Next
        </button>
      </span>
    </div>
  );
}
