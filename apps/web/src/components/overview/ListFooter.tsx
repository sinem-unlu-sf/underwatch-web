import { Link } from "react-router";
import { Icon } from "../ds/Icon";

export function ListFooter({ shown, total, noun, to, caveat }: { shown: number; total: number; noun: string; to: string; caveat?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-[11.5px] text-fg-2">
      <span>
        Showing {shown} of {total} {noun}
        {caveat ? `. ${caveat}` : ""}
      </span>
      {total > shown ? (
        <Link to={to} className="inline-flex items-center gap-1 text-fg-1 hover:text-fg-0 hover:underline">
          View all <Icon name="chevronRight" size={11} />
        </Link>
      ) : null}
    </div>
  );
}
