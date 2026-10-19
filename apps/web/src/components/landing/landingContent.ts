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
 * Static landing-only build (`pnpm build:landing`, deployed to Vercel): no API server or app routes behind it, so
 * the CTAs that would go to sign-up, the app and the demos lead to the beta sign-up form instead.
 */
export const LANDING_ONLY = import.meta.env.VITE_LANDING_ONLY === "1";
export const BETA_CTA = "Join the beta";
export const BETA_HREF = "#beta";

export type LandingShot ={ src: string; alt: string; caption: string; width: number; height: number };

export const HERO_SHOT: LandingShot = {
  src: "/landing/hero-finding.webp",
  alt: "Underwatch finding page: a protected .env file reached the agent via Bash despite policy rule R1, with a short read, the agent's report next to what the kernel saw, and the Neo4j evidence path.",
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
    body: "Underwatch records what actually happened while a coding agent works, from sources the agent cannot edit.",
    points: [
      "Cilium Tetragon kernel events: process exec, file open, network connect",
      "Egress proxy log for every outbound request",
      "Git observer for real repository changes",
    ],
    shot: {
      src: "/landing/evidence-events.webp",
      alt: "Evidence Explorer listing recorded events with their basis (reported, observed, derived), source such as process_tracer or git_observer, event type and outcome.",
      caption: "Real product screenshot: Evidence Explorer, every event labelled reported, observed or derived.",
      width: 1800,
      height: 1125,
    },
  },
  {
    id: "compare",
    eyebrow: "Compare reported vs observed",
    title: "What the agent said, next to what the kernel saw.",
    body: "Each claim in the agent's final report is matched against independent observations. Gaps become findings with severity, confidence and the evidence ids behind them.",
    points: [
      "Agent reported and independently observed, side by side",
      "Security outcome kept separate from task outcome",
      "Unknown stays unknown: never shown as safe",
    ],
    shot: {
      src: "/landing/compare.webp",
      alt: "Reported vs observed panel: each agent-reported tool call on the left, the independently observed evidence on the right, with unmatched rows hatched.",
      caption: "Real product screenshot: Reported vs observed for a live finding.",
      width: 1800,
      height: 1125,
    },
  },
  {
    id: "investigate",
    eyebrow: "Investigate",
    title: "Follow the evidence graph. Ask questions in plain words.",
    body: "Findings, events, files and rules live in a Neo4j evidence graph. Ask Witness answers from Underwatch records via ai& Inference, and every citation is checked against the records sent.",
    points: [
      "Neo4j path from the finding to the exact kernel event",
      "Ask Witness: AI interprets, records establish the facts",
      "Claim labels assigned by Underwatch, not by the model",
    ],
    shot: {
      src: "/landing/evidence-graph.webp",
      alt: "Neo4j evidence graph for the fx-04 fixture finding, linking it to the rule, agent actions, observed events, processes, files and safeguards.",
      caption: "Real product screenshot: Neo4j evidence graph for the fx-04 finding (FIXTURE data).",
      width: 1800,
      height: 1125,
    },
  },
  {
    id: "safeguards",
    eyebrow: "Turn incidents into tested safeguards",
    title: "Fix it, then prove the fix works.",
    body: "A finding becomes a proposed safeguard you review as a diff. Underwatch then re-runs the scenario and records whether the safeguard held.",
    points: [
      "Kernel enforcement: verified for the tested scenario",
      "Claude Code permission rule: shown as bypassed when Bash got around it",
      "Nothing is applied without a diff and your approval",
    ],
    shot: {
      src: "/landing/safeguard-verified.webp",
      alt: "Kernel enforcement safeguard: Investigate, Propose, Review, Test and Verify steps complete, tested result Passed (tested scenario only), Security: Blocked and Task succeeded shown separately.",
      caption: "Real product screenshot: a kernel enforcement safeguard verified for the tested scenario.",
      width: 1800,
      height: 1125,
    },
  },
];

export const STEPS: { n: string; title: string; body: string }[] = [
  { n: "01", title: "Run the agent", body: "Start a supervised Claude Code session in an isolated workspace." },
  { n: "02", title: "Record independently", body: "Kernel, proxy and git observers capture what really happened." },
  { n: "03", title: "Compare", body: "The agent's report is checked claim by claim against the observations." },
  { n: "04", title: "Safeguard and verify", body: "Apply a reviewed fix and re-test it against the same scenario." },
];

export const BUILT_WITH = ["Neo4j", "ai& Inference", "Cilium Tetragon", "Claude Code"];
