import { Route, Routes } from "react-router";
import { Layout } from "./components/Layout";
import { AskWitnessPage } from "./pages/AskWitnessPage";
import { EvidenceExplorerPage } from "./pages/EvidenceExplorerPage";
import { FindingDetailPage } from "./pages/FindingDetailPage";
import { FindingsPage } from "./pages/FindingsPage";
import { LandingPage } from "./pages/LandingPage";
import { LivePage } from "./pages/LivePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { RunsPage } from "./pages/RunsPage";
import { SafeguardDetailPage } from "./pages/SafeguardDetailPage";
import { SafeguardsPage } from "./pages/SafeguardsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { LoginPage } from "./pages/LoginPage";
import { SignUpPage } from "./pages/SignUpPage";

export function App() {
  return (
    <Routes>
      {/* Auth pages: no app shell. */}
      <Route path="signup" element={<SignUpPage />} />
      <Route path="login" element={<LoginPage />} />
      {/* Public landing page at "/": no app shell. The Overview moved to /overview. */}
      <Route index element={<LandingPage />} />
      <Route element={<Layout />}>
        <Route path="overview" element={<OverviewPage />} />
        <Route path="live" element={<LivePage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:id" element={<RunDetailPage />} />
        <Route path="findings" element={<FindingsPage />} />
        <Route path="findings/:id" element={<FindingDetailPage />} />
        <Route path="safeguards" element={<SafeguardsPage />} />
        <Route path="safeguards/:id" element={<SafeguardDetailPage />} />
        <Route path="evidence" element={<EvidenceExplorerPage />} />
        <Route path="ask" element={<AskWitnessPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
