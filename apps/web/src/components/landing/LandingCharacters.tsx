/**
 * Small decorative character scenes for the landing page's negative space: observing, comparing, investigating,
 * safeguarding and checking. Flat, lightly shaded vectors in the landing palette (navy bodies, steel/pale-blue highlights,
 * off-white outlines). Purely decorative (aria-hidden). Animated parts carry `kw-anim` plus one `kw-ch-*` hook class;
 * the keyframes live in styles.css.
 */

const BODY = "#24344F";
const BODY_DARK = "#1B2740";
const BODY_LIGHT = "#2E4263";
const SKIN = "#8FA3C4";
const HAIR = "#2E4263";
const LINE = "#7898D0";
const PAPER = "#DCE7FF";
const HI = "#9DBEFF";
const PANEL = "#0D1423";

type Props = { className?: string };

/** Almond "observation eye" outline centred on (cx, cy). */
function vesica(cx: number, cy: number, w: number, h: number) {
  return `M${cx - w} ${cy}Q${cx} ${cy - 2 * h} ${cx + w} ${cy}Q${cx} ${cy + 2 * h} ${cx - w} ${cy}Z`;
}

function Shadow({ x }: { x: number }) {
  return <ellipse cx={x} cy={134} rx={22} ry={3.2} fill="#070D1A" opacity={0.9} />;
}

function Legs({ x }: { x: number }) {
  return (
    <g>
      <rect x={x - 9} y={100} width={7.5} height={32} rx={3} fill={BODY_DARK} />
      <rect x={x + 1.5} y={100} width={7.5} height={32} rx={3} fill={BODY_DARK} />
      <path d={`M${x - 11} 132.5h10M${x + 1} 132.5h10`} stroke={LINE} strokeWidth={2.2} strokeLinecap="round" />
    </g>
  );
}

function Torso({ x }: { x: number }) {
  return (
    <g>
      <path d={`M${x - 12.5} 104V81q0-11 12.5-11t12.5 11v23z`} fill={BODY} />
      <path d={`M${x - 4} 70.5l4 5 4-5`} fill="none" stroke={LINE} strokeWidth={1.1} strokeLinejoin="round" />
      <path d={`M${x + 6} 74q4 2 5 8v20`} fill="none" stroke={BODY_LIGHT} strokeWidth={2} strokeLinecap="round" />
    </g>
  );
}

function Head({ x, y = 59 }: { x: number; y?: number }) {
  return (
    <g>
      <rect x={x - 2.5} y={y + 6} width={5} height={6} rx={2} fill={SKIN} />
      <circle cx={x} cy={y} r={8.5} fill={SKIN} />
      <path d={`M${x - 8.6} ${y - 0.5}q0-9.5 8.6-9.5t8.6 9q-4-4.5-9-4.5t-8.2 5z`} fill={HAIR} />
    </g>
  );
}

function Arm({ d }: { d: string }) {
  return <path d={d} fill="none" stroke={BODY} strokeWidth={5.5} strokeLinecap="round" strokeLinejoin="round" />;
}

function Hand({ cx, cy }: { cx: number; cy: number }) {
  return <circle cx={cx} cy={cy} r={2.9} fill={SKIN} />;
}

/** A figure looking through binoculars at a small observation eye. */
export function ObserverCharacter({ className = "" }: Props) {
  return (
    <svg viewBox="0 0 160 140" aria-hidden="true" focusable="false" className={className}>
      <Shadow x={56} />
      <path d="M78 50Q102 38 116 36" fill="none" stroke={LINE} strokeOpacity={0.45} strokeWidth={1} strokeDasharray="2 3" />
      <g className="kw-anim kw-ch-blink">
        <path d={vesica(130, 33, 13, 6)} fill={PANEL} stroke={PAPER} strokeWidth={1.3} />
        <circle cx={130} cy={33} r={3} fill={HI} />
      </g>
      <path d="M130 46v10M126 60h8" stroke={LINE} strokeOpacity={0.5} strokeWidth={1} strokeLinecap="round" />
      <Legs x={56} />
      <Torso x={56} />
      <g className="kw-anim kw-ch-tilt">
        <Head x={56} />
        <Arm d="M48 78q-2-10 14-20" />
        <Arm d="M64 78q4-8 6-16" />
        <g transform="rotate(-24 70 55)">
          <rect x={60} y={48.5} width={16} height={6} rx={2.2} fill={BODY_LIGHT} stroke={LINE} strokeWidth={1} />
          <rect x={60} y={55.5} width={16} height={6} rx={2.2} fill={BODY_LIGHT} stroke={LINE} strokeWidth={1} />
          <rect x={75} y={48.5} width={2.6} height={6} rx={1} fill={HI} />
          <rect x={75} y={55.5} width={2.6} height={6} rx={1} fill={HI} />
        </g>
        <Hand cx={63} cy={58} />
        <Hand cx={70} cy={61} />
      </g>
    </svg>
  );
}

/** A figure between two floating panels, "reported" and "observed", with one mismatching row flagged. */
export function CompareCharacter({ className = "" }: Props) {
  const rows = [0, 1, 2];
  return (
    <svg viewBox="0 0 160 140" aria-hidden="true" focusable="false" className={className}>
      <Shadow x={80} />
      <g className="kw-anim kw-ch-float">
        <rect x={10} y={26} width={46} height={46} rx={5} fill={PANEL} stroke={PAPER} strokeOpacity={0.55} strokeWidth={1.1} />
        <text x={16} y={37} fontFamily="ui-monospace, monospace" fontSize={5.6} letterSpacing={0.4} fill="#D3A6E6" fillOpacity={0.7}>
          REPORTED
        </text>
        {rows.map((r) => (
          <rect key={r} x={16} y={44 + r * 8} width={r === 1 ? 26 : 32} height={2.6} rx={1.3} fill={LINE} fillOpacity={0.5} />
        ))}
      </g>
      <g className="kw-anim kw-ch-float">
        <rect x={104} y={20} width={46} height={46} rx={5} fill={PANEL} stroke={PAPER} strokeOpacity={0.55} strokeWidth={1.1} />
        <text x={110} y={31} fontFamily="ui-monospace, monospace" fontSize={5.6} letterSpacing={0.4} fill="#67B7E3" fillOpacity={0.75}>
          OBSERVED
        </text>
        {rows.map((r) => (
          <rect key={r} x={110} y={38 + r * 8} width={r === 1 ? 20 : 32} height={2.6} rx={1.3} fill={LINE} fillOpacity={0.5} />
        ))}
        <path d="M134 47.5l2.4 2.4 4.6-5" fill="none" stroke="#F0B85A" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <Legs x={80} />
      <Torso x={80} />
      <Head x={80} />
      <Arm d="M70 78q-6 10-4 22" />
      <Arm d="M90 78q8-4 14-14" />
      <Hand cx={66} cy={101} />
      <Hand cx={104} cy={63} />
    </svg>
  );
}

/** A figure holding a magnifier over a small evidence-graph fragment. */
export function InvestigateCharacter({ className = "" }: Props) {
  const nodes = [
    { x: 104, y: 60 },
    { x: 122, y: 48 },
    { x: 140, y: 64 },
    { x: 126, y: 84 },
    { x: 106, y: 94 },
  ];
  const edges: [number, number][] = [
    [0, 1],
    [1, 2],
    [0, 3],
    [3, 2],
    [3, 4],
  ];
  return (
    <svg viewBox="0 0 160 140" aria-hidden="true" focusable="false" className={className}>
      <Shadow x={50} />
      {edges.map(([a, b]) => {
        const p = nodes[a];
        const q = nodes[b];
        if (!p || !q) return null;
        return <line key={`${a}-${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={LINE} strokeOpacity={0.55} strokeWidth={1} />;
      })}
      {nodes.map((n, i) =>
        i === 3 ? null : <circle key={i} cx={n.x} cy={n.y} r={3.2} fill={PANEL} stroke={PAPER} strokeOpacity={0.8} strokeWidth={1.1} />,
      )}
      <g className="kw-anim kw-ch-pulse">
        <circle cx={126} cy={84} r={7} fill={HI} fillOpacity={0.12} />
        <circle cx={126} cy={84} r={3.6} fill={HI} />
      </g>
      <Legs x={50} />
      <Torso x={50} />
      <Head x={50} />
      <Arm d="M42 78q-4 10-2 22" />
      <Hand cx={40} cy={101} />
      <g className="kw-anim kw-ch-arm">
        <Arm d="M58 78q10 2 22 0" />
        <Hand cx={81} cy={77.5} />
        <path d="M83 77l12-6" stroke={BODY_LIGHT} strokeWidth={3.4} strokeLinecap="round" />
        <circle cx={104} cy={66} r={12} fill={HI} fillOpacity={0.08} stroke={PAPER} strokeWidth={1.6} />
        <path d="M97 60.5a8 8 0 0 1 6-3.5" fill="none" stroke={PAPER} strokeOpacity={0.6} strokeWidth={1} strokeLinecap="round" />
      </g>
    </svg>
  );
}

/** A figure placing a checkmark onto a small shield. */
export function SafeguardCharacter({ className = "" }: Props) {
  return (
    <svg viewBox="0 0 160 140" aria-hidden="true" focusable="false" className={className}>
      <Shadow x={54} />
      <path d="M116 38l22 8v18c0 15-9.5 25-22 30-12.5-5-22-15-22-30V46z" fill={PANEL} stroke={PAPER} strokeOpacity={0.8} strokeWidth={1.4} strokeLinejoin="round" />
      <path d="M116 44.5l16 5.8v13.5c0 11-6.8 18.5-16 22.3" fill="none" stroke={LINE} strokeOpacity={0.35} strokeWidth={1} />
      <path
        className="kw-anim kw-ch-check"
        pathLength={1}
        d="M106 65l7 7 13-14"
        fill="none"
        stroke="#47C9A5"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Legs x={54} />
      <Torso x={54} />
      <Head x={54} />
      <Arm d="M46 78q-4 10-2 22" />
      <Hand cx={44} cy={101} />
      <g className="kw-anim kw-ch-arm">
        <Arm d="M62 78q12-2 26-10" />
        <Hand cx={89} cy={67.5} />
      </g>
    </svg>
  );
}

/** A figure holding a clipboard checklist: two rows checked, one still open. */
export function ChecklistCharacter({ className = "" }: Props) {
  return (
    <svg viewBox="0 0 160 140" aria-hidden="true" focusable="false" className={className}>
      <Shadow x={66} />
      <Legs x={66} />
      <Torso x={66} />
      <Head x={66} />
      <Arm d="M58 78q-4 10-2 22" />
      <Hand cx={56} cy={101} />
      <g className="kw-anim kw-ch-arm">
        <Arm d="M74 78q8 8 14 8" />
        <rect x={82} y={60} width={40} height={50} rx={4} fill={PANEL} stroke={PAPER} strokeOpacity={0.75} strokeWidth={1.2} />
        <rect x={95} y={57} width={14} height={6} rx={2} fill={BODY_LIGHT} stroke={LINE} strokeWidth={1} />
        <rect x={88} y={70} width={6} height={6} rx={1.4} fill="none" stroke={LINE} strokeWidth={1} />
        <path d="M89 73l1.8 1.8 3.4-3.6" fill="none" stroke={HI} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
        <rect x={98} y={72} width={18} height={2.4} rx={1.2} fill={LINE} fillOpacity={0.55} />
        <rect x={88} y={83} width={6} height={6} rx={1.4} fill="none" stroke={LINE} strokeWidth={1} />
        <path
          className="kw-anim kw-ch-check"
          pathLength={1}
          d="M89 86l1.8 1.8 3.4-3.6"
          fill="none"
          stroke={HI}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x={98} y={85} width={14} height={2.4} rx={1.2} fill={LINE} fillOpacity={0.55} />
        <rect x={88} y={96} width={6} height={6} rx={1.4} fill="none" stroke={LINE} strokeOpacity={0.6} strokeWidth={1} />
        <rect x={98} y={98} width={16} height={2.4} rx={1.2} fill={LINE} fillOpacity={0.3} />
        <Hand cx={86} cy={86} />
      </g>
    </svg>
  );
}
