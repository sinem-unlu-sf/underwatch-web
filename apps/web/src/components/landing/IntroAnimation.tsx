import { useEffect, useId, useRef } from "react";

/**
 * First-visit intro for the landing page. Seven circles draw in, each blinks a white light, they spiral together into the
 * Seed of Life, and the seed folds into an eye: two of its circles become the eyelids (their overlap is the eye's vesica)
 * and their outer arcs relax into the brows, the centre circle narrows into the pupil, then rays and sparkles appear.
 * Plays once per browser session (add ?intro to the URL to replay it) and never under prefers-reduced-motion.
 *
 * Everything is drawn from one timeline in a requestAnimationFrame loop, in units of the seed circle radius (`u` px each).
 */

const SEEN_KEY = "uw-intro-seen";

export function shouldPlayIntro(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if (new URLSearchParams(window.location.search).has("intro")) return true;
  try {
    return window.sessionStorage.getItem(SEEN_KEY) !== "1";
  } catch {
    return true;
  }
}

/** Timeline, in ms from mount. */
const T = {
  draw: 150,
  drawStagger: 85,
  drawDur: 650,
  blink: 1150,
  blinkStagger: 115,
  blinkDur: 560,
  converge: 2150,
  convergeDur: 1550,
  morph: 3950,
  eye: 5000,
  exit: 7050,
  exitDur: 750,
  skipDur: 320,
};

const TAU = Math.PI * 2;
const deg = (d: number) => (d * Math.PI) / 180;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const seg = (t: number, start: number, dur: number) => clamp01((t - start) / dur);
const inOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const outCubic = (p: number) => 1 - Math.pow(1 - p, 3);
const outBack = (p: number) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// Spread layout (from the reference frame): a horizontally stretched hexagon around the centre circle.
// Order: top, upper-right, lower-right, bottom, lower-left, upper-left; the centre circle is index 6.
// `seed` is its angle in the Seed of Life (reached from the spread by a short clockwise spiral); `fold` is where it folds
// to for the eye: the upper three onto the top eyelid circle, the lower three onto the bottom one.
const OUTER = [
  { x: 0, y: -4.05, seed: -60, fold: -90 },
  { x: 5.7, y: -2.4, seed: 0, fold: 90 },
  { x: 5.7, y: 2.4, seed: 60, fold: 90 },
  { x: 0, y: 4.05, seed: 120, fold: 90 },
  { x: -5.7, y: 2.4, seed: 180, fold: 270 },
  { x: -5.7, y: -2.4, seed: 240, fold: 270 },
].map((p) => {
  const a0 = Math.atan2(p.y, p.x);
  return { a0, d0: Math.hypot(p.x, p.y), seed: deg(p.seed), spiral: wrapAngle(deg(p.seed) - a0), fold: deg(p.fold) };
});
const TOP = 5;
const BOTTOM = 2;

// Eye: the vesica of two circles of radius R whose centres sit D above and below the middle.
const R = 2.4;
const D = 0.495 * R;
const LID_W = Math.sqrt(R * R - D * D);
const LID_H = R - D;
const ALPHA = Math.atan2(D, LID_W);
const BROW_R = 1.83 * LID_H;
const BROW_C = 0.36 * LID_H;
const BROW_HALF = 0.99;
const PUPIL_RHO = 0.47 * R;
const PUPIL_E = 0.43 * PUPIL_RHO;
const PUPIL_DOT = { y: -0.29, r: 0.11 };

/** Iris rays from just outside the pupil towards the eyelids, alternating long and short. */
const RAYS = Array.from({ length: 36 }, (_, i) => {
  const a = ((i + 0.5) / 36) * TAU;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const pupil = -PUPIL_E * Math.abs(c) + Math.sqrt(PUPIL_E * PUPIL_E * c * c + PUPIL_RHO * PUPIL_RHO - PUPIL_E * PUPIL_E);
  const lid = -D * Math.abs(s) + Math.sqrt(D * D * s * s + R * R - D * D);
  return { c, s, from: pupil + 0.16, to: lid - (i % 2 ? 0.36 : 0.15) };
}).filter((r) => r.to - r.from > 0.12);

const SPARKLES = [
  { x: 0, y: -2.2, s: 0.3 },
  { x: 2.4, y: 0.3, s: 0.17 },
  { x: 1.95, y: 0.95, s: 0.27 },
  { x: -2.45, y: 0.45, s: 0.17 },
  { x: -2.05, y: 1.0, s: 0.27 },
].map((p) => ({ x: p.x * LID_H, y: p.y * LID_H, s: p.s * LID_H }));
const DOTS = [
  { x: -2.25 * LID_H, y: -0.15 * LID_H },
  { x: 1.85 * LID_H, y: -0.2 * LID_H },
];
const SPARKLE_PATH = "M0 -1Q0.14 -0.14 1 0Q0.14 0.14 0 1Q-0.14 0.14 -1 0Q-0.14 -0.14 0 -1Z";

const f = (n: number) => n.toFixed(2);

/** Full circle starting at 12 o'clock, so the draw-in begins at the top. */
function circlePath(cx: number, cy: number, r: number) {
  return `M${f(cx)} ${f(cy - r)}A${f(r)} ${f(r)} 0 1 1 ${f(cx)} ${f(cy + r)}A${f(r)} ${f(r)} 0 1 1 ${f(cx)} ${f(cy - r)}`;
}

/** Clockwise arc from angle a0 to a1. */
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  const span = Math.min(a1 - a0, TAU - 1e-3);
  const end = a0 + span;
  return `M${f(cx + r * Math.cos(a0))} ${f(cy + r * Math.sin(a0))}A${f(r)} ${f(r)} 0 ${span > Math.PI ? 1 : 0} 1 ${f(cx + r * Math.cos(end))} ${f(cy + r * Math.sin(end))}`;
}

/** Vesica of two circles of radius rho whose centres are e either side of the middle (a plain circle when e = 0). */
function lensPath(rho: number, e: number, vertical: boolean) {
  const half = Math.sqrt(Math.max(0, rho * rho - e * e));
  const [x0, y0, x1, y1] = vertical ? [0, -half, 0, half] : [-half, 0, half, 0];
  return `M${f(x0)} ${f(y0)}A${f(rho)} ${f(rho)} 0 0 1 ${f(x1)} ${f(y1)}A${f(rho)} ${f(rho)} 0 0 1 ${f(x0)} ${f(y0)}`;
}

export function IntroAnimation({ onDone }: { onDone: () => void }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const overlayRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const ringRefs = useRef<(SVGPathElement | null)[]>([]);
  const lightRefs = useRef<(SVGCircleElement | null)[]>([]);
  const rayRefs = useRef<(SVGLineElement | null)[]>([]);
  const sparkleRefs = useRef<(SVGPathElement | null)[]>([]);
  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);
  const lidUpperRef = useRef<SVGPathElement>(null);
  const lidLowerRef = useRef<SVGPathElement>(null);
  const browUpperRef = useRef<SVGPathElement>(null);
  const browLowerRef = useRef<SVGPathElement>(null);
  const irisRef = useRef<SVGPathElement>(null);
  const sparkRef = useRef<SVGCircleElement>(null);
  const pupilDotRef = useRef<SVGCircleElement>(null);
  const onDoneRef = useRef(onDone);
  const skipRef = useRef(() => {});

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Storage unavailable (private mode): the intro simply plays again next time.
    }
    const overlay = overlayRef.current;
    const halo = haloRef.current;
    const svg = svgRef.current;
    const lidUpper = lidUpperRef.current;
    const lidLower = lidLowerRef.current;
    const browUpper = browUpperRef.current;
    const browLower = browLowerRef.current;
    const iris = irisRef.current;
    const spark = sparkRef.current;
    const pupilDot = pupilDotRef.current;
    if (!overlay || !halo || !svg || !lidUpper || !lidLower || !browUpper || !browLower || !iris || !spark || !pupilDot) return;

    let w = 0;
    let h = 0;
    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      svg.setAttribute("viewBox", `${-w / 2} ${-h / 2} ${w} ${h}`);
    };
    resize();
    window.addEventListener("resize", resize);

    const show = (el: SVGElement, on: boolean) => {
      el.style.display = on ? "" : "none";
    };

    const draw = (t: number, skipAt: number) => {
      const uSpread = Math.min(56, (w * 0.92) / 13.5, (h * 0.84) / 10.2);
      const uEye = Math.min(74, (w * 0.86) / 6.8, (h * 0.78) / 6.2);
      const u = lerp(uSpread, uEye, inOut(seg(t, T.morph, 2000)));

      const converge = inOut(seg(t, T.converge, T.convergeDur));
      const foldAngle = inOut(seg(t, T.morph, 800));
      const foldSize = inOut(seg(t, T.morph + 200, 850));
      const foldFade = 1 - seg(t, T.morph + 450, 450);
      const split = t >= T.eye;
      const pupil = inOut(seg(t, T.eye + 100, 900));

      for (let k = 0; k < 7; k++) {
        const ring = ringRefs.current[k];
        const light = lightRefs.current[k];
        if (!ring || !light) continue;
        let x = 0;
        let y = 0;
        let rad = 1;
        let opacity = 1;
        const p = OUTER[k];
        if (p) {
          let a: number;
          let d: number;
          if (t < T.morph) {
            a = p.a0 + p.spiral * converge;
            d = lerp(p.d0, 1, converge);
          } else {
            a = lerp(p.seed, p.fold, foldAngle);
            d = lerp(1, D, foldSize);
            rad = lerp(1, R, foldSize);
            if (k !== TOP && k !== BOTTOM) opacity = foldFade;
          }
          x = d * Math.cos(a);
          y = d * Math.sin(a);
          ring.setAttribute("d", circlePath(x * u, y * u, rad * u));
          show(ring, opacity > 0 && !(split && (k === TOP || k === BOTTOM)));
        } else {
          // The centre circle narrows into the pupil.
          ring.setAttribute("d", lensPath(lerp(1, PUPIL_RHO, pupil) * u, lerp(0, PUPIL_E, pupil) * u, true));
        }

        const drawn = inOut(seg(t, T.draw + k * T.drawStagger, T.drawDur));
        if (drawn < 1) {
          const len = TAU * rad * u + 4;
          ring.setAttribute("stroke-dasharray", `${f(len)} ${f(len)}`);
          ring.setAttribute("stroke-dashoffset", f(len * (1 - drawn)));
        } else {
          ring.removeAttribute("stroke-dasharray");
          ring.removeAttribute("stroke-dashoffset");
        }

        // Blink: a quick white light that swells inside the circle and fades.
        const pb = seg(t, T.blink + k * T.blinkStagger, T.blinkDur);
        const blink = pb <= 0 || pb >= 1 ? 0 : pb < 0.2 ? outCubic(pb / 0.2) : 1 - inOut((pb - 0.2) / 0.8);
        ring.style.opacity = f(opacity * (0.82 + 0.18 * blink));
        ring.setAttribute("stroke-width", f(2 + 0.8 * blink));
        show(light, blink > 0);
        if (blink > 0) {
          light.setAttribute("cx", f(x * u));
          light.setAttribute("cy", f(y * u));
          light.setAttribute("r", f(rad * u * 0.94 * (0.7 + 0.3 * outCubic(Math.min(1, pb / 0.35)))));
          light.style.opacity = f(blink);
        }
      }

      // Glowing point where the seed's circles meet; it hands over to the pupil dot.
      const sparkOn = seg(t, T.converge + 1100, 500) * (1 - seg(t, T.eye + 300, 500));
      show(spark, sparkOn > 0);
      spark.setAttribute("r", f(0.6 * u * (1 + 0.08 * Math.sin(t / 220))));
      spark.style.opacity = f(sparkOn);

      // Eyelids and brows: the two remaining circles split into their inner (lid) and outer (brow) arcs.
      for (const el of [lidUpper, lidLower, browUpper, browLower]) show(el, split);
      if (split) {
        const brow = inOut(seg(t, T.eye, 1000));
        lidUpper.setAttribute("d", arcPath(0, D * u, R * u, ALPHA - Math.PI, -ALPHA));
        lidLower.setAttribute("d", arcPath(0, -D * u, R * u, ALPHA, Math.PI - ALPHA));
        const r = lerp(R, BROW_R, brow) * u;
        const half = lerp(Math.PI / 2 + ALPHA, BROW_HALF, brow);
        browUpper.setAttribute("d", arcPath(0, lerp(-D, BROW_C, brow) * u, r, -Math.PI / 2 - half, -Math.PI / 2 + half));
        browLower.setAttribute("d", arcPath(0, lerp(D, -BROW_C, brow) * u, r, Math.PI / 2 - half, Math.PI / 2 + half));
        const sw = f(lerp(2, 2.8, brow));
        browUpper.setAttribute("stroke-width", sw);
        browLower.setAttribute("stroke-width", sw);
      }

      const irisOn = seg(t, T.eye + 200, 800);
      show(iris, irisOn > 0);
      iris.setAttribute("d", lensPath(R * u, D * u, false));
      iris.style.opacity = f(irisOn);

      RAYS.forEach((ray, i) => {
        const el = rayRefs.current[i];
        if (!el) return;
        const p = outCubic(seg(t, T.eye + 380 + i * 14, 450));
        show(el, p > 0);
        if (p <= 0) return;
        const to = lerp(ray.from, ray.to, p);
        el.setAttribute("x1", f(ray.c * ray.from * u));
        el.setAttribute("y1", f(ray.s * ray.from * u));
        el.setAttribute("x2", f(ray.c * to * u));
        el.setAttribute("y2", f(ray.s * to * u));
      });

      const dot = seg(t, T.eye + 650, 450);
      show(pupilDot, dot > 0);
      pupilDot.setAttribute("cy", f(PUPIL_DOT.y * u));
      pupilDot.setAttribute("r", f(PUPIL_DOT.r * u * outBack(dot)));

      SPARKLES.forEach((s, j) => {
        const el = sparkleRefs.current[j];
        if (!el) return;
        const p = seg(t, T.eye + 750 + j * 110, 520);
        show(el, p > 0);
        if (p <= 0) return;
        const twinkle = p >= 1 ? 1 + 0.12 * Math.sin((t - T.eye) / 170 + j * 1.7) : 1;
        const rot = -60 * (1 - outCubic(p));
        el.setAttribute("transform", `translate(${f(s.x * u)} ${f(s.y * u)}) rotate(${f(rot)}) scale(${(s.s * u * outBack(p) * twinkle).toFixed(3)})`);
        el.style.opacity = f(Math.min(1, p * 3));
      });
      DOTS.forEach((d, j) => {
        const el = dotRefs.current[j];
        if (!el) return;
        const p = seg(t, T.eye + 900 + j * 140, 400);
        show(el, p > 0);
        el.setAttribute("cx", f(d.x * u));
        el.setAttribute("cy", f(d.y * u));
        el.setAttribute("r", f(0.07 * LID_H * u * outBack(p)));
      });

      // Soft accent glow behind the figure, and the exit: a gentle push towards the viewer while everything fades.
      const haloOn = 0.55 * seg(t, T.converge + 800, 900) + 0.35 * seg(t, T.eye, 900);
      halo.style.opacity = f(haloOn);
      halo.style.width = halo.style.height = `${f(10 * u)}px`;
      const exit = inOut(seg(t, T.exit, T.exitDur));
      overlay.style.opacity = f(1 - Math.max(exit, seg(t, skipAt, T.skipDur)));
      svg.style.transform = `scale(${(1 + 0.12 * exit).toFixed(4)})`;
    };

    let start = -1;
    let last = 0;
    let skipAt = Infinity;
    let raf = 0;
    const tick = (now: number) => {
      if (start < 0) start = now;
      last = now - start;
      draw(last, skipAt);
      if (last >= Math.min(T.exit + T.exitDur, skipAt + T.skipDur)) {
        onDoneRef.current();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    draw(0, skipAt);
    raf = requestAnimationFrame(tick);

    skipRef.current = () => {
      if (skipAt === Infinity) skipAt = last;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") skipRef.current();
    };
    window.addEventListener("keydown", onKey);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const stroke = { fill: "none", stroke: "#fff", strokeLinecap: "round" as const };

  return (
    <div ref={overlayRef} className="kw-intro fixed inset-0 z-[60] overflow-hidden bg-[#09090B]" data-testid="landing-intro">
      <div ref={haloRef} aria-hidden="true" className="kw-intro-halo" />
      <svg ref={svgRef} aria-hidden="true" className="kw-intro-svg absolute inset-0 h-full w-full">
        <defs>
          <radialGradient id={`${id}-light`}>
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="45%" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-spark`}>
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="18%" stopColor="#fff" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${id}-iris`}>
            <stop offset="0%" stopColor="#fff" stopOpacity="0.16" />
            <stop offset="55%" stopColor="#8B8CF6" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#8B8CF6" stopOpacity="0" />
          </radialGradient>
        </defs>
        <path ref={irisRef} fill={`url(#${id}-iris)`} style={{ display: "none" }} />
        {Array.from({ length: 7 }, (_, k) => (
          <circle key={k} ref={(el) => void (lightRefs.current[k] = el)} fill={`url(#${id}-light)`} style={{ display: "none" }} />
        ))}
        <g {...stroke} strokeWidth={1.6} opacity={0.72}>
          {RAYS.map((_, i) => (
            <line key={i} ref={(el) => void (rayRefs.current[i] = el)} style={{ display: "none" }} />
          ))}
        </g>
        <g {...stroke} strokeWidth={2}>
          {Array.from({ length: 7 }, (_, k) => (
            <path key={k} ref={(el) => void (ringRefs.current[k] = el)} />
          ))}
          <path ref={lidUpperRef} strokeWidth={2.4} style={{ display: "none" }} />
          <path ref={lidLowerRef} strokeWidth={2.4} style={{ display: "none" }} />
          <path ref={browUpperRef} style={{ display: "none" }} />
          <path ref={browLowerRef} style={{ display: "none" }} />
        </g>
        <circle ref={sparkRef} fill={`url(#${id}-spark)`} style={{ display: "none" }} />
        <circle ref={pupilDotRef} cx={0} fill="#fff" style={{ display: "none" }} />
        {SPARKLES.map((_, j) => (
          <path key={j} ref={(el) => void (sparkleRefs.current[j] = el)} d={SPARKLE_PATH} fill="#fff" style={{ display: "none" }} />
        ))}
        {DOTS.map((_, j) => (
          <circle key={j} ref={(el) => void (dotRefs.current[j] = el)} fill="#fff" style={{ display: "none" }} />
        ))}
      </svg>
      <button type="button" onClick={() => skipRef.current()} className="kw-intro-skip">
        Skip intro
      </button>
    </div>
  );
}
