import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Outlet } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { redirectLegacyLaunchToOverview } from "./lib/launchRedirect";
import { LIVE_DEMO_HREF } from "./components/landing/landingContent";

// Routing only: pages and the shell are stubbed so this test exercises App.tsx, not data fetching.
vi.mock("./components/Layout", () => ({
  Layout: () => (
    <div data-testid="app-shell">
      <Outlet />
    </div>
  ),
}));
const stub = (name: string) => () => <h1>{name} page</h1>;
vi.mock("./pages/OverviewPage", () => ({ OverviewPage: stub("Overview") }));
vi.mock("./pages/FindingsPage", () => ({ FindingsPage: stub("Findings") }));
vi.mock("./pages/FindingDetailPage", () => ({ FindingDetailPage: stub("Finding detail") }));
vi.mock("./pages/RunsPage", () => ({ RunsPage: stub("Runs") }));
vi.mock("./pages/RunDetailPage", () => ({ RunDetailPage: stub("Run detail") }));
vi.mock("./pages/SafeguardsPage", () => ({ SafeguardsPage: stub("Safeguards") }));
vi.mock("./pages/SafeguardDetailPage", () => ({ SafeguardDetailPage: stub("Safeguard detail") }));
vi.mock("./pages/EvidenceExplorerPage", () => ({ EvidenceExplorerPage: stub("Evidence") }));
vi.mock("./pages/AskWitnessPage", () => ({ AskWitnessPage: stub("Ask") }));
vi.mock("./pages/SettingsPage", () => ({ SettingsPage: stub("Settings") }));
vi.mock("./pages/LoginPage", () => ({ LoginPage: stub("Login") }));
vi.mock("./pages/SignUpPage", () => ({ SignUpPage: stub("Sign up") }));

const { App } = await import("./App");

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("app routing", () => {
  it("/ renders the landing page without the app shell, with real CTAs", () => {
    renderAt("/");
    expect(screen.getByTestId("landing-page")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Underwatch" })).toBeInTheDocument();
    // First screen: only the headline and one sentence - no buttons, no screenshot.
    const hero = screen.getByRole("heading", { level: 1 }).closest("section")!;
    expect(within(hero).queryAllByRole("link")).toHaveLength(0);
    expect(within(hero).queryAllByRole("img")).toHaveLength(0);
    expect(within(hero).getByText("Your AI agents work. Under our watch.")).toBeInTheDocument();
    // The CTAs live in the section right below (revealed on scroll).
    const start = screen.getByRole("region", { name: "Get started" });
    expect(within(start).getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(within(start).getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    expect(within(start).getByRole("link", { name: "Open the app" })).toHaveAttribute("href", "/overview");
    expect(within(start).getByRole("link", { name: /Open live demo/ })).toHaveAttribute("href", LIVE_DEMO_HREF);
    // Screenshots have alt text and no caption lines under them.
    const imgs = screen.getAllByRole("img");
    expect(imgs.length).toBeGreaterThanOrEqual(5);
    for (const img of imgs) expect(img.getAttribute("alt")?.length ?? 0).toBeGreaterThan(20);
    expect(screen.queryAllByText(/^Real product screenshot/)).toHaveLength(0);
    for (const name of ["Neo4j", "ai& Inference", "Cilium Tetragon", "Claude Code"]) expect(screen.getByText(name)).toBeInTheDocument();
  });

  it("/overview renders the Overview inside the app shell", () => {
    renderAt("/overview");
    expect(within(screen.getByTestId("app-shell")).getByRole("heading", { name: "Overview page" })).toBeInTheDocument();
    expect(screen.queryByTestId("landing-page")).toBeNull();
  });

  it.each([
    ["/findings", "Findings page"],
    ["/findings/fnd_fx04_env_read_via_bash", "Finding detail page"],
    ["/runs", "Runs page"],
    ["/runs/run_x?event=evt_y", "Run detail page"],
    ["/safeguards", "Safeguards page"],
    ["/safeguards/sg_x", "Safeguard detail page"],
    ["/evidence", "Evidence page"],
    ["/ask", "Ask page"],
    ["/settings", "Settings page"],
  ])("deep link %s is unchanged and stays in the shell", (path, heading) => {
    renderAt(path);
    expect(within(screen.getByTestId("app-shell")).getByRole("heading", { name: heading })).toBeInTheDocument();
  });

  it("/signup and /login render without the shell", () => {
    renderAt("/signup");
    expect(screen.getByRole("heading", { name: "Sign up page" })).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).toBeNull();
  });
});

describe("legacy launch link", () => {
  const fakeHist = () => ({ state: null, replaceState: vi.fn() }) as unknown as History & { replaceState: ReturnType<typeof vi.fn> };
  it("sends a captured-token launch at / to /overview", () => {
    const hist = fakeHist();
    expect(redirectLegacyLaunchToOverview(true, { pathname: "/", search: "", hash: "" } as Location, hist)).toBe(true);
    expect(hist.replaceState).toHaveBeenCalledWith(null, "", "/overview");
  });
  it("leaves plain visits to / and deep links alone", () => {
    const hist = fakeHist();
    expect(redirectLegacyLaunchToOverview(false, { pathname: "/", search: "", hash: "" } as Location, hist)).toBe(false);
    expect(redirectLegacyLaunchToOverview(true, { pathname: "/findings/fnd_1", search: "", hash: "" } as Location, hist)).toBe(false);
    expect(hist.replaceState).not.toHaveBeenCalled();
  });
});
