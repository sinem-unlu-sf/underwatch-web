import { useId, type ReactNode } from "react";
import { InvestigateCharacter, ObserverCharacter, PointingCharacter, SafeguardCharacter } from "./LandingCharacters";

/**
 * Illustrated scenes beside each landing feature, in place of product screenshots: what Underwatch gives you, drawn in
 * the landing palette with the same small characters. Illustration only (no live data, no product internals). Each
 * scene is one role="img" with a plain-language label; the drawing itself is aria-hidden. Animated parts use `kw-anim`
 * so reduced motion stops them (styles.css).
 */

const PANEL = "#0D1423";
const RING = "#25334B";
const LINE = "#7898D0";
const PAPER = "#DCE7FF";
const HI = "#9DBEFF";
const OBSERVED = "#75A9FF";
const CLAIM = "#D3A6E6";
const CAUTION = "#F0B85A";
const VERIFIED = "#47C9A5";
const MUTED = "#A2AEC3";

/** Almond "observation eye" outline centred on (cx, cy). */
function vesica(cx: number, cy: number, w: number, h: number) {
  return `M${cx - w} ${cy}Q${cx} ${cy - 2 * h} ${cx + w} ${cy}Q${cx} ${cy + 2 * h} ${cx - w} ${cy}Z`;
}

function Scene({ label, figure, figureClass, children }: { label: string; figure: ReactNode; figureClass: string; children: ReactNode }) {
  return (
    <figure role="img" aria-label={label} className="kw-shot m-0">
      <div className="kw-shot-frame kw-scene relative">
        <svg viewBox="0 0 560 380" aria-hidden="true" focusable="false" className="block h-auto w-full">
          {children}
        </svg>
        <div aria-hidden="true" className={`pointer-events-none absolute ${figureClass}`}>
          {figure}
        </div>
      </div>
    </figure>
  );
}

function FileGlyph({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <path d={`M${x - 6} ${y - 8}h8l4 4v12h-12z`} fill={PANEL} stroke={PAPER} strokeWidth={1.2} strokeLinejoin="round" />
      <path d={`M${x - 3} ${y}h6M${x - 3} ${y + 3.5}h4`} stroke={LINE} strokeWidth={1} strokeLinecap="round" />
    </g>
  );
}

function CommandGlyph({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x - 10} y={y - 7.5} width={20} height={15} rx={3} fill={PANEL} stroke={PAPER} strokeWidth={1.2} />
      <path d={`M${x - 6} ${y - 2.5}l3 2.5-3 2.5M${x} ${y + 3}h5`} fill="none" stroke={HI} strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}

function NetworkGlyph({ x, y }: { x: number; y: number }) {
  return (
    <g fill="none" stroke={PAPER} strokeWidth={1.2}>
      <circle cx={x} cy={y} r={8} fill={PANEL} />
      <ellipse cx={x} cy={y} rx={3.4} ry={8} stroke={LINE} strokeWidth={1} />
      <path d={`M${x - 8} ${y}h16`} stroke={LINE} strokeWidth={1} />
    </g>
  );
}

/** Observe: a quiet sweep around the Underwatch eye picks up files, commands and network activity. */
function ObserveScene() {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const cx = 360;
  const cy = 176;
  const blips: { kind: "file" | "command" | "network"; x: number; y: number }[] = [
    { kind: "file", x: 292, y: 112 },
    { kind: "command", x: 446, y: 104 },
    { kind: "network", x: 476, y: 214 },
    { kind: "file", x: 408, y: 278 },
    { kind: "command", x: 262, y: 214 },
    { kind: "network", x: 344, y: 62 },
  ];
  return (
    <Scene
      label="Illustration: a watcher with binoculars beside a radar that picks up files, commands and network activity around one agent session."
      figureClass="bottom-[3%] left-[2%] w-[36%]"
      figure={<ObserverCharacter className="h-auto w-full" />}
    >
      <defs>
        <radialGradient id={`${uid}-glow`}>
          <stop offset="0%" stopColor="#4169E1" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#4169E1" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={170} fill={`url(#${uid}-glow)`} />
      {[52, 100, 148].map((r, i) => (
        <circle key={r} cx={cx} cy={cy} r={r} fill="none" stroke={RING} strokeWidth={1} opacity={0.95 - i * 0.2} />
      ))}
      <path d={`M${cx - 156} ${cy}h312M${cx} ${cy - 156}v312`} stroke={RING} strokeWidth={0.75} opacity={0.6} />
      <g className="kw-anim kw-scene-spin">
        <circle cx={cx} cy={cy} r={148} fill="none" />
        <path d={`M${cx} ${cy}L${cx + 148} ${cy}A148 148 0 0 0 ${cx + 121} ${cy - 85}Z`} fill={OBSERVED} fillOpacity={0.09} />
        <path d={`M${cx} ${cy}L${cx + 148} ${cy}`} stroke={OBSERVED} strokeOpacity={0.55} strokeWidth={1.2} />
      </g>
      {blips.map((b, i) => (
        <g key={i}>
          <circle className="kw-anim kw-ch-pulse" style={{ animationDelay: `${i * -0.7}s` }} cx={b.x} cy={b.y} r={17} fill={HI} fillOpacity={0.1} />
          {b.kind === "file" ? <FileGlyph x={b.x} y={b.y} /> : b.kind === "command" ? <CommandGlyph x={b.x} y={b.y} /> : <NetworkGlyph x={b.x} y={b.y} />}
        </g>
      ))}
      <g className="kw-anim kw-ch-blink">
        <path d={vesica(cx, cy, 20, 9)} fill={PANEL} stroke={PAPER} strokeWidth={1.4} />
        <circle cx={cx} cy={cy} r={4.5} fill={HI} />
      </g>
    </Scene>
  );
}

/** Compare: the agent's account next to what happened; the one row the agent left out is flagged. */
function CompareScene() {
  const said = ["Updated the config", "Ran the tests", "Finished"];
  const happened = ["Updated the config", "Ran the tests", "Opened .env", "Finished"];
  const gap = 2;
  const rowY = (i: number) => 98 + i * 34;
  const saidTo = [0, 1, 3];
  return (
    <Scene
      label="Illustration: the agent's account of its work next to what actually happened, with the one action the agent left out flagged."
      figureClass="bottom-[2%] left-1/2 w-[19%] -translate-x-1/2"
      figure={<PointingCharacter className="h-auto w-full" />}
    >
      <rect x={22} y={36} width={206} height={164} rx={10} fill={PANEL} stroke={PAPER} strokeOpacity={0.4} />
      <text x={40} y={66} fontSize={13} fontWeight={500} fill={CLAIM}>
        What the agent said
      </text>
      {said.map((t, i) => (
        <g key={t}>
          <circle cx={46} cy={rowY(i) - 4} r={3} fill={CLAIM} fillOpacity={0.75} />
          <text x={58} y={rowY(i)} fontSize={13} fill={MUTED}>
            {t}
          </text>
        </g>
      ))}

      <rect x={332} y={36} width={206} height={198} rx={10} fill={PANEL} stroke={PAPER} strokeOpacity={0.4} />
      <text x={350} y={66} fontSize={13} fontWeight={500} fill={OBSERVED}>
        What actually happened
      </text>
      {happened.map((t, i) =>
        i === gap ? (
          <g key={t}>
            <rect className="kw-anim kw-ch-pulse" x={340} y={rowY(i) - 19} width={190} height={28} rx={6} fill={CAUTION} fillOpacity={0.14} stroke={CAUTION} strokeOpacity={0.6} />
            <path d={`M${356} ${rowY(i) - 10}l5 9h-10z`} fill="none" stroke={CAUTION} strokeWidth={1.3} strokeLinejoin="round" />
            <text x={368} y={rowY(i)} fontSize={13} fontWeight={500} fill="#F6D9A6">
              {t}
            </text>
          </g>
        ) : (
          <g key={t}>
            <path d={`M${352} ${rowY(i) - 5}l2.6 2.6 5-5.4`} fill="none" stroke={OBSERVED} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
            <text x={368} y={rowY(i)} fontSize={13} fill={MUTED}>
              {t}
            </text>
          </g>
        ),
      )}

      {said.map((t, i) => {
        const to = saidTo[i] ?? i;
        return <path key={t} d={`M228 ${rowY(i) - 4}C280 ${rowY(i) - 4} 280 ${rowY(to) - 4} 332 ${rowY(to) - 4}`} fill="none" stroke={LINE} strokeOpacity={0.45} strokeDasharray="3 4" />;
      })}
      <path className="kw-anim kw-scene-trace" d={`M332 ${rowY(gap) - 4}H290`} stroke={CAUTION} strokeOpacity={0.8} strokeWidth={1.2} />
      <circle cx={286} cy={rowY(gap) - 4} r={3.5} fill="none" stroke={CAUTION} strokeWidth={1.2} />
    </Scene>
  );
}

/** Investigate: a path lights up from the finding back to the action behind it. */
function InvestigateScene() {
  const nodes = [
    { x: 470, y: 64 },
    { x: 380, y: 104 },
    { x: 500, y: 162 },
    { x: 312, y: 176 },
    { x: 420, y: 210 },
    { x: 516, y: 268 },
    { x: 350, y: 290 },
    { x: 262, y: 104 },
  ];
  const edges: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 3],
    [1, 7],
    [2, 4],
    [3, 4],
    [4, 5],
    [4, 6],
    [3, 6],
  ];
  const path = [0, 1, 3, 6];
  const onPath = (a: number, b: number) => path.some((n, i) => i > 0 && ((path[i - 1] === a && n === b) || (path[i - 1] === b && n === a)));
  const finding = nodes[0]!;
  const cause = nodes[6]!;
  return (
    <Scene
      label="Illustration: a figure with a magnifier following a highlighted path from a finding back to the action that caused it."
      figureClass="bottom-[3%] left-[1%] w-[38%]"
      figure={<InvestigateCharacter className="h-auto w-full" />}
    >
      {edges.map(([a, b]) => {
        const p = nodes[a]!;
        const q = nodes[b]!;
        return onPath(a, b) ? null : <line key={`${a}-${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={RING} strokeWidth={1.2} />;
      })}
      <polyline
        className="kw-anim kw-scene-trace"
        points={path.map((i) => `${nodes[i]!.x},${nodes[i]!.y}`).join(" ")}
        fill="none"
        stroke={OBSERVED}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      {nodes.map((n, i) =>
        i === 0 || i === 6 ? null : (
          <circle key={i} cx={n.x} cy={n.y} r={path.includes(i) ? 6 : 5} fill={PANEL} stroke={path.includes(i) ? HI : LINE} strokeOpacity={path.includes(i) ? 1 : 0.6} strokeWidth={1.3} />
        ),
      )}
      <path d={`M${finding.x} ${finding.y - 13}l13 13-13 13-13-13z`} fill={CAUTION} fillOpacity={0.9} stroke="#F6D9A6" strokeWidth={1.2} />
      <g className="kw-anim kw-ch-pulse">
        <circle cx={cause.x} cy={cause.y} r={18} fill={HI} fillOpacity={0.12} />
      </g>
      <circle cx={cause.x} cy={cause.y} r={7} fill={HI} />
    </Scene>
  );
}

/** Safeguards: a reviewed safeguard is tested, and it only counts once the test shows it held. */
function SafeguardScene() {
  const steps = ["You approved it", "Tested it", "It held"];
  return (
    <Scene
      label="Illustration: a figure placing a check on a shield, next to three steps: you approved the safeguard, it was tested, and it held."
      figureClass="bottom-[4%] left-[3%] w-[52%]"
      figure={<SafeguardCharacter className="h-auto w-full" />}
    >
      {steps.map((s, i) => {
        const y = 128 + i * 62;
        const last = i === steps.length - 1;
        return (
          <g key={s}>
            {i > 0 && <path d={`M${386} ${y - 44}v26`} stroke={RING} strokeWidth={1.2} />}
            <rect x={366} y={y - 18} width={168} height={36} rx={18} fill={PANEL} stroke={last ? VERIFIED : PAPER} strokeOpacity={last ? 0.8 : 0.35} />
            <circle cx={386} cy={y} r={9} fill={last ? VERIFIED : "none"} fillOpacity={last ? 0.18 : 0} stroke={last ? VERIFIED : HI} strokeWidth={1.3} />
            <path
              className={last ? "kw-anim kw-ch-check" : undefined}
              pathLength={1}
              d={`M${381.5} ${y}l3 3 5.5-6`}
              fill="none"
              stroke={last ? VERIFIED : HI}
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <text x={404} y={y + 4.5} fontSize={13} fontWeight={last ? 500 : 400} fill={last ? "#A8EBD7" : MUTED}>
              {s}
            </text>
          </g>
        );
      })}
    </Scene>
  );
}

const SCENES: Record<string, () => ReactNode> = {
  observe: ObserveScene,
  compare: CompareScene,
  investigate: InvestigateScene,
  safeguards: SafeguardScene,
};

export function FeatureScene({ id }: { id: string }) {
  const S = SCENES[id];
  return S ? <S /> : null;
}
