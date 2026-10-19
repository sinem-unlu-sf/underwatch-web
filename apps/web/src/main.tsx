import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { LANDING_ONLY } from "./components/landing/landingContent";
import { LandingPage } from "./pages/LandingPage";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");

if (LANDING_ONLY) {
  // Static landing-only build: every path renders the landing page; there is no API or app behind it.
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <LandingPage />
      </BrowserRouter>
    </StrictMode>,
  );
} else {
  // Loaded on demand so the landing-only build ships without the app.
  void import("./appMain").then(({ renderApp }) => renderApp(root));
}
