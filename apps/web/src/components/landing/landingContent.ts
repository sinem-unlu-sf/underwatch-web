/**
 * Static landing-page content. Everything here describes what the product actually does in this build; the
 * screenshots under /public/landing/ are real captures of the running app (see LANDING_SHOTS captions).
 */

/** Live finding captured by a supervised Claude Code run (checked against GET /api/findings/:id when this was built). */
export const LIVE_DEMO_FINDING_ID = "fnd_ca5a1b22857329f433af6282";
/** Seeded fixture finding (fx-04) that always exists after `pnpm seed:fixtures`. */
export const FIXTURE_DEMO_FINDING_ID = "fnd_fx04_env_read_via_bash";

export const LIVE_DEMO_HREF = `/findings/${LIVE_DEMO_FINDING_ID}`;
export const FIXTURE_DEMO_HREF = `/findings/${FIXTURE_DEMO_FINDING_ID}`;

/**
 * Static landing-only build (`pnpm build:landing`, deployed to Vercel via the repo-root vercel.json): no API server or app routes behind it, so
 * the CTAs that would go to sign-up, the app and the demos lead to the beta sign-up form instead.
 */
export const LANDING_ONLY = import.meta.env.VITE_LANDING_ONLY === "1";
export const BETA_CTA = "Join the beta";
export const BETA_HREF = "#beta";

export type LandingShot ={ src: string; alt: string; caption: string; width: number; height: number };

export const HERO_SHOT: LandingShot = {
  src: "/landing/hero-finding.webp",
  alt: "Underwatch finding page for a live supervised coding agent session, with a short read of what went wrong and the evidence behind it.",
  caption: "Real product screenshot: a live finding from a supervised Claude Code run (synthetic secret).",
  width: 1800,
  height: 1125,
};

export type Feature = { id: string; eyebrow: string; title: string; body: string; points: string[]; shot: LandingShot };

export const FEATURES: Feature[] = [
  {
    id: "observe",
    eyebrow: "Observe independently",
    title: "Evidence that does not come from the agent.",
    body: "Underwatch keeps its own record of what a coding agent did, so you are not relying on the agent's word.",
    points: [
      "Files, commands and network activity, recorded as they happen",
      "A record the agent cannot edit",
      "Works alongside the agent you already use",
    ],
    shot: {
      src: "/landing/evidence-events.webp",
      alt: "Evidence Explorer listing the recorded activity for a session, with each event's type and outcome.",
      caption: "Real product screenshot: Evidence Explorer for a session.",
      width: 1800,
      height: 1125,
    },
  },
  {
    id: "compare",
    eyebrow: "Catch the gaps",
    title: "What the agent said, next to what actually happened.",
    body: "When an agent's account of its work does not hold up, Underwatch raises a finding with a severity, a confidence level and the evidence behind it.",
    points: [
      "Clear findings, ranked by severity",
      "Security outcome kept separate from task outcome",
      "Unknown stays unknown: never shown as safe",
    ],
    shot: {
      src: "/landing/compare.webp",
      alt: "Finding comparison panel showing where the agent's account and the recorded activity differ.",
      caption: "Real product screenshot: comparison view for a live finding.",
      width: 1800,
      height: 1125,
    },
  },
  {
    id: "investigate",
    eyebrow: "Investigate",
    title: "Trace any finding. Ask questions in plain words.",
    body: "Every finding links back to the activity that caused it. Ask Witness answers your questions from Underwatch records, with citations you can check.",
    points: [
      "From a finding to the exact action behind it",
      "Ask Witness: AI interprets, records establish the facts",
      "Every answer cites its sources",
    ],
    shot: {
      src: "/landing/evidence-graph.webp",
      alt: "Evidence view for an example finding, linking it to the related activity and safeguards.",
      caption: "Real product screenshot: evidence view for an example finding (FIXTURE data).",
      width: 1800,
      height: 1125,
    },
  },
  {
    id: "safeguards",
    eyebrow: "Turn incidents into tested safeguards",
    title: "Fix it, then prove the fix works.",
    body: "A finding becomes a proposed safeguard you review before anything changes. Underwatch then tests it and records whether it held.",
    points: [
      "Safeguards tested, not just written",
      "Shown as failed when the agent gets around them",
      "Nothing is applied without your approval",
    ],
    shot: {
      src: "/landing/safeguard-verified.webp",
      alt: "Safeguard workflow: Investigate, Propose, Review, Test and Verify steps complete, with the tested result shown as Passed.",
      caption: "Real product screenshot: a safeguard verified for the tested scenario.",
      width: 1800,
      height: 1125,
    },
  },
];

export const STEPS: { n: string; title: string; body: string }[] = [
  { n: "01", title: "Run the agent", body: "Start a supervised coding agent session." },
  { n: "02", title: "Record independently", body: "Underwatch keeps its own record of what really happened." },
  { n: "03", title: "Compare", body: "Gaps between what the agent said and what it did become findings." },
  { n: "04", title: "Safeguard and verify", body: "Apply a reviewed fix and test that it holds." },
];

