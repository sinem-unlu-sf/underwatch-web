import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { captureTokenFromUrl } from "./api/auth";
import { ApiRequestError } from "./api/client";
import { App } from "./App";
import { redirectLegacyLaunchToOverview } from "./lib/launchRedirect";

export function renderApp(root: HTMLElement) {
  // Before anything renders or fetches: move ?token= from the address bar into storage.
  // A launch link to "/" (the landing page since /overview took the Overview) still opens the app.
  redirectLegacyLaunchToOverview(captureTokenFromUrl());

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // Calm UI (PRD Addendum B): never refetch just because the window regained focus or the network came back.
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        // Retrying a contract mismatch or a 404 cannot succeed; retry only when the API may come up.
        retry: (failureCount, error) => error instanceof ApiRequestError && error.kind === "unreachable" && failureCount < 1,
      },
    },
  });

  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}
