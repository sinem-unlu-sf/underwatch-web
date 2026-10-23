import type { CSSProperties } from "react";

/**
 * Decorative "eye garden" framing the beta sign-up: thin stems rise from the bottom edge to abstract vesica eyes and
 * small observation nodes. Each eye blinks on its own cycle (a real lid squeeze via scaleY around the eye centre); a few
 * also fade in from a point and away again, and some nodes pulse softly. Static under prefers-reduced-motion.
 */

type Eye = {
  x: number;
  y: number;
  w: number;
  rot: number;
  bright: boolean;
  bluePupil: boolean;
  radar?: boolean;
  bend: number;
  stemX: number;
  blink: [number, number];
  life?: [number, number];
};
type Node = { x: number; y: number; r: number; blue: boolean; pulse: [number, number] };

const LEFT_EYES: Eye[] = [
  { x: 70, y: 210, w: 40, rot: -8, bright: true, bluePupil: true, radar: true, bend: 28, stemX: 48, blink: [7.2, -1.3] },
  { x: 190, y: 330, w: 30, rot: 6, bright: false, bluePupil: false, bend: -24, stemX: 214, blink: [9.5, -4] },
  { x: 40, y: 400, w: 22, rot: 10, bright: true, bluePupil: true, bend: 18, stemX: 22, blink: [6.1, -2.2], life: [16, -3] },
  { x: 270, y: 150, w: 24, rot: -12, bright: false, bluePupil: true, bend: -36, stemX: 300, blink: [10.4, -6], life: [18, -9] },
  { x: 130, y: 470, w: 34, rot: -4, bright: true, bluePupil: false, radar: true, bend: 22, stemX: 112, blink: [8.3, -0.5] },
  { x: 300, y: 420, w: 18, rot: 12, bright: false, bluePupil: true, bend: -14, stemX: 318, blink: [5.6, -3.1] },
  { x: 95, y: 90, w: 20, rot: 4, bright: false, bluePupil: false, bend: 34, stemX: 150, blink: [11, -7], life: [20, -12] },
];
const LEFT_NODES: Node[] = [
  { x: 220, y: 250, r: 2.5, blue: true, pulse: [4.6, -1] },
  { x: 160, y: 180, r: 2, blue: false, pulse: [6.2, -3] },
  { x: 240, y: 520, r: 3, blue: true, pulse: [5.4, -2.4] },
  { x: 30, y: 300, r: 2, blue: false, pulse: [7.1, -4.2] },
  { x: 330, y: 300, r: 2.2, blue: true, pulse: [6.6, -0.6] },
];

const RIGHT_EYES: Eye[] = [
  { x: 290, y: 190, w: 42, rot: 9, bright: true, bluePupil: true, radar: true, bend: -30, stemX: 316, blink: [8.8, -2.6] },
  { x: 170, y: 300, w: 26, rot: -7, bright: false, bluePupil: false, bend: 26, stemX: 140, blink: [6.4, -0.9], life: [17, -5] },
  { x: 320, y: 380, w: 24, rot: -10, bright: true, bluePupil: false, bend: -16, stemX: 340, blink: [10.1, -5.5] },
  { x: 90, y: 170, w: 20, rot: 11, bright: false, bluePupil: true, bend: 32, stemX: 60, blink: [7.7, -3.7], life: [15, -10] },
  { x: 230, y: 460, w: 36, rot: 3, bright: true, bluePupil: true, radar: true, bend: -20, stemX: 250, blink: [9.2, -6.8] },
  { x: 60, y: 420, w: 18, rot: -5, bright: false, bluePupil: false, bend: 14, stemX: 40, blink: [5.3, -1.8] },
  { x: 250, y: 80, w: 22, rot: -3, bright: false, bluePupil: true, bend: -38, stemX: 200, blink: [11.3, -8.2] },
];
const RIGHT_NODES: Node[] = [
  { x: 130, y: 230, r: 2, blue: false, pulse: [5.8, -2] },
  { x: 330, y: 280, r: 2.5, blue: true, pulse: [4.9, -3.4] },
  { x: 110, y: 520, r: 3, blue: true, pulse: [6.3, -1.1] },
  { x: 200, y: 140, r: 2, blue: false, pulse: [7.4, -5] },
  { x: 300, y: 560, r: 2.2, blue: true, pulse: [5.1, -0.3] },
];

const STYLE = `
.kw-eg-life, .kw-eg-blink { transform-box: fill-box; transform-origin: center; }
.kw-eg-blink { animation: kw-eg-blink var(--dur) ease-in-out var(--delay) infinite; }
.kw-eg-life { animation: kw-eg-life var(--ldur) ease-in-out var(--ldelay) infinite; }
.kw-eg-node { animation: kw-eg-node var(--ndur) ease-in-out var(--ndelay) infinite; }
@keyframes kw-eg-blink { 0%, 94% { transform: scaleY(1); } 96.5% { transform: scaleY(0.06); } 100% { transform: scaleY(1); } }
@keyframes kw-eg-life {
  0%, 3% { opacity: 0; transform: scale(0.2); }
  8%, 72% { opacity: 1; transform: scale(1); }
  77%, 100% { opacity: 0; transform: scale(0.2); }
}
@keyframes kw-eg-node { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .kw-eg-blink, .kw-eg-life, .kw-eg-node { animation: none !important; } }
`;

const vars = (v: Record<string, string>) => v as CSSProperties;

/** Vesica outline of half-width w (two circular arcs meeting at pointed corners). */
function vesica(w: number) {
  const h = w * 0.52;
  const r = (w * w + h * h) / (2 * h);
  return `M${-w} 0A${r} ${r} 0 0 1 ${w} 0A${r} ${r} 0 0 1 ${-w} 0Z`;
}

function GardenEye({ eye }: { eye: Eye }) {
  const h = eye.w * 0.52;
  const stroke = eye.bright ? "#DCE7FF" : "#7898D0";
  const body = (
    <g className="kw-eg-blink" style={vars({ "--dur": `${eye.blink[0]}s`, "--delay": `${eye.blink[1]}s` })}>
      <path d={vesica(eye.w)} fill="#070D1A" fillOpacity="0.6" stroke={stroke} strokeWidth="1.3" />
      <circle r={Math.max(2.2, eye.w * 0.16)} fill={eye.bluePupil ? "#75A9FF" : "#DCE7FF"} />
    </g>
  );
  const radar = eye.radar && (
    <path
      d={`M${-eye.w * 0.7} ${-h * 1.55}Q0 ${-h * 2.7} ${eye.w * 0.7} ${-h * 1.55}`}
      fill="none"
      stroke="#7898D0"
      strokeOpacity="0.7"
      strokeWidth="1.1"
      strokeLinecap="round"
    />
  );
  return (
    <g transform={`translate(${eye.x} ${eye.y}) rotate(${eye.rot})`}>
      {eye.life ? (
        <g className="kw-eg-life" style={vars({ "--ldur": `${eye.life[0]}s`, "--ldelay": `${eye.life[1]}s` })}>
          {radar}
          {body}
        </g>
      ) : (
        <>
          {radar}
          {body}
        </>
      )}
    </g>
  );
}

export function EyeGarden({ side }: { side: "left" | "right" }) {
  const eyes = side === "left" ? LEFT_EYES : RIGHT_EYES;
  const nodes = side === "left" ? LEFT_NODES : RIGHT_NODES;
  const stemId = `kw-eg-stem-${side}`;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none"
      viewBox="0 0 360 640"
      preserveAspectRatio={side === "left" ? "xMinYMax meet" : "xMaxYMax meet"}
      width="100%"
      height="100%"
    >
      <style>{STYLE}</style>
      <defs>
        <linearGradient id={stemId} gradientUnits="userSpaceOnUse" x1="0" y1="640" x2="0" y2="120">
          <stop offset="0" stopColor="#34466A" stopOpacity="0" />
          <stop offset="0.45" stopColor="#34466A" stopOpacity="0.9" />
          <stop offset="1" stopColor="#34466A" stopOpacity="1" />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#${stemId})`} strokeWidth="1.2" strokeLinecap="round">
        {eyes.map((e, i) => {
          const top = e.y + e.w * 0.52 + 3;
          const span = 640 - top;
          return <path key={i} d={`M${e.stemX} 640C${e.stemX} ${640 - span * 0.4} ${e.x + e.bend} ${top + span * 0.45} ${e.x} ${top}`} />;
        })}
      </g>
      {nodes.map((n, i) => (
        <circle
          key={i}
          className="kw-eg-node"
          cx={n.x}
          cy={n.y}
          r={n.r}
          fill={n.blue ? "#75A9FF" : "#7898D0"}
          style={vars({ "--ndur": `${n.pulse[0]}s`, "--ndelay": `${n.pulse[1]}s` })}
        />
      ))}
      {eyes.map((e, i) => (
        <GardenEye key={i} eye={e} />
      ))}
    </svg>
  );
}
