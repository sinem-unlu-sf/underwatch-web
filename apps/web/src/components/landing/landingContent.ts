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

export type Feature = { id: string; eyebrow: string; title: string; body: string; points: string[] };

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
  },
];

export const STEPS: { n: string; title: string; body: string }[] = [
  { n: "01", title: "Run the agent", body: "Start a supervised coding agent session." },
  { n: "02", title: "Record independently", body: "Underwatch keeps its own record of what really happened." },
  { n: "03", title: "Compare", body: "Gaps between what the agent said and what it did become findings." },
  { n: "04", title: "Safeguard and verify", body: "Apply a reviewed fix and test that it holds." },
];

