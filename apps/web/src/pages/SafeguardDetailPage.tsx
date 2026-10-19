import { Link, useParams } from "react-router";
import { useSafeguard } from "../api/queries";
import { SafeguardReview } from "../components/safeguards/SafeguardReview";
import { ErrorState, PageSkeleton } from "../components/states";
import { Icon } from "../components/ds/Icon";
import { Mono, PageHeader } from "../components/ui";

export function SafeguardDetailPage() {
  const { id = "" } = useParams();
  const q = useSafeguard(id);
  return (
    <div>
      <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-[12px] text-fg-2">
        <Link to="/safeguards" className="hover:text-fg-0 hover:underline">
          Safeguards
        </Link>
        <Icon name="chevronRight" size={11} className="text-fg-disabled" />
        <Mono className="text-[11.5px] text-fg-1">{id}</Mono>
      </nav>
      <PageHeader
        title="Safeguard"
        subtitle={<Mono>{id}</Mono>}
        actions={
          <Link to="/safeguards" className="btn">
            All safeguards
          </Link>
        }
      />
      {q.isPending ? (
        <PageSkeleton />
      ) : q.isError ? (
        <ErrorState error={q.error} what="this safeguard" />
      ) : (
        <div className="max-w-[1200px]">
          <SafeguardReview detail={q.data} />
        </div>
      )}
    </div>
  );
}
