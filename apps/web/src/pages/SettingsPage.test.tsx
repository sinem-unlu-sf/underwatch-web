import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SettingsStatusResponse } from "@kw/schema";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

const T = "2026-10-17T02:00:00.000Z";
const c = (id: string, name: string, status: "connected" | "not_configured" | "configured", configured_via: string | null = null) => ({ id, name, status, detail: `${name} detail`, configured_via });
const STATUS: SettingsStatusResponse = {
  generated_at: T,
  adapter: c("adapter", "Claude Code adapter", "connected"),
  collectors: [c("tetragon", "Tetragon kernel tracer", "connected"), c("fs", "File watcher", "connected")],
  policy: { ...c("policy", "Supervised policy", "configured"), active_policy_version_id: null },
  ai_inference: c("ai", "ai& API client", "not_configured", "AIAND_API_KEY"),
  neo4j: c("neo4j", "Neo4j", "connected", "NEO4J_URI"),
  database: { ...c("db", "SQLite", "connected", "data/kw.db"), driver: "node:sqlite" },
  retention: { status: "not_configured", detail: "No retention job", raw_evidence_retention_days: 30 },
  redaction: { status: "configured", detail: "Secrets redacted" },
  data_mode: { fixture_runs: 2, live_runs: 1, contains_fixture_data: true },
} as unknown as SettingsStatusResponse;

const idle = { isPending: false, isError: false, error: null, data: undefined, mutate: vi.fn() };
vi.mock("../api/queries", () => ({
  useSettingsStatus: () => ({ ...idle, isSuccess: true, data: STATUS }),
  useWorkspaces: () => ({ ...idle, isSuccess: true, data: { items: [] } }),
  useDemoWorkspace: () => idle,
  useAuthorizeWorkspace: () => idle,
  useVerificationHarness: () => ({ ...idle, isPending: true }),
}));

const { SettingsPage } = await import("./SettingsPage");

describe("SettingsPage", () => {
  it("groups integrations, collectors, policy, workspaces, credentials, retention and data mode", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    for (const name of ["Integrations and status", "Event collection (independent observers)", "Policy", "Workspaces", "Credentials", "Data retention and redaction", "Data mode"])
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    const integrations = screen.getByRole("heading", { name: "Integrations and status" }).closest("section")!;
    for (const role of ["Agent adapter", "ai& Inference", "Neo4j evidence graph", "Database"]) expect(within(integrations).getByText(role)).toBeInTheDocument();
    expect(within(integrations).getByText("node:sqlite")).toBeInTheDocument();
    expect(screen.getByText("Tetragon kernel tracer")).toBeInTheDocument();
    expect(screen.getByText("(proposed; not enforced)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create demo workspace" })).toBeEnabled();
    expect(screen.getByText(/No workspace authorized/)).toBeInTheDocument();
    // Every jump link targets a section that exists.
    for (const a of within(screen.getByRole("navigation", { name: "Settings sections" })).getAllByRole("link"))
      expect(document.querySelector(a.getAttribute("href")!)).not.toBeNull();
    expect(screen.getByRole("link", { name: "View fixture runs" })).toHaveAttribute("href", "/runs?fixture=only");
  });
});
