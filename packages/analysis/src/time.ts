/**
 * Clock-free ISO-8601 parsing to integer microseconds since the Unix epoch. The engine never reads a clock and never
 * uses the Date object (lint rule in the stack design), so timestamps are parsed arithmetically. Sub-microsecond digits
 * are truncated. Returns null for malformed input (caller records the event as unprocessed).
 */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

function daysFromCivil(y: number, m: number, d: number): number {
  // Howard Hinnant's days_from_civil, integer-only.
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function parseIsoMicros(ts: string): number | null {
  const m = ISO_RE.exec(ts);
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss, frac, tz] = m;
  const y = Number(ys), mo = Number(mos), d = Number(ds), h = Number(hs), mi = Number(mis), s = Number(ss);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  let offsetMin = 0;
  if (tz && tz !== "Z") {
    const sign = tz.startsWith("-") ? -1 : 1;
    offsetMin = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6)));
  }
  const micros = frac ? Number((frac + "000000").slice(0, 6)) : 0;
  const secs = daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s - offsetMin * 60;
  return secs * 1_000_000 + micros;
}

export const MS = 1000; // microseconds per millisecond
