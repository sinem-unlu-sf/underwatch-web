import type { CSSProperties } from "react";

/**
 * Small decorative observation motifs for the landing page's negative space: geometric "eye flowers" on thin stems
 * that sway, blink and (for one eye per cluster) fade out and back in. Purely decorative: aria-hidden, no pointer events.
 * Motion classes (kw-sway, kw-eye-lid, kw-eye-life, kw-ch-pulse) are defined in styles.css and stop under reduced motion.
 */

type Eye = {
  x: number;
  y: number;
  /** Half-width of the eye. */
  w: number;
  rot: number;
  /** Stem control point (x) – the stem runs from (stemX, 170) up to the eye. */
  bend: number;
  stemX: number;
  pupil: string;
  blink: number;
  delay: number;
  arc?: boolean;
  life?: boolean;
};

const CLUSTERS: Record<"a" | "b" | "c", { eyes: Eye[]; nodes: { x: number; y: number; r: number; on?: boolean }[] }> = {
  a: {
    eyes: [
      { x: 46, y: 40, w: 17, rot: -8, bend: 30, stemX: 52, pupil: "#75A9FF", blink: 8.5, delay: -2.1, arc: true },
      { x: 86, y: 78, w: 12, rot: 10, bend: 96, stemX: 70, pupil: "#DCE7FF", blink: 6.2, delay: -4.4, life: true },
    ],
    nodes: [
      { x: 20, y: 96, r: 2.2, on: true },
      { x: 100, y: 34, r: 1.6 },
    ],
  },
  b: {
    eyes: [
      { x: 70, y: 34, w: 15, rot: 7, bend: 86, stemX: 60, pupil: "#DCE7FF", blink: 9.4, delay: -6.3 },
      { x: 32, y: 70, w: 11, rot: -12, bend: 22, stemX: 50, pupil: "#75A9FF", blink: 7.1, delay: -1.2, arc: true, life: true },
      { x: 92, y: 100, w: 8, rot: 4, bend: 100, stemX: 66, pupil: "#75A9FF", blink: 10.6, delay: -3.7 },
    ],
    nodes: [
      { x: 104, y: 60, r: 2, on: true },
      { x: 16, y: 40, r: 1.5 },
    ],
  },
  c: {
    eyes: [
      { x: 58, y: 46, w: 13, rot: -4, bend: 44, stemX: 60, pupil: "#75A9FF", blink: 7.8, delay: -5.2, arc: true },
      { x: 92, y: 86, w: 9, rot: 12, bend: 98, stemX: 64, pupil: "#DCE7FF", blink: 9.9, delay: -0.8, life: true },
    ],
    nodes: [{ x: 26, y: 84, r: 1.8, on: true }],
  },
};

function eyePath(w: number) {
  const h = w * 0.55;
  return `M${-w} 0Q0 ${-h * 2} ${w} 0Q0 ${h * 2} ${-w} 0Z`;
}

/** A small cluster of eye flowers. Variants differ so repeated use never looks mirrored. */
export function EyeFlowerCluster({ variant = "a", className = "" }: { variant?: "a" | "b" | "c"; className?: string }) {
  const { eyes, nodes } = CLUSTERS[variant];
  return (
    <svg viewBox="0 0 120 170" aria-hidden="true" focusable="false" className={className} fill="none" strokeLinecap="round">
      <defs>
        <linearGradient id={`kw-stem-${variant}`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#34466A" stopOpacity="0" />
          <stop offset="0.55" stopColor="#34466A" stopOpacity="1" />
        </linearGradient>
      </defs>
      {eyes.map((e, i) => {
        const h = e.w * 0.55;
        const style = { animationDuration: `${e.blink}s`, animationDelay: `${e.delay}s` } as CSSProperties;
        return (
          <g key={i} className="kw-sway kw-anim" style={{ animationDelay: `${-i * 2.3}s` }}>
            <path d={`M${e.stemX} 170Q${e.bend} ${(170 + e.y) / 2} ${e.x} ${e.y + h + 1}`} stroke={`url(#kw-stem-${variant})`} strokeWidth="1.1" />
            <g className={e.life ? "kw-eye-life kw-anim" : undefined} style={e.life ? { animationDelay: `${e.delay * 2}s` } : undefined}>
              <g transform={`translate(${e.x} ${e.y}) rotate(${e.rot})`}>
                {e.arc && <path d={`M${-e.w * 0.75} ${-h * 1.75}Q0 ${-h * 2.9} ${e.w * 0.75} ${-h * 1.75}`} stroke="#7898D0" strokeOpacity="0.7" strokeWidth="1" />}
                <g className="kw-eye-lid kw-anim" style={style}>
                  <path d={eyePath(e.w)} stroke="#DCE7FF" strokeOpacity="0.85" strokeWidth="1.2" fill="#070D1A" />
                  <circle r={h * 0.55} fill={e.pupil} className={e.pupil === "#75A9FF" ? "kw-ch-pulse kw-anim" : undefined} />
                </g>
              </g>
            </g>
          </g>
        );
      })}
      {nodes.map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r={n.r} fill={n.on ? "#75A9FF" : "#7898D0"} className={n.on ? "kw-ch-pulse kw-anim" : undefined} opacity={n.on ? 1 : 0.6} />
      ))}
    </svg>
  );
}
