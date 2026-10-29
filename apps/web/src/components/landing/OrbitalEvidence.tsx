import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * "Without / with Underwatch" comparison around an animated orbital evidence network (illustrative, not live data).
 *
 * The SVG is driven by one requestAnimationFrame loop writing attributes directly (no React renders per frame), with
 * independent systems: (A) two counter-moving groups of woven paths whose curvature and spacing drift per path,
 * (B) a breathing perimeter ring whose gradient travels around it, (C) evidence nodes on their own tilted elliptical
 * orbits with depth-based brightness and occasional pulses, and (D) card-driven emphasis that eases in and out.
 * The loop pauses off-screen (resuming without a jump) and draws a single static frame under reduced motion.
 */

type Cat = "claim" | "file" | "process" | "network" | "git" | "finding" | "safeguard";

const PAIRS: { without: { title: string; body: string }; with: { title: string; body: string }; cats: Cat[]; verified?: boolean }[] = [
  {
    without: { title: "The report is the record", body: "The agent's final report is the primary account of what it did." },
    with: { title: "An independent record", body: "Underwatch keeps its own record of what the agent did." },
    cats: ["file", "process", "network", "git"],
  },
  {
    without: { title: "Unexpected file activity", body: "Changes or reads the report doesn't mention can go unnoticed." },
    with: { title: "Gaps flagged", body: "What the agent said is checked against what actually happened." },
    cats: ["claim", "file", "git"],
  },
  {
    without: { title: "Activity without context", body: "Process and network activity lacks an independently assembled context." },
    with: { title: "Activity, ready to inspect", body: "Commands and network activity are ready to investigate." },
    cats: ["process", "network"],
  },
  {
    without: { title: "Manual correlation", body: "Evidence has to be pieced together by hand." },
    with: { title: "Connected evidence", body: "Linked evidence and Ask Witness answers with checked citations." },
    cats: ["finding", "claim", "file"],
  },
  {
    without: { title: "Unproven fixes", body: "A proposed fix has no demonstrated effect." },
    with: { title: "Safeguards re-tested", body: "Reviewed safeguards are tested before you rely on them." },
    cats: ["safeguard", "finding"],
    verified: true,
  },
];

const ROWS = ["lg:row-start-2", "lg:row-start-3", "lg:row-start-4", "lg:row-start-5", "lg:row-start-6"];

const TAU = Math.PI * 2;
const R = 200;
const NA = 18;
const NB = 14;
const RING_COLORS = ["#315BC4", "#578DFF", "#B1D1FF", "#737BC5", "#315BC4"];

const DOTS: { cat: Cat; a: number; b: number; tilt: number; period: number; phase: number; size: number; color: string; pulse: number }[] = [
  { cat: "claim", a: 150, b: 58, tilt: -24, period: 17, phase: 0.05, size: 4.2, color: "#D3A6E6", pulse: 9 },
  { cat: "file", a: 176, b: 70, tilt: 32, period: 12, phase: 0.31, size: 3.6, color: "#B1D1FF", pulse: 7 },
  { cat: "process", a: 122, b: 112, tilt: 0, period: 21, phase: 0.62, size: 3.2, color: "#578DFF", pulse: 11 },
  { cat: "network", a: 186, b: 46, tilt: 72, period: 15, phase: 0.18, size: 3.4, color: "#67B7E3", pulse: 8.5 },
  { cat: "git", a: 96, b: 60, tilt: -58, period: 9.5, phase: 0.77, size: 3, color: "#737BC5", pulse: 10 },
  { cat: "finding", a: 140, b: 92, tilt: 48, period: 19, phase: 0.43, size: 4, color: "#F0B85A", pulse: 12 },
  { cat: "safeguard", a: 168, b: 84, tilt: -80, period: 23, phase: 0.9, size: 3.8, color: "#47C9A5", pulse: 13 },
  { cat: "file", a: 72, b: 40, tilt: 15, period: 8, phase: 0.55, size: 2.4, color: "#B1D1FF", pulse: 9.5 },
  { cat: "process", a: 190, b: 120, tilt: -12, period: 24, phase: 0.12, size: 2.6, color: "#578DFF", pulse: 14 },
  { cat: "network", a: 110, b: 34, tilt: -36, period: 11, phase: 0.68, size: 2.6, color: "#67B7E3", pulse: 10.5 },
];

const f = (n: number) => n.toFixed(2);
const outCubic = (p: number) => 1 - Math.pow(1 - p, 3);

function OrbitalViz({ active }: { active: number | null }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const glowRef = useRef<SVGCircleElement>(null);
  const gradRef = useRef<SVGLinearGradientElement>(null);
  const aRefs = useRef<(SVGEllipseElement | null)[]>([]);
  const bRefs = useRef<(SVGCircleElement | null)[]>([]);
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);
  const pulseRefs = useRef<(SVGCircleElement | null)[]>([]);
  const activeRef = useRef<number | null>(active);
  const redrawRef = useRef<() => void>(() => {});

  useEffect(() => {
    activeRef.current = active;
    redrawRef.current();
  }, [active]);

  useEffect(() => {
    const svg = svgRef.current;
    const ring = ringRef.current;
    const glow = glowRef.current;
    const grad = gradRef.current;
    if (!svg || !ring || !glow || !grad) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let t = 7000;
    let last = -1;
    let raf = 0;
    let running = false;
    const emph = PAIRS.map(() => 0);

    const draw = (dt: number) => {
      const s = t / 1000;
      const k = reduced ? 1 : Math.min(1, dt / 320);
      PAIRS.forEach((_, i) => {
        const target = activeRef.current === i ? 1 : 0;
        emph[i] = (emph[i] ?? 0) + (target - (emph[i] ?? 0)) * k;
      });
      const any = Math.max(...emph);
      const pairOf = (n: number) => emph[n % PAIRS.length] ?? 0;

      // B. Perimeter: slow breathing radius and a gradient travelling around the ring.
      const breathe = 1 + 0.012 * Math.sin((s * TAU) / 7.5) + 0.004 * Math.sin((s * TAU) / 3.1);
      ring.setAttribute("r", f(R * breathe));
      glow.setAttribute("r", f(R * breathe));
      grad.setAttribute("gradientTransform", `rotate(${f(((s * 360) / 16) % 360)} 0.5 0.5)`);

      // A. Woven wireframe: a rosette of ellipses and a ring of offset circles, moving against each other.
      const rotA = (s * 360) / 26;
      aRefs.current.forEach((el, i) => {
        if (!el) return;
        const ry = R * (0.3 + 0.12 * Math.sin((s * TAU) / 22 + i * 0.7));
        const angle = (i * 180) / NA + rotA + 6 * Math.sin((s * TAU) / 30 + i);
        el.setAttribute("rx", f(R * 0.93 * breathe));
        el.setAttribute("ry", f(ry));
        el.setAttribute("transform", `rotate(${f(angle)})`);
        el.style.opacity = f(0.3 * (1 + any * (pairOf(i) / Math.max(any, 1e-3) > 0.5 ? 1.1 : -0.4)));
      });
      const rotB = -(s * TAU) / 34;
      bRefs.current.forEach((el, j) => {
        if (!el) return;
        const ang = (j * TAU) / NB + rotB;
        const d = R * (0.44 + 0.05 * Math.sin((s * TAU) / 18 + j * 1.3));
        el.setAttribute("cx", f(d * Math.cos(ang)));
        el.setAttribute("cy", f(d * Math.sin(ang)));
        el.setAttribute("r", f(R * (0.52 + 0.03 * Math.sin((s * TAU) / 24 + j))));
        el.style.opacity = f(0.24 * (1 + any * (pairOf(j) / Math.max(any, 1e-3) > 0.5 ? 1.2 : -0.4)));
      });

      // C. Evidence nodes: each on its own tilted elliptical orbit, brighter in front, with occasional pulses.
      const activePair = activeRef.current === null ? null : PAIRS[activeRef.current];
      DOTS.forEach((d, i) => {
        const el = dotRefs.current[i];
        const pulse = pulseRefs.current[i];
        if (!el || !pulse) return;
        const th = TAU * (s / d.period + d.phase);
        const ex = d.a * Math.cos(th);
        const ey = d.b * Math.sin(th);
        const tr = (d.tilt * Math.PI) / 180;
        const x = ex * Math.cos(tr) - ey * Math.sin(tr);
        const y = ex * Math.sin(tr) + ey * Math.cos(tr);
        const depth = (1 + Math.sin(th)) / 2;
        const related = activePair?.cats.includes(d.cat) ? 1 : 0;
        const boost = any * (related ? 1 : -0.55);
        const size = d.size * (0.75 + 0.45 * depth) * (1 + 0.6 * any * related);
        el.setAttribute("cx", f(x));
        el.setAttribute("cy", f(y));
        el.setAttribute("r", f(size));
        el.style.opacity = f(Math.min(1, Math.max(0.12, (0.35 + 0.6 * depth) * (1 + boost))));
        const pp = (((s + d.phase * d.pulse) % d.pulse) + d.pulse) % d.pulse / 1.6;
        if (pp < 1 && !reduced) {
          pulse.style.display = "";
          pulse.setAttribute("cx", f(x));
          pulse.setAttribute("cy", f(y));
          pulse.setAttribute("r", f(size + 14 * outCubic(pp)));
          pulse.style.opacity = f(0.45 * (1 - pp) * (0.5 + 0.5 * depth));
        } else {
          pulse.style.display = "none";
        }
      });
    };

    const frame = (now: number) => {
      const dt = last < 0 ? 0 : Math.min(now - last, 50);
      last = now;
      t += dt;
      draw(dt);
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (running || reduced) return;
      running = true;
      last = -1;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    redrawRef.current = () => {
      if (!running) draw(1000);
    };
    draw(1000);

    let io: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === "undefined") start();
    else {
      io = new IntersectionObserver((entries) => (entries.some((e) => e.isIntersecting) ? start() : stop()), { rootMargin: "120px" });
      io.observe(svg);
    }
    return () => {
      stop();
      io?.disconnect();
      redrawRef.current = () => {};
    };
  }, []);

  return (
    <svg ref={svgRef} viewBox="-240 -240 480 480" className="kw-orbit-svg mx-auto block aspect-square w-full max-w-[500px]" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient ref={gradRef} id="kw-orbit-ring" x1="0" y1="0" x2="1" y2="1">
          {RING_COLORS.map((c, i) => (
            <stop key={i} offset={i / (RING_COLORS.length - 1)} stopColor={c} />
          ))}
        </linearGradient>
        <radialGradient id="kw-orbit-core">
          <stop offset="0" stopColor="#DCE9FF" stopOpacity="0.55" />
          <stop offset="0.35" stopColor="#578DFF" stopOpacity="0.18" />
          <stop offset="1" stopColor="#315BC4" stopOpacity="0" />
        </radialGradient>
        <filter id="kw-orbit-blur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>
      <circle r={R * 0.34} fill="url(#kw-orbit-core)" />
      <g fill="none" stroke="#B1D1FF" strokeWidth="0.7">
        {Array.from({ length: NA }, (_, i) => (
          <ellipse key={i} ref={(el) => void (aRefs.current[i] = el)} />
        ))}
      </g>
      <g fill="none" stroke="#737BC5" strokeWidth="0.7">
        {Array.from({ length: NB }, (_, j) => (
          <circle key={j} ref={(el) => void (bRefs.current[j] = el)} />
        ))}
      </g>
      <circle ref={glowRef} fill="none" stroke="url(#kw-orbit-ring)" strokeWidth="12" opacity="0.28" filter="url(#kw-orbit-blur)" />
      <circle ref={ringRef} fill="none" stroke="url(#kw-orbit-ring)" strokeWidth="3.5" />
      <circle r="3" fill="#EEF2FA" />
      {DOTS.map((d, i) => (
        <Fragment key={i}>
          <circle ref={(el) => void (pulseRefs.current[i] = el)} fill="none" stroke={d.color} strokeWidth="1" style={{ display: "none" }} />
          <circle ref={(el) => void (dotRefs.current[i] = el)} fill={d.color} />
        </Fragment>
      ))}
    </svg>
  );
}

function Marker({ side, verified }: { side: "without" | "with"; verified?: boolean }) {
  if (side === "without") {
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="mt-0.5 shrink-0" fill="none">
        <circle cx="8" cy="8" r="6" stroke="#F0B85A" strokeOpacity="0.7" strokeWidth="1.2" strokeDasharray="2.4 2" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" className="mt-0.5 shrink-0" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.5" stroke={verified ? "#47C9A5" : "#578DFF"} strokeOpacity="0.8" strokeWidth="1.2" />
      <path d="M5.2 8.2l1.9 1.9 3.7-3.9" stroke={verified ? "#47C9A5" : "#9DBEFF"} strokeWidth="1.4" />
    </svg>
  );
}

/** The comparison grid: left "without" cards, the orbital network in the middle, right "with Underwatch" cards. */
export function OrbitalEvidence() {
  const [hovered, setHovered] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [shown, setShown] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const active = hovered ?? selected;

  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const card = (i: number, side: "without" | "with") => {
    const pair = PAIRS[i];
    if (!pair) return null;
    const c = pair[side];
    return (
      <div
        key={`${side}-${i}`}
        className={`kw-ocard-wrap flex ${side === "without" ? "lg:col-start-1" : "lg:col-start-3"} ${ROWS[i]}`}
        style={{ "--i": i + (side === "with" ? 1 : 0) } as CSSProperties}
      >
        <button
          type="button"
          aria-pressed={selected === i}
          data-active={active === i ? "true" : "false"}
          onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(i)}
          onPointerLeave={(e) => e.pointerType === "mouse" && setHovered(null)}
          onFocus={() => setHovered(i)}
          onBlur={() => setHovered(null)}
          onClick={() => setSelected((s) => (s === i ? null : i))}
          className={`kw-ocard kw-ocard-${side} flex w-full gap-3 text-left`}
        >
          <Marker side={side} verified={pair.verified} />
          <span className="min-w-0">
            <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.07em] text-text-tertiary lg:hidden">
              {side === "without" ? "Without independent observation" : "With Underwatch"}
            </span>
            <span className="kw-ocard-title block text-[14px] font-medium">{c.title}</span>
            <span className="mt-0.5 block text-[13px] leading-relaxed text-text-secondary">{c.body}</span>
          </span>
        </button>
      </div>
    );
  };

  return (
    <div
      ref={gridRef}
      data-shown={shown ? "true" : "false"}
      className="kw-orbit-grid mt-12 grid items-center gap-3 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] lg:gap-x-8"
    >
      <p className="hidden font-mono text-[11px] uppercase tracking-[0.08em] text-text-tertiary lg:col-start-1 lg:row-start-1 lg:block">Without Underwatch</p>
      <p className="hidden font-mono text-[11px] uppercase tracking-[0.08em] text-[#9DBEFF] lg:col-start-3 lg:row-start-1 lg:block">With Underwatch</p>
      <figure className="mb-6 md:col-span-2 lg:col-span-1 lg:col-start-2 lg:row-span-6 lg:row-start-1 lg:mb-0">
        <OrbitalViz active={active} />
        <figcaption className="mt-3 text-center font-mono text-[11px] text-text-tertiary">Illustrative evidence network · not live data</figcaption>
      </figure>
      {PAIRS.map((_, i) => (
        <Fragment key={i}>
          {card(i, "without")}
          {card(i, "with")}
        </Fragment>
      ))}
    </div>
  );
}
