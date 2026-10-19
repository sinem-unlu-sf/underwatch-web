import type { SVGProps } from "react";

/**
 * Minimal inline icon set (no dependency). 16px grid, 1.5px stroke, currentColor. Icons are decorative by default
 * (aria-hidden); always pair them with a text label or pass `label` to expose them to assistive tech.
 */
const PATHS = {
  check: "M3.5 8.5l3 3 6-7",
  x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  alert: "M8 2.5l6 11H2l6-11zM8 6.5v3.2M8 11.6v.1",
  alertCircle: "M8 14A6 6 0 108 2a6 6 0 000 12zM8 5v3.6M8 10.8v.1",
  question: "M8 14A6 6 0 108 2a6 6 0 000 12zM6.3 6.3a1.8 1.8 0 013.4.7c0 1.2-1.7 1.4-1.7 2.5M8 11.2v.1",
  info: "M8 14A6 6 0 108 2a6 6 0 000 12zM8 7.2V11M8 5v.1",
  circle: "M8 13.5a5.5 5.5 0 100-11 5.5 5.5 0 000 11z",
  dot: "M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
  minus: "M4 8h8",
  eye: "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z",
  quote: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2v-7z",
  derive: "M3 3v4.5a2 2 0 002 2h7M9.5 7l2.5 2.5L9.5 12",
  inferred: "M8 2.5l1.4 3.6 3.6 1.4-3.6 1.4L8 12.5l-1.4-3.6L3 7.5l3.6-1.4L8 2.5z",
  shield: "M8 1.8l5 2v4c0 3-2.2 5.3-5 6.4-2.8-1.1-5-3.4-5-6.4v-4l5-2z",
  flask: "M6 2h4M6.5 2v4L3 13h10L9.5 6V2",
  copy: "M5.5 5.5h7v8h-7zM3.5 10.5v-8h7",
  clock: "M8 14A6 6 0 108 2a6 6 0 000 12zM8 4.8V8l2.2 1.4",
  chevronLeft: "M10 3.5L5.5 8 10 12.5",
  chevronRight: "M6 3.5L10.5 8 6 12.5",
  chevronDown: "M3.5 6L8 10.5 12.5 6",
  external: "M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4",
  spinner: "M8 2a6 6 0 016 6",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  file: "M4 1.8h5l3 3v9.4H4zM9 1.8v3h3",
  search: "M7 12a5 5 0 100-10 5 5 0 000 10zM10.6 10.6l3.4 3.4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14, label, className = "", ...rest }: { name: IconName; size?: number; label?: string } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
      className={`shrink-0 ${name === "spinner" ? "kw-spin" : ""} ${className}`}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
