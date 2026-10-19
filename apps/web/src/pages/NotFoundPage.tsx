import { Link } from "react-router";
import { PageHeader } from "../components/ui";

export function NotFoundPage() {
  return (
    <div>
      <PageHeader title="Page not found" subtitle="This route does not exist in the Underwatch UI." />
      <Link to="/overview" className="text-focus underline">
        Go to Overview
      </Link>
    </div>
  );
}
