import { useEffect, useId, useRef, useState } from "react";

/**
 * Evidence radar for the landing page's problem section: an illustrative map of the evidence around one agent run.
 * "Agent report only" shows just the agent's own account; "With Underwatch" adds Underwatch's own record and what it
 * finds in the gaps. The SVG is decorative (aria-hidden): the category buttons and the
 * caption carry the same information as text. Illustration only, not live data.
 */

type Mode = "reported" | "observed";
type Tone = "reported" | "observed" | "derived";
type CategoryId = "reported" | "process" | "reads" | "writes" | "egress" | "findings" | "safeguards";

type Category = {
  id: CategoryId;
  label: string;
  /** Short mono tag drawn next to the node. */
  tag: string;
  angle: number;
  r: number;
  tone: Tone;
  color: string;
  body: string;
};

const CLAIM = "#A2AEC3";
const OBSERVED = "#75A9FF";
const CAUTION = "#F0B85A";
const VERIFIED = "#47C9A5";

const CATEGORIES: Category[] = [
  {
    id: "reported",
    label: "What the agent said",
    tag: "said",
    angle: 205,
    r: 128,
    tone: "reported",
    color: CLAIM,
    body: "What the agent says it did, in its own words.",
  },
  {
    id: "process",
    label: "Commands run",
    tag: "commands",
    angle: -62,
    r: 140,
    tone: "observed",
    color: OBSERVED,
    body: "Every command the agent ran, including ones it never mentioned.",
  },
  {
    id: "reads",
    label: "Files read",
    tag: "reads",
    angle: -12,
    r: 118,
    tone: "observed",
    color: OBSERVED,
    body: "Files the agent opened, including protected ones such as .env.",
  },
  {
    id: "writes",
    label: "Files changed",
    tag: "changes",
    angle: 38,
    r: 150,
    tone: "observed",
    color: OBSERVED,
    body: "The real changes to your repository, not the summary.",
  },
  {
    id: "egress",
    label: "Network requests",
    tag: "network",
    angle: -128,
    r: 150,
    tone: "observed",
    color: OBSERVED,
    body: "Every outbound request, and where it went.",
  },
  {
    id: "findings",
    label: "Findings",
    tag: "finding",
    angle: 112,
    r: 92,
    tone: "derived",
    color: CAUTION,
    body: "Gaps between what the agent said and what it did become findings, with a severity, a confidence level and the evidence.",
  },
  {
    id: "safeguards",
    label: "Safeguards",
    tag: "safeguard",
    angle: 150,
    r: 160,
    tone: "derived",
    color: OBSERVED,
    body: "A finding can become a proposed safeguard that you review and Underwatch tests.",
  },
];

/** Extra links between categories (besides each category's line to the centre), shown when observed. */
const LINKS: [CategoryId, CategoryId][] = [
  ["reported", "findings"],
  ["reads", "findings"],
  ["writes", "findings"],
  ["findings", "safeguards"],
];

const RINGS = [55, 100, 145, 190];
const SWEEP_R = 190;

const rad = (d: number) => (d * Math.PI) / 180;

const NODES = CATEGORIES.map((c) => {
  const cos = Math.cos(rad(c.angle));
  const sin = Math.sin(rad(c.angle));
  const x = c.r * cos;
  const y = c.r * sin;
  const anchor: "start" | "end" | "middle" = cos > 0.35 ? "start" : cos < -0.35 ? "end" : "middle";
  const lx = x + cos * 14;
  const ly = anchor === "middle" ? y + (sin > 0 ? 20 : -14) : y + sin * 10 + 3.5;
  return { ...c, x, y, lx, ly, anchor };
});

const byId = (id: CategoryId) => NODES.find((n) => n.id === id);

const TONE_LABEL: Record<Tone, string> = { reported: "agent's word", observed: "recorded", derived: "found by Underwatch" };

const MODE_LINE: Record<Mode, string> = {
  reported: "Only the agent's own account. Nothing here has been checked against what actually ran.",
  observed: "Underwatch adds its own record, which the agent cannot edit, and the gaps become findings.",
};

export function EvidenceRadar() {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [mode, setMode] = useState<Mode>("observed");
  const [selected, setSelected] = useState<CategoryId>("reads");
  const [pulse, setPulse] = useState(false);
  const figRef = useRef<HTMLElement>(null);
  const sweepRotate = useRef<SVGAnimateTransformElement>(null);
  const sweepFade = useRef<SVGAnimateElement>(null);

  // Brief localized pulse on the selected node whenever the selection or view changes.
  useEffect(() => {
    setPulse(false);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setPulse(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [selected, mode]);

  // One slow sweep the first time the radar scrolls into view (skipped under reduced motion).
  useEffect(() => {
    const fig = figRef.current;
    if (!fig || typeof IntersectionObserver === "undefined") return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        try {
          sweepRotate.current?.beginElement();
          sweepFade.current?.beginElement();
        } catch {
          // SMIL unavailable: the radar simply shows without the sweep.
        }
      },
      { threshold: 0.4 },
    );
    io.observe(fig);
    return () => io.disconnect();
  }, []);

  const lit = (c: Category) => mode === "observed" || c.tone === "reported";
  const choose = (c: Category) => {
    if (!lit(c)) setMode("observed");
    setSelected(c.id);
  };
  const switchMode = (m: Mode) => {
    setMode(m);
    if (m === "reported") setSelected("reported");
  };

  const current = byId(selected) ?? NODES[0];
  const sweepEdge = SWEEP_R * Math.cos(rad(20));
  const sweepRise = SWEEP_R * Math.sin(rad(20));

  return (
    <figure
      ref={figRef}
      className="relative m-0 w-full min-w-0 overflow-hidden rounded-[14px] border border-[#25334B] bg-[linear-gradient(180deg,rgba(13,20,35,0.94),rgba(7,13,26,0.94))] p-4 shadow-[0_24px_60px_rgba(0,0,0,0.45)] sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#A2AEC3]">Evidence around one agent run</p>
        <p className="font-mono text-[11px] text-[#6F7C93]">Illustration · not live data</p>
      </div>

      <div role="group" aria-label="Evidence shown" className="mt-3 inline-flex max-w-full rounded-lg border border-[#25334B] bg-[#070D1A] p-0.5 text-[12.5px]">
        {(
          [
            ["reported", "Agent report only"],
            ["observed", "With Underwatch"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => switchMode(m)}
            className={`rounded-[6px] px-2.5 py-1.5 transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#75A9FF] sm:px-3 ${
              mode === m ? "bg-[#142036] text-[#EEF2FA] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]" : "text-[#A2AEC3] hover:text-[#EEF2FA]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-[#A2AEC3]">{MODE_LINE[mode]}</p>

      <svg viewBox="-220 -205 440 410" aria-hidden="true" className="mx-auto mt-2 block h-auto w-full max-w-[440px]">
        <defs>
          <radialGradient id={`${uid}-glow`}>
            <stop offset="0%" stopColor="#4169E1" stopOpacity="0.2" />
            <stop offset="60%" stopColor="#4169E1" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#4169E1" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${uid}-sweep`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#75A9FF" stopOpacity="0" />
            <stop offset="100%" stopColor="#75A9FF" stopOpacity="0.16" />
          </linearGradient>
        </defs>

        <circle r={RINGS[RINGS.length - 1]} fill={`url(#${uid}-glow)`} />
        {RINGS.map((r, i) => (
          <circle key={r} r={r} fill="none" stroke="#25334B" strokeWidth={1} opacity={0.9 - i * 0.15} />
        ))}
        <g stroke="#25334B" strokeWidth={0.75} opacity={0.6}>
          <line x1={-195} y1={0} x2={195} y2={0} />
          <line x1={0} y1={-195} x2={0} y2={195} />
        </g>

        {/* One-time sweep: a faint wedge that turns once and fades. */}
        <g opacity={0}>
          <path d={`M0 0L${sweepEdge} ${-sweepRise}A${SWEEP_R} ${SWEEP_R} 0 0 1 ${sweepEdge} ${sweepRise}Z`} fill={`url(#${uid}-sweep)`} />
          <animateTransform ref={sweepRotate} attributeName="transform" type="rotate" from="-90 0 0" to="270 0 0" dur="1.6s" begin="indefinite" fill="freeze" />
          <animate ref={sweepFade} attributeName="opacity" values="0;1;1;0" keyTimes="0;0.12;0.75;1" dur="1.6s" begin="indefinite" fill="freeze" />
        </g>

        {/* Lines from the observation centre to each category, plus links between related categories. */}
        {NODES.map((n) => {
          const on = lit(n);
          const hot = n.id === selected && on;
          return (
            <line
              key={`c-${n.id}`}
              x1={0}
              y1={0}
              x2={n.x}
              y2={n.y}
              stroke={hot ? n.color : on ? "#3A4C6B" : "#25334B"}
              strokeWidth={hot ? 1.4 : 1}
              strokeDasharray={n.tone === "reported" || !on ? "3 4" : undefined}
              style={{ opacity: on ? 1 : 0.45, transition: "stroke 200ms ease, opacity 200ms ease" }}
            />
          );
        })}
        {LINKS.map(([a, b]) => {
          const na = byId(a);
          const nb = byId(b);
          if (!na || !nb) return null;
          const hot = selected === a || selected === b;
          return (
            <line
              key={`${a}-${b}`}
              x1={na.x}
              y1={na.y}
              x2={nb.x}
              y2={nb.y}
              stroke={hot ? "#75A9FF" : "#2E3F5C"}
              strokeWidth={hot ? 1.2 : 0.9}
              style={{ opacity: mode === "observed" ? (hot ? 0.9 : 0.55) : 0, transition: "opacity 220ms ease, stroke 200ms ease" }}
            />
          );
        })}

        <circle r={16} fill="#070D1A" stroke="#75A9FF" strokeWidth={1.2} />
        <circle r={3.5} fill="#75A9FF" />
        <text y={32} textAnchor="middle" className="font-mono" fontSize={10.5} fill="#A2AEC3">
          Underwatch
        </text>

        {NODES.map((n) => {
          const on = lit(n);
          const isSel = n.id === selected;
          return (
            <g key={n.id} onClick={() => choose(n)} style={{ cursor: "pointer" }}>
              <circle cx={n.x} cy={n.y} r={14} fill={n.color} style={{ opacity: isSel && on ? 0.16 : 0, transition: "opacity 200ms ease" }} />
              {isSel && (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={7}
                  fill="none"
                  stroke={on ? n.color : "#6F7C93"}
                  strokeWidth={1.2}
                  style={{
                    transformBox: "fill-box",
                    transformOrigin: "center",
                    transform: pulse ? "scale(3)" : "scale(1)",
                    opacity: pulse ? 0 : 0.8,
                    transition: pulse ? "transform 700ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 700ms ease-out" : "none",
                  }}
                />
              )}
              <circle
                cx={n.x}
                cy={n.y}
                r={isSel ? 6 : 4.5}
                strokeWidth={1.2}
                strokeDasharray={on ? undefined : "2 2.5"}
                style={{
                  fill: on ? n.color : "#0D1423",
                  stroke: on ? n.color : "#3A4C6B",
                  opacity: on ? (isSel ? 1 : 0.8) : 0.7,
                  transition: "fill 200ms ease, stroke 200ms ease, opacity 200ms ease",
                }}
              />
              <text
                x={n.lx}
                y={n.ly}
                textAnchor={n.anchor}
                className="font-mono"
                fontSize={10.5}
                style={{ fill: isSel && on ? "#EEF2FA" : on ? "#A2AEC3" : "#4A5873", transition: "fill 200ms ease" }}
              >
                {n.tag}
              </text>
            </g>
          );
        })}
      </svg>

      <ul aria-label="Evidence categories" className="mt-3 flex flex-wrap gap-1.5">
        {NODES.map((n) => {
          const on = lit(n);
          const isSel = n.id === selected;
          return (
            <li key={n.id}>
              <button
                type="button"
                aria-pressed={isSel}
                onClick={() => choose(n)}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#75A9FF] ${
                  isSel
                    ? "border-[#3A5A99] bg-[#142036] text-[#EEF2FA]"
                    : on
                      ? "border-[#25334B] bg-[#070D1A] text-[#A2AEC3] hover:border-[#34476A] hover:text-[#EEF2FA]"
                      : "border-dashed border-[#25334B] bg-transparent text-[#6F7C93] hover:text-[#A2AEC3]"
                }`}
              >
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: on ? n.color : "#3A4C6B" }} />
                {n.label}
              </button>
            </li>
          );
        })}
      </ul>

      <figcaption aria-live="polite" className="mt-3 min-h-[92px] rounded-[10px] border border-[#25334B] bg-[#070D1A]/80 px-3.5 py-3">
        {current && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-medium text-[#EEF2FA]">{current.label}</span>
              <span
                className="rounded-full border px-1.5 py-px font-mono text-[10.5px]"
                style={{ color: current.color, borderColor: `${current.color}55` }}
              >
                {TONE_LABEL[current.tone]}
              </span>
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-[#A2AEC3]">
              {current.body}
              {current.id === "safeguards" && (
                <>
                  {" "}
                  It is marked <span style={{ color: VERIFIED }}>verified</span> only when the test shows it held.
                </>
              )}
            </p>
          </>
        )}
      </figcaption>
    </figure>
  );
}
